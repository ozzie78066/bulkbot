require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const PDFKit = require('pdfkit');
const { OpenAI } = require('openai');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(bodyParser.json());

const processedSubmissions = new Set();

const generatePlanChunk = async (chunkPrompt) => {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a fitness and nutrition expert.' },
      { role: 'user', content: chunkPrompt }
    ],
    temperature: 0.4,
    max_tokens: 8000
  });
  return completion.choices[0].message.content;
};

const handleWebhook = async (req, res, planType) => {
  const raw = req.body;
  const data = raw.data || raw;
  const submissionId = data.submissionId;

  if (processedSubmissions.has(submissionId)) {
    console.log(`⚠️ Duplicate submission ${submissionId} ignored`);
    return res.status(200).send("Already processed");
  }
  processedSubmissions.add(submissionId);
  setTimeout(() => processedSubmissions.delete(submissionId), 15 * 60 * 1000);

  console.log("🤖 Incoming Tally data:", data);

  const emailField = (data.fields || []).find(
    (f) => f.label.toLowerCase().includes('email') && typeof f.value === 'string'
  );
  const email = emailField?.value || process.env.ZOHO_EMAIL;
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

  const allergyField = data.fields.find(
    f => f.label.toLowerCase().trim() === 'allergies'
  );
  const allergyNote = allergyField?.value || 'None';

  const basePromptHeader = `
You are a professional fitness and nutrition expert creating personalized PDF workout and meal plans for paying clients.

A customer has purchased the **${planType}** plan. Carefully analyze the following profile data to create a fully customized, polished plan:

${userInfo}

❗️IMPORTANT:
The user has the following allergies/intolerances:
**${allergyNote || 'None'}**
Exclude these allergens from ALL recipes. Do NOT mention or reference them. Simply avoid them silently.

Each workout and meal must align with the client’s goals and be unique and varied.
Avoid repetition unless part of a structured cycle.
`;

  let fullPlan = '';
  if (planType === '1 Week') {
    const prompt = `${basePromptHeader}
---
✅ TASK:
- Write a full 7-day plan (Monday–Sunday)
- Each day includes: detailed workouts (sets, reps, intensity tips), and four meals (Breakfast, Lunch, Dinner, Snack), with calories/macros.

📄 FORMAT:
Day [X]:
Workout:
- Exercise 1 (sets x reps, weight/bodyweight, tips)
...
Meal:
- Breakfast: [Name + short recipe + macros]
- Lunch: ...
- Dinner: ...
- Snack: ...

Finish with a motivational outro + thank you.
---
🧾 STRICT RULES:
- NO markdown (#, *, etc.)
- NO summaries like "continue..."
- Full details only
- Meals must show: Calories, Protein, Carbs, Fat
- Output must be premium, cleanly structured, and well written.`;

    fullPlan = await generatePlanChunk(prompt);

  } else {
    const promptA = `${basePromptHeader}

✅ TASK:
Write **Days 1–14** of a full 28-day fitness and meal plan.
- Each day has workouts (sets x reps, bodyweight or weight, tips)
- Each day has four meals with full macros: Calories, Protein, Carbs, Fat
- DO NOT summarize or skip days.
📄 FORMAT as above.`;

    const promptB = `${basePromptHeader}

✅ TASK:
Now continue and write **Days 15–28** of the 28-day plan.
Use the exact same structure. Do NOT refer to the earlier days.

Strictly avoid summarizing. Write out each day completely.`;

    const part1 = await generatePlanChunk(promptA);
    const part2 = await generatePlanChunk(promptB);

    fullPlan = `${part1}\n\n${part2}`;
  }

  const doc = new PDFKit({ margin: 40 });
  const buffers = [];

  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', async () => {
    const pdfData = Buffer.concat(buffers);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'bulkbotplans@gmail.com',
        pass: 'zlqw lsks zefx fogf'
      }
    });

    try {
      await transporter.sendMail({
        from: 'BulkBot AI <bulkbotplans@gmail.com>',
        to: email,
        subject: 'Your Personalized Workout & Meal Plan 💪',
        html: `<div style="font-family: Arial; background: #fff; padding: 20px; border-radius: 10px;">
          <img src="cid:logo" style="width: 120px; margin: auto; display: block;"/>
          <h2 style="text-align:center; color: #0066ff;">Your Personalized Plan Has Arrived 🎉</h2>
          <p>Thank you for choosing <b>BulkBot AI</b>. Your full plan is attached as a PDF — let’s begin your transformation!</p>
        </div>`,
        attachments: [
          { filename: 'Plan.pdf', content: pdfData },
          { filename: 'logo.jpg', path: './assets/logo.jpg', cid: 'logo' }
        ]
      });
      console.log(`📤 Plan emailed to ${email}`);
      res.status(200).send('Plan emailed!');
    } catch (mailErr) {
      console.error('❌ Email failed:', mailErr);
      res.status(500).send('Email failed');
    }
  });

  doc.registerFont('Lora-SemiBold', 'fonts/Lora-SemiBold.ttf');
  doc.registerFont('BebasNeue-Regular', 'fonts/BebasNeue-Regular.ttf');

  doc.image('./assets/logo.jpg', { width: 120, align: 'center' });
  doc.moveDown();
  doc.font('BebasNeue-Regular').fontSize(24).fillColor('#0066ff').text('Your Personalized Fitness Plan', { align: 'center' });
  doc.moveDown();
  doc.fontSize(16).fillColor('#000').text(`Client: ${email}`, { align: 'center' });
  doc.addPage();

  let currentWeek = 1;
  const lines = fullPlan.split('\n');
  for (let line of lines) {
    if (/Day 1:?/i.test(line)) {
      doc.addPage();
      doc.font('BebasNeue-Regular').fontSize(20).fillColor('#0066ff').text(`Week ${currentWeek}`, { align: 'center' });
      doc.moveDown();
    } else if (/Day 8:?/i.test(line)) {
      currentWeek = 2;
      doc.addPage();
      doc.font('BebasNeue-Regular').fontSize(20).fillColor('#0066ff').text(`Week ${currentWeek}`, { align: 'center' });
      doc.moveDown();
    } else if (/Day 15:?/i.test(line)) {
      currentWeek = 3;
      doc.addPage();
      doc.font('BebasNeue-Regular').fontSize(20).fillColor('#0066ff').text(`Week ${currentWeek}`, { align: 'center' });
      doc.moveDown();
    } else if (/Day 22:?/i.test(line)) {
      currentWeek = 4;
      doc.addPage();
      doc.font('BebasNeue-Regular').fontSize(20).fillColor('#0066ff').text(`Week ${currentWeek}`, { align: 'center' });
      doc.moveDown();
    }
    doc.font('Lora-SemiBold').fontSize(13).fillColor('#000').text(line, {
      align: 'left',
      lineGap: 4
    });
  }

  doc.end();
};

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
