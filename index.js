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
  return `You are a fitness and nutrition expert creating personalized PDF workout and meal plans.

Client Info:
${userInfo}
Allergies: ${allergyNote || 'None'}
Plan: ${planType} (${weeks})

Instructions:
- Generate a detailed ${weeks} workout and meal plan
- No tables or markdown
- Meals must include calories, protein, carbs, and fats
- Tone: professional and supportive
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
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
      }
    });

    await transporter.sendMail({
      from: 'BulkBot AI <bulkbotplans@gmail.com>',
      to: email,
      subject: 'Your BulkBot Plan Form Link 📝',
      html: `<p>Thanks for ordering the <strong>${planType}</strong> plan.</p>
             <p>Fill this form to receive your plan:</p>
             <a href="${tallyURL}">${tallyURL}</a>
             <p>This link can only be used once.</p>`
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
    return res.status(200).send('Already processed');
  }
  processedSubmissions.add(submissionId);

  const emailField = data.fields.find(f => f.label.toLowerCase().includes('email'));
  const nameField = data.fields.find(f => f.label.toLowerCase().includes('name'));
  const email = emailField?.value || tokenMeta.email;
  const name = nameField?.value || 'Client';

  const userInfo = data.fields.map(field => `${field.label.trim()}: ${field.value}`).join('\n');
  const allergyNote = (data.fields.find(f => f.label.toLowerCase().includes('allergies'))?.value || 'None');

  try {
    const prompt1 = buildPrompt(userInfo, allergyNote, planType, 1);
    const prompt2 = planType === '4 Week' ? buildPrompt(userInfo, allergyNote, planType, 2) : null;
    const chunk1 = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a fitness and nutrition expert.' },
        { role: 'user', content: prompt1 }
      ],
      temperature: 0.4,
      max_tokens: 10000
    });
    const text1 = chunk1.choices[0].message.content;
    const text2 = planType === '4 Week'
      ? (await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a fitness and nutrition expert.' },
            { role: 'user', content: prompt2 }
          ],
          temperature: 0.4,
          max_tokens: 10000
        })).choices[0].message.content
      : '';

    const fullPlanText = `${text1}\n\n${text2}`;

    const doc = new PDFKit();
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', async () => {
      const pdfData = Buffer.concat(buffers);

      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.MAIL_USER,
          pass: process.env.MAIL_PASS
        }
      });

      await transporter.sendMail({
        from: 'BulkBot AI <bulkbotplans@gmail.com>',
        to: email,
        subject: 'Your Personalized Workout & Meal Plan 💪',
        html: `<p>Hey ${name},</p><p>Your personalized plan is attached. Stay strong! 💪</p>`,
        attachments: [
          { filename: 'Plan.pdf', content: pdfData }
        ]
      });

      tokenMeta.used = true;
      saveTokens();

      console.log(`📤 Plan sent to ${email}`);
      res.status(200).send('Plan emailed!');
    });

    doc.fontSize(18).text(`Personalized Plan for ${name}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(fullPlanText);
    doc.end();
  } catch (err) {
    console.error('❌ AI or email error:', err);
    res.status(500).send('Failed to generate or send plan');
  }
};

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => console.log('🚀 Server running on http://localhost:3000'));
