require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const PDFKit = require('pdfkit');
const crypto = require('crypto');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(bodyParser.json());

const processedSubmissions = new Set();
let validTokens = new Map();
const TOKENS_FILE = './tokens.json';

if (fs.existsSync(TOKENS_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    validTokens = new Map(saved.map(([key, val]) => [key, val]));
    console.log('🔐 Tokens loaded from file.');
  } catch (err) {
    console.error('❌ Failed to load tokens file:', err);
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify([...validTokens]), 'utf-8');
    console.log('💾 Tokens saved.');
  } catch (err) {
    console.error('❌ Error saving tokens:', err);
  }
}

const buildPrompt = (userInfo, allergyNote, planType, part = 1) => {
  const weeks = planType === '4 Week' ? `Weeks ${part === 1 ? '1 and 2' : '3 and 4'}` : '1 Week';
  return `You are a professional fitness and nutrition expert creating personalized PDF workout and meal plans for paying clients.

A customer has purchased the **${planType}** plan. Carefully analyze the following profile data to create a fully customized plan:

${userInfo}

The user has the following allergies/intolerances:
**${allergyNote || 'None'}**
Exclude these allergens from all recipes. Do NOT mention or reference them — just silently avoid them in all meals.

Generate the plan for ${weeks}:
${planType === '1 Week' ? `
- A complete 1-week workout plan (7 days: Monday to Sunday)
- A complete 1-week meal plan (each day includes: Breakfast, Lunch, Dinner, Snack)` : `
- A 2-week workout plan (7 days/week, with full details: Week > Day > Exercises)
- A 2-week meal plan (7 days/week, each with 4 meals + full macros)`}

FORMAT:
Day [X]:
Workout:
- Exercise Name – sets x reps, intensity or weight, form tips
Meal:
- Breakfast: Name + ingredients + macros
- Lunch: ...
- Dinner: ...
- Snack: ...

RULES:
- Plain text only
- Each day must be unique
- Include calories, protein, carbs, fats for each meal
- Clean, expert tone for PDF
  `;
};

app.post('/webhook/shopify', async (req, res) => {
  try {
    const { email, line_items: lineItems = [] } = req.body;
    if (!email || !lineItems.length) return res.status(400).send('Missing order data');

    const bought4Week = lineItems.some(item => item.title.toLowerCase().includes('4 week'));
    const planType = bought4Week ? '4 Week' : '1 Week';

    const token = crypto.randomBytes(16).toString('hex');
    validTokens.set(token, { used: false, email, planType });
    saveTokens();

    const tallyURL = `https://tally.so/r/wzRD1g?token=${token}`;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.MAIL_USER || 'bulkbotplans@gmail.com',
        pass: process.env.MAIL_PASS
      }
    });

    await transporter.sendMail({
      from: 'BulkBot AI <bulkbotplans@gmail.com>',
      to: email,
      subject: 'Your BulkBot Plan Form Link 📝',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #fff; border: 1px solid #ddd; padding: 30px; border-radius: 10px;">
          <h2 style="color: #333;">Welcome to BulkBot AI!</h2>
          <p>Thanks for ordering the <strong>${planType}</strong> plan.</p>
          <p>To receive your personalized fitness and meal plan, please fill out this form:</p>
          <a href="${tallyURL}" style="display: inline-block; padding: 10px 20px; background-color: #0066ff; color: #fff; text-decoration: none; border-radius: 5px;">Fill Out Form</a>
          <p>This link is valid for one use only.</p>
        </div>
      `
    });

    console.log(`✅ Token ${token} sent to ${email}`);
    res.status(200).send('Webhook handled');
  } catch (err) {
    console.error('❌ Error in Shopify webhook:', err);
    res.status(500).send('Server error');
  }
});

const handleWebhook = async (req, res, planType) => {
  const raw = req.body;
  const data = raw.data || raw;
  const submissionId = data.submissionId;

  const tokenField = data.fields.find(f => f.key?.toLowerCase().includes('token'));
  const token = tokenField?.value;
  const tokenMeta = token && validTokens.get(token);

  if (!tokenMeta) return res.status(401).send('Invalid token');
  if (tokenMeta.used) return res.status(409).send('Token already used');
  if (tokenMeta.planType !== planType) return res.status(400).send('Token / plan mismatch');

  if (processedSubmissions.has(submissionId)) {
    console.log(`⚠️ Duplicate submission ${submissionId} ignored`);
    return res.status(200).send("Already processed");
  }
  processedSubmissions.add(submissionId);
  setTimeout(() => processedSubmissions.delete(submissionId), 15 * 60 * 1000);

  const emailField = data.fields.find(f => f.label.toLowerCase().includes('email'));
  const nameField = data.fields.find(f => f.label.toLowerCase().includes('name'));
  const email = emailField?.value || tokenMeta.email;
  const name = nameField?.value || 'Client';

  const userInfo = data.fields.map(field => {
    const val = Array.isArray(field.value) ? field.value.join(', ') : field.value;
    if (field.options) {
      const optionMap = Object.fromEntries(field.options.map(o => [o.id, o.text]));
      const readable = Array.isArray(field.value)
        ? field.value.map(id => optionMap[id] || id).join(', ')
        : optionMap[val] || val;
      return `${field.label.trim()}: ${readable}`;
    }
    return `${field.label.trim()}: ${val}`;
  }).join('\n');

  const allergyField = data.fields.find(f => f.label.toLowerCase().includes('allergies'));
  const allergyNote = allergyField?.value || 'None';

  const getPlanChunk = async (prompt) => {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a fitness and nutrition expert.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4,
      max_tokens: 10000
    });
    return response.choices[0].message.content;
  };

  try {
    const prompt1 = buildPrompt(userInfo, allergyNote, planType, 1);
    const prompt2 = planType === '4 Week' ? buildPrompt(userInfo, allergyNote, planType, 2) : null;
    const chunk1 = await getPlanChunk(prompt1);
    const chunk2 = prompt2 ? await getPlanChunk(prompt2) : '';
    const fullPlanText = `${chunk1}\n\n---\n\n${chunk2}`.trim();

    const doc = new PDFKit();
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', async () => {
      const pdfData = Buffer.concat(buffers);

      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.MAIL_USER || 'bulkbotplans@gmail.com',
          pass: process.env.MAIL_PASS
        }
      });

      await transporter.sendMail({
        from: 'BulkBot AI <bulkbotplans@gmail.com>',
        to: email,
        subject: 'Your Personalized Workout & Meal Plan 💪',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #fff; border: 1px solid #ddd; padding: 30px; border-radius: 10px;">
            <h2 style="text-align: center; color: #333;">Your Personalized Plan Has Arrived 🎉</h2>
            <p style="text-align: center;">Thank you for choosing <strong>BulkBot AI</strong>. Your custom plan is attached below.</p>
          </div>
        `,
        attachments: [
          { filename: 'Plan.pdf', content: pdfData },
          { filename: 'logo.jpg', path: path.join(__dirname, 'assets/logo.jpg'), cid: 'logo' }
        ]
      });

      tokenMeta.used = true;
      saveTokens();

      console.log(`📤 Plan emailed to ${email}`);
      res.status(200).send('Plan emailed!');
    });

    doc.registerFont('Lora-SemiBold', path.join(__dirname, 'fonts/Lora-SemiBold.ttf'));
    doc.registerFont('BebasNeue-Regular', path.join(__dirname, 'fonts/BebasNeue-Regular.ttf'));
    doc.image(path.join(__dirname, 'assets/logo.jpg'), { width: 120, align: 'center' });
    doc.moveDown();
    doc.font('BebasNeue-Regular').fontSize(24).fillColor('#0066ff').text('Your Personalized Fitness Plan', { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).fillColor('#000').text(`Client: ${name}`, { align: 'center' });
    doc.addPage();

    doc.font('Lora-SemiBold').fontSize(14).fillColor('#000').text(fullPlanText, { align: 'left', lineGap: 4 });
    doc.end();

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).send('Plan generation failed');
  }
};

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
