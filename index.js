// FINAL VERSION – BulkBot Server (Stable)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const PDFKit = require('pdfkit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(bodyParser.json());

const TOKENS_FILE = './tokens.json';
let validTokens = new Map();
if (fs.existsSync(TOKENS_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    validTokens = new Map(saved.map(([key, val]) => [key, val]));
    console.log('🔐 Tokens loaded');
  } catch (err) {
    console.error('❌ Token load failed:', err);
  }
}
const saveTokens = () => {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify([...validTokens]), 'utf-8');
};

const processedSubmissions = new Set();

const buildPrompt = (userInfo, allergyNote, planType, part = 1) => {
  const weeks = planType === '4 Week' ? `Weeks ${part === 1 ? '1 and 2' : '3 and 4'}` : '1 Week';
  return `You are a professional fitness and nutrition expert creating personalized workout and meal plans.

${userInfo}

Allergies: ${allergyNote || 'None'}

Generate a ${weeks} plan with unique daily workouts and 4 meals per day (Breakfast, Lunch, Dinner, Snack).
- Clean text format
- Include macros (Cals, Protein, Carbs, Fats)
- No summaries or tables
`;
};

app.post('/webhook/shopify', async (req, res) => {
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
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS
    }
  });

  await transporter.sendMail({
    from: 'BulkBot <bulkbotplans@gmail.com>',
    to: email,
    subject: 'Fill Out Your BulkBot Plan Form 📝',
    html: `<p>Thanks for your order.</p><p>Please fill this form:</p><a href="${tallyURL}">${tallyURL}</a>`
  });

  res.status(200).send('Token sent');
});

const handleWebhook = async (req, res, planType) => {
  const data = req.body.data || req.body;
  const submissionId = data.submissionId;
  if (processedSubmissions.has(submissionId)) return res.status(200).send('Already processed');

  const tokenField = data.fields.find(f => f.key.toLowerCase().includes('token'));
  const token = tokenField?.value;
  const tokenMeta = validTokens.get(token);

  if (!tokenMeta || tokenMeta.used || tokenMeta.planType !== planType) return res.status(403).send('Invalid or used token');

  const emailField = data.fields.find(f => f.label.toLowerCase().includes('email'));
  const nameField = data.fields.find(f => f.label.toLowerCase().includes('name'));
  const allergyField = data.fields.find(f => f.label.toLowerCase().includes('allergies'));

  const email = emailField?.value || tokenMeta.email;
  const name = nameField?.value || 'Client';
  const allergyNote = allergyField?.value || 'None';

  const userInfo = data.fields.map(f => `${f.label.trim()}: ${Array.isArray(f.value) ? f.value.join(', ') : f.value}`).join('\n');

  const getPlan = async (prompt) => {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a fitness and nutrition expert.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4,
      max_tokens: 8000
    });
    return response.choices[0].message.content;
  };

  const plan1 = await getPlan(buildPrompt(userInfo, allergyNote, planType, 1));
  const plan2 = planType === '4 Week' ? await getPlan(buildPrompt(userInfo, allergyNote, planType, 2)) : '';
  const fullText = `${plan1}\n\n${plan2}`.trim();

  const doc = new PDFKit();
  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', async () => {
    const pdfData = Buffer.concat(buffers);
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });

    await transporter.sendMail({
      from: 'BulkBot <bulkbotplans@gmail.com>',
      to: email,
      subject: 'Your BulkBot Plan 📦',
      html: `<p>Your personalized plan is attached. Thank you!</p>`,
      attachments: [ { filename: 'Plan.pdf', content: pdfData } ]
    });

    tokenMeta.used = true;
    saveTokens();
    processedSubmissions.add(submissionId);
    setTimeout(() => processedSubmissions.delete(submissionId), 15 * 60 * 1000);

    res.status(200).send('Plan sent');
  });

  doc.fontSize(20).text(`Client: ${name}\n\n${fullText}`);
  doc.end();
};

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => console.log('✅ Server running on port 3000'));
