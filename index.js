// Fixed & Final Working Version - BulkBot Secure AI Server
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
    validTokens = new Map(saved.map(([k, v]) => [k, v]));
    console.log('🔐 Tokens loaded.');
  } catch (err) {
    console.error('❌ Token file error:', err);
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify([...validTokens]), 'utf-8');
    console.log('💾 Tokens saved.');
  } catch (err) {
    console.error('❌ Failed to save tokens:', err);
  }
}

const buildPrompt = (info, allergy, plan, part = 1) => {
  const weeks = plan === '4 Week' ? `Weeks ${part === 1 ? '1 and 2' : '3 and 4'}` : '1 Week';
  return `You are a professional fitness and nutrition expert creating personalized PDF workout and meal plans for paying clients.

A customer has purchased the **${plan}** plan. Carefully analyze the following profile data to create a fully customized plan:

${info}

The user has the following allergies/intolerances:
**${allergy || 'None'}**
Exclude these allergens from all recipes. Do NOT mention or reference them — just silently avoid them in all meals.

Generate the plan for ${weeks}:
${plan === '1 Week' ? `
- A complete 1-week workout plan (7 days: Monday to Sunday)
- A complete 1-week meal plan (each day includes: Breakfast, Lunch, Dinner, Snack)` : `
- A 2-week workout plan (7 days/week, full details: Week > Day > Exercises)
- A 2-week meal plan (7 days/week, 4 meals/day, with macros)`}

FORMAT:
Day [X]:
Workout:
- Exercise – sets x reps, tips
Meal:
- Breakfast: name + ingredients + macros
- Lunch...
- Dinner...
- Snack...

RULES:
- Plain text only
- Each day unique
- Include calories, protein, carbs, fats for each meal
- Expert tone for PDF`
};

app.post('/webhook/shopify', async (req, res) => {
  try {
    const { email, line_items = [] } = req.body;
    if (!email || !line_items.length) return res.status(400).send('Missing order data');

    const bought4Week = line_items.some(item => item.title.toLowerCase().includes('4 week'));
    const planType = bought4Week ? '4 Week' : '1 Week';

    const token = crypto.randomBytes(16).toString('hex');
    validTokens.set(token, { used: false, email, planType });
    saveTokens();

    const tallyURL = `https://tally.so/r/wzRD1g?token=${token}`;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });

    await transporter.sendMail({
      from: 'BulkBot AI <bulkbotplans@gmail.com>',
      to: email,
      subject: 'Your BulkBot Plan Form Link 📝',
      html: `
        <div style="font-family: Arial; background: #fff; border: 1px solid #ccc; padding: 30px; border-radius: 10px;">
          <h2 style="color: #333;">Welcome to BulkBot AI!</h2>
          <p>Thanks for ordering the <strong>${planType}</strong> plan.</p>
          <p>To receive your personalized plan, fill out the form below:</p>
          <a href="${tallyURL}" style="padding: 10px 20px; background: #0066ff; color: #fff; border-radius: 5px; text-decoration: none;">Fill Out Form</a>
          <p>This link is valid for one use only.</p>
        </div>`
    });

    console.log(`✅ Token ${token} sent to ${email}`);
    res.status(200).send('Token sent');
  } catch (err) {
    console.error('❌ Shopify webhook error:', err);
    res.status(500).send('Server error');
  }
});

const handleWebhook = async (req, res, planType) => {
  const data = req.body.data || req.body;
  const submissionId = data.submissionId;

  const tokenField = data.fields.find(f => f.key?.toLowerCase().includes('token'));
  const token = tokenField?.value;
  const tokenMeta = validTokens.get(token);

  if (!tokenMeta || tokenMeta.planType !== planType) return res.status(401).send('Invalid token');
  if (tokenMeta.used) return res.status(409).send('Token already used');

  if (processedSubmissions.has(submissionId)) return res.status(200).send('Already processed');
  processedSubmissions.add(submissionId);
  setTimeout(() => processedSubmissions.delete(submissionId), 900000);

  const email = (data.fields.find(f => f.label.toLowerCase().includes('email'))?.value || tokenMeta.email);
  const name = (data.fields.find(f => f.label.toLowerCase().includes('name'))?.value || 'Client');
  const allergyNote = (data.fields.find(f => f.label.toLowerCase().includes('allergies'))?.value || 'None');

  const userInfo = data.fields.map(field => {
    const val = Array.isArray(field.value) ? field.value.join(', ') : field.value;
    if (field.options) {
      const optionMap = Object.fromEntries(field.options.map(o => [o.id, o.text]));
      return `${field.label.trim()}: ${Array.isArray(field.value) ? field.value.map(id => optionMap[id] || id).join(', ') : optionMap[val] || val}`;
    }
    return `${field.label.trim()}: ${val}`;
  }).join('\n');

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
    const finalText = `${chunk1}\n\n---\n\n${chunk2}`.trim();

    const doc = new PDFKit();
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', async () => {
      const pdf = Buffer.concat(buffers);
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
      });

      await transporter.sendMail({
        from: 'BulkBot AI <bulkbotplans@gmail.com>',
        to: email,
        subject: 'Your Personalized Plan 💪',
        html: `
          <div style="font-family: Arial; padding: 30px; border: 1px solid #ccc;">
            <h2 style="text-align:center">Your Custom Plan is Ready 🎯</h2>
            <p>Attached is your personalized BulkBot plan.</p>
          </div>`,
        attachments: [{ filename: 'Plan.pdf', content: pdf }]
      });

      tokenMeta.used = true;
      saveTokens();
      console.log(`📤 Sent plan to ${email}`);
      res.status(200).send('Plan sent');
    });

    doc.fontSize(20).text(`Fitness Plan for ${name}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(finalText, { align: 'left' });
    doc.end();

  } catch (err) {
    console.error('❌ Plan gen error:', err);
    res.status(500).send('Error');
  }
};

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => console.log('🚀 http://localhost:3000'));
