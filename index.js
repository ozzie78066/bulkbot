require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const PDFKit = require('pdfkit');
const crypto = require('crypto');
const { OpenAI } = require('openai');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(bodyParser.json());


const processedSubmissions = new Set();

const fs = require('fs');

// Load token data from file if it exists
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
  return `
You are a professional fitness and nutrition expert creating personalized PDF workout and meal plans for paying clients.

A customer has purchased the **${planType}** plan. Carefully analyze the following profile data to create a fully customized plan:

${userInfo}

❗️IMPORTANT:
The user has the following allergies/intolerances:  
**${allergyNote || 'None'}**  
Exclude these allergens from all recipes. Do NOT mention or reference them — just silently avoid them in all meals.

---

✅ Generate the plan for ${weeks}:

${planType === '1 Week' ? `
- A complete 1-week workout plan (7 days: Monday to Sunday)
- A complete 1-week meal plan (each day includes: Breakfast, Lunch, Dinner, Snack)` : `
- A 2-week workout plan (7 days/week, with full details: Week > Day > Exercises)
- A 2-week meal plan (7 days/week, each with 4 meals + full macros)

❗ Write every single day out completely. NO summaries or statements like "continue similar format".
❗ Each day must include unique details. This is for a paid product.
`}

---

📄 FORMAT:
Day [X]:  
Workout:  
- Exercise Name – sets x reps, intensity or weight, form tips  
- ...  
- ...  

Meal:  
- Breakfast: Name + short recipe or ingredients + estimated macros  
- Lunch: ...  
- Dinner: ...  
- Snack: ...

---

STRICT RULES:
- NO tables, bullets, or markdown symbols
- Use clean, plain formatting
- Every meal must show estimated Calories, Protein, Carbs, and Fats
- Do NOT mention allergies — just respect them silently
- Tone: expert, motivating, supportive
- Output must be professional and clean for PDF use
`;
};

app.post('/webhook/shopify', async (req, res) => {
  try {
    const shopifyData = req.body;

    const email = shopifyData.email;
    const lineItems = shopifyData.line_items || [];

    if (!email || !lineItems.length) return res.status(400).send('Missing order data');

    const bought4Week = lineItems.some(item => item.title.toLowerCase().includes('4 week'));
    const planType = bought4Week ? '4 Week' : '1 Week';

    const token = crypto.randomBytes(16).toString('hex');
    validTokens.set(token, { used: false, email, planType });

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
      subject: 'Your BulkBot Plan Form Link',
      html: `
        <p>Hi!</p>
        <p>Thanks for your order of the <strong>${planType}</strong> plan.</p>
        <p>To get your custom AI-generated plan, please fill out this form:</p>
        <a href="${tallyURL}">${tallyURL}</a>
        <p>This link is only valid once — please don’t share it.</p>
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
  console.log("🤖 Incoming Tally submission:", JSON.stringify(req.body, null, 2));
  const raw = req.body;
  const data = raw.data || raw;
  const submissionId = data.submissionId;

  const tokenField = (data.fields || []).find(
  (f) => f.key?.toLowerCase().includes('token') && typeof f.value === 'string'
);
  const token = typeof tokenField?.value === 'string' ? tokenField.value : null;

  const tokenMeta = token && validTokens.get(token);

  if (!tokenMeta) return res.status(401).send('Invalid token');
  if (tokenMeta.used) return res.status(409).send('Token already used');
  if (tokenMeta.planType !== planType) return res.status(400).send('Token / plan mismatch');

  tokenMeta.used = true;
  saveTokens();


  if (processedSubmissions.has(submissionId)) {
    console.log(`⚠️ Duplicate submission ${submissionId} ignored`);
    return res.status(200).send("Already processed");
  }
  processedSubmissions.add(submissionId);
  setTimeout(() => processedSubmissions.delete(submissionId), 15 * 60 * 1000);

  const emailField = (data.fields || []).find(
    (f) => f.label.toLowerCase().includes('email') && typeof f.value === 'string'
  );
  const nameField = (data.fields || []).find(
    (f) => f.label.toLowerCase().includes('name') && typeof f.value === 'string'
  );
  const email = emailField?.value || tokenMeta.email || process.env.ZOHO_EMAIL;
  const name = nameField?.value || 'Client';
  if (!email) {
    console.error("❌ No email found in webhook payload.");
    return res.status(400).send("Missing email.");
  }

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

  const allergyField = data.fields.find(f => f.label.toLowerCase().trim() === 'allergies');
  const allergyNote = allergyField?.value || 'None';

  const getPlanChunk = async (prompt) => {
    console.log("📤 Sending prompt to OpenAI:\n", prompt);
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
    let fullPlanText = '';
    if (planType === '4 Week') {
      const prompt1 = buildPrompt(userInfo, allergyNote, planType, 1);
      const prompt2 = buildPrompt(userInfo, allergyNote, planType, 2);
      const chunk1 = await getPlanChunk(prompt1);
      const chunk2 = await getPlanChunk(prompt2);

      fullPlanText = `${chunk1}\n\n---\n\n${chunk2}`;
    } else {
      const prompt = buildPrompt(userInfo, allergyNote, planType);
      fullPlanText = await getPlanChunk(prompt);
    }

    const doc = new PDFKit();
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', async () => {
      console.log("📦 PDF generation complete. Preparing to send...");
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
        text: 'Attached is your personalized plan.',
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; border: 1px solid #e0e0e0; padding: 30px; border-radius: 10px;">
          <div style="text-align: center;">
            <img src="cid:logo" alt="BulkBot Logo" style="width: 120px; margin-bottom: 20px;" />
            <h2 style="color: #333333;">Your Personalized Plan Has Arrived 🎉</h2>
          </div>
          <p>Thank you for choosing <strong>BulkBot AI</strong>. Your custom workout and meal plan is attached.</p>
        </div>
        `,
        attachments: [
          {
            filename: 'Plan.pdf',
            content: pdfData,
          },
          {
            filename: 'logo.jpg',
            path: './assets/logo.jpg',
            cid: 'logo'
          }
        ]
      });

      console.log(`📤 Plan emailed to ${email}`);
      res.status(200).send('Plan emailed!');
    });

    const path = require('path');

    doc.image(path.join(__dirname, 'assets/logo.jpg'), { width: 120, align: 'center' });
    doc.registerFont('Lora-SemiBold', path.join(__dirname, 'fonts/Lora-SemiBold.ttf'));
    doc.registerFont('BebasNeue-Regular', path.join(__dirname, 'fonts/BebasNeue-Regular.ttf'));
    doc.moveDown();
    doc.font('BebasNeue-Regular').fontSize(24).fillColor('#0066ff').text('Your Personalized Fitness Plan', { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).fillColor('#000').text(`Client: ${name}`, { align: 'center' });
    doc.addPage();

    const weekRegex = /Week (\\d)/g;
    const matches = [...fullPlanText.matchAll(weekRegex)].map(m => m[1]);
    const weekSections = fullPlanText.split(/(?=Week \\d)/);
    weekSections.forEach((section, i) => {
      if (i > 0) doc.addPage();
      const weekLabel = matches[i - 1] ? `Week ${matches[i - 1]}` : `Week ${i + 1}`;
      doc.font('BebasNeue-Regular').fontSize(20).fillColor('#0066ff').text(weekLabel, { align: 'center' });
      doc.moveDown();
      doc.font('Lora-SemiBold').fontSize(14).fillColor('#000000').text(section.trim(), {
        align: 'left',
        lineGap: 4
      });
    });

    doc.moveDown(2);
    doc.font('Lora-SemiBold').fontSize(14).fillColor('#000000').text(`Stay hydrated, consistent and well rested and results will come.\nThank you for choosing BulkBot.`, {
      align: 'center'
    });

    doc.end();
    console.log("📤 doc.end() called.");
  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).send('Plan generation failed');
  }
};

// Existing code for handleWebhook and tally webhook routes remains unchanged

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
