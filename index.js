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
const TOKENS_FILE = './tokens.json';
let validTokens = new Map();

// Load saved tokens
if (fs.existsSync(TOKENS_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    validTokens = new Map(saved.map(([k, v]) => [k, v]));
    console.log('🔐 Tokens loaded.');
  } catch (e) {
    console.error('❌ Error loading tokens:', e);
  }
}

const saveTokens = () => {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify([...validTokens]), 'utf-8');
    console.log('💾 Tokens saved.');
  } catch (e) {
    console.error('❌ Error saving tokens:', e);
  }
};

const buildPrompt = (info, allergies, planType, part = 1) => {
  const weeks = planType === '4 Week' ? `Weeks ${part === 1 ? '1 and 2' : '3 and 4'}` : '1 Week';
  return `You are a professional fitness and nutrition expert creating personalized PDF workout and meal plans for paying clients.

A customer has purchased the **${planType}** plan. Carefully analyze the following profile data to create a fully customized plan:

${info}

❗️IMPORTANT:
The user has the following allergies/intolerances:  
**${allergies || 'None'}**  
Exclude these allergens from all recipes. Do NOT mention or reference them — just silently avoid them in all meals.

---
✅ Generate the plan for ${weeks}:
${planType === '1 Week'
      ? `- A complete 1-week workout plan (7 days: Monday to Sunday)
- A complete 1-week meal plan (each day includes: Breakfast, Lunch, Dinner, Snack)`
      : `- A 2-week workout plan (7 days/week, with full details: Week > Day > Exercises)
- A 2-week meal plan (7 days/week, each with 4 meals + full macros)`}

---
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

// Add week headers with the BebasNeue-Regular font
const addWeekHeader = (doc, weekNumber) => {
  doc.fillColor('blue')  // Set the text color to blue
     .font('header')  // Set the font to BebasNeue-Regular
     .fontSize(18)  // Set font size for the week header
     .text(`Week ${weekNumber}`, { align: 'center' });
};

app.post('/webhook/shopify', async (req, res) => {
  try {
    const { email, line_items: lineItems = [] } = req.body;
    if (!email || !lineItems.length) return res.status(400).send('Missing order data');

    const planType = lineItems.some(item => item.title.toLowerCase().includes('4 week')) ? '4 Week' : '1 Week';
    const token = crypto.randomBytes(16).toString('hex');
    console.log('Generated token:', token);  // Log token generation

    validTokens.set(token, { used: false, email, planType });
    saveTokens();

    const tallyURL = planType === '4 Week' 
      ? `https://tally.so/r/wzRD1g?token=${token}&plan=4week` 
      : `https://tally.so/r/wMq9vX?token=${token}&plan=1week`;

    console.log('Sending form link to:', email);  // Log email and form link
    console.log('Tally URL:', tallyURL);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });

    await transporter.sendMail({
      from: 'BulkBot AI <bulkbotplans@gmail.com>',
      to: email,
      subject: 'Your BulkBot Plan Form Link 📝',
      html: `<div style="font-family:sans-serif;padding:20px">
        <h2>Hey there! 🏋️‍♂️</h2>
        <p>Thanks for buying the <b>${planType}</b> plan!</p>
        <p>Click below to submit your info and receive your custom PDF plan:</p>
        <a href="${tallyURL}" style="padding:10px 20px;background:#0066ff;color:#fff;border-radius:5px;text-decoration:none">Submit Form</a>
        <p><i>This link works once only. Don't share it!</i></p>
      </div>`
    });

    console.log(`✅ Token ${token} sent to ${email}`);
    res.send('OK');
  } catch (err) {
    console.error('❌ Shopify webhook error:', err);
    res.status(500).send('Server error');
  }
});

const handleWebhook = async (req, res, planType) => {
  try {
    const data = req.body.data || req.body;
    console.log('Tally Data Received:', data); // Log received data from Tally

    const submissionId = data.submissionId;
    if (processedSubmissions.has(submissionId)) return res.send('Duplicate');
    processedSubmissions.add(submissionId);

    let tokenField;
    if (planType === '4 Week') {
      tokenField = data.fields.find(f => f.key === 'question_OX4qD8_279a746e-6a87-47a2-af5f-9015896eda25');
    } else if (planType === '1 Week') {
      tokenField = data.fields.find(f => f.key === 'question_xDJv8d_25b0dded-df81-4e6b-870b-9244029e451c');
    }
    const token = tokenField ? tokenField.value : null;
    console.log('Extracted token:', token);

    const tokenMeta = validTokens.get(token);

    if (!tokenMeta || tokenMeta.used || tokenMeta.planType !== planType) {
      console.error(`❌ Invalid/Used Token: ${token}`);
      return res.status(401).send('Invalid/used token');
    }

    const email = tokenMeta.email;
    const name = data.fields.find(f => f.label.toLowerCase().includes('name'))?.value || 'Client';
    const allergies = data.fields.find(f => f.label.toLowerCase().includes('allergies'))?.value || 'None';

    const fitnessGoalOptions = {
      '15ac77be-80c4-4020-8e06-6cc9058eb826': 'Gain muscle mass',
      'other-goal-id': 'Lose weight',  // Add more goals here if necessary
    };
    const fitnessGoalField = data.fields.find(f => f.label.toLowerCase().includes('fitness goal'));
    const fitnessGoal = fitnessGoalField ? fitnessGoalField.value : 'Not specified';
    const goalText = fitnessGoalOptions[fitnessGoal] || 'Not specified';

    const userInfo = data.fields.map(f => {
      const val = Array.isArray(f.value) ? f.value.join(', ') : f.value;
      return `${f.label}: ${val}`;
    }).join('\n');
    console.log('User Info:', userInfo);

    const getPlanChunk = async (prompt) => {
      console.log('Sending prompt to AI:', prompt);
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a fitness and nutrition expert.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 10000
      });

      if (resp.choices && resp.choices[0]) {
        return resp.choices[0].message.content;
      }

      throw new Error('Failed to generate plan');
    };

    const prompt1 = buildPrompt(userInfo, allergies, planType, 1);
    const prompt2 = planType === '4 Week' ? buildPrompt(userInfo, allergies, planType, 2) : null;
    const chunk1 = await getPlanChunk(prompt1);
    const chunk2 = prompt2 ? await getPlanChunk(prompt2) : '';
    const fullText = `${chunk1}\n\n---\n\n${chunk2}`.trim();

    console.log('AI Response:', fullText);

    const doc = new PDFKit();
    doc.registerFont('header', path.join(__dirname, 'fonts', 'BebasNeue-Regular.ttf'));
    doc.registerFont('body',    path.join(__dirname, 'fonts', 'Lora-SemiBold.ttf'));
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', async () => {
      const pdf = Buffer.concat(buffers);
      const transporter = nodemailer.createTransport({
        service: 'gmail', auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
      });

      await transporter.sendMail({
        from: 'BulkBot AI <bulkbotplans@gmail.com>',
        to: email,
        subject: 'Your AI-Generated BulkBot Plan 📦',
        html: `<div style="font-family:sans-serif;padding:20px">
          <h2>Hi ${name}, your plan is here! 🎉</h2>
          <p>Thanks again for using BulkBot. Your PDF is attached.</p>
        </div>`,
        attachments: [
          { filename: 'Plan.pdf', content: pdf },
          { filename: 'logo.jpg', path: './assets/logo.jpg', cid: 'logo' }
        ]
      });

      tokenMeta.used = true;
      saveTokens();
      res.send('✅ Plan sent');
    });

    // Add title page with logo, user info, and message
    doc.addPage()
       .fillColor('#333')  
       .rect(0, 0, doc.page.width, doc.page.height)
       .fill();
    doc.fillColor('blue')
       .font('header')
       .fontSize(36)
       .text('PERSONAL GYM AND MEAL PLAN', { align: 'center', y: 150 });
    doc.image(path.join(__dirname, 'assets/logo.jpg'), doc.page.width / 2 - 120, 220, { width: 240, align: 'center' });

    doc.fillColor('#fff')
       .fontSize(14)
       .text(`Name: ${name}`, 100, 300)
       .text(`Email: ${email}`, 100, 320)
       .text(`Allergies: ${allergies}`, 100, 340);

    doc.fontSize(12)
       .text("Stay hydrated and consistent, and results will come!", { align: 'center', y: doc.page.height - 50 });

    // Add Week Headers
    doc.addPage();
    addWeekHeader(doc, 1);
    doc.moveDown(2);
    doc.font('body').fontSize(14).text(fullText, { align: 'left', lineGap: 6 });
    doc.end();

  } catch (e) {
    console.error('❌ Tally webhook error:', e);
    res.status(500).send('Internal error');
  }
};

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => console.log('🚀 Live at http://localhost:3000'));
