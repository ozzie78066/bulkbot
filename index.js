require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const { OpenAI } = require('openai');
const PDFKit = require('pdfkit');
const fs = require('fs');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(bodyParser.json());

const processedSubmissions = new Set();

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

  const emailField = (data.fields || []).find(
    (f) => f.label.toLowerCase().includes('email') && typeof f.value === 'string'
  );
  const email = emailField?.value || process.env.ZOHO_EMAIL;
  if (!email) {
    console.error("❌ No email found in webhook payload.");
    return res.status(400).send("Missing email.");
  }

  const userInfo = data.fields
    .map(field => {
      const val = Array.isArray(field.value) ? field.value.join(', ') : field.value;
      if (field.options) {
        const optionMap = Object.fromEntries(field.options.map(o => [o.id, o.text]));
        const readable = Array.isArray(field.value)
          ? field.value.map(id => optionMap[id] || id).join(', ')
          : optionMap[val] || val;
        return `${field.label.trim()}: ${readable}`;
      }
      return `${field.label.trim()}: ${val}`;
    })
    .join('\n');

  const allergyField = data.fields.find(
    f => f.label.toLowerCase().trim() === 'allergies'
  );
  const allergyNote = allergyField?.value || 'None';

  const makePrompt = (daysRange) => `
You are a professional fitness and nutrition expert creating personalized PDF workout and meal plans for paying clients.

A customer has purchased the **${planType}** plan. Carefully analyze the following profile data to create a fully customized plan:

${userInfo}

The user has the following allergies/intolerances: ${allergyNote}
Strictly exclude these from all meals without mentioning them.

Create a detailed, day-by-day plan for ${daysRange}.
Each day must have:
- A complete workout (with sets, reps, intensity, form cues)
- Four meals (breakfast, lunch, dinner, snack) with short recipe/ingredient list and calories/macros (Protein, Carbs, Fat)

NEVER summarize or say "continue similar days" — write every day in full.
This is a paid product and must be complete.

FORMAT:
Day [X]:
Workout:
- [Exercise, sets x reps, notes]
Meal:
- Breakfast: ...
- Lunch: ...
- Dinner: ...
- Snack: ...
`;

  const getPlanContent = async () => {
    if (planType === '1 Week') {
      const prompt = makePrompt("Days 1–7 (One Full Week)");
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a fitness and nutrition expert.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 7000
      });
      return completion.choices[0].message.content;
    } else {
      const prompts = [
        makePrompt("Days 1–14 (Week 1 & 2)"),
        makePrompt("Days 15–28 (Week 3 & 4)")
      ];
      const parts = await Promise.all(prompts.map(p =>
        openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a fitness and nutrition expert.' },
            { role: 'user', content: p }
          ],
          temperature: 0.4,
          max_tokens: 7000
        })
      ));
      return parts.map(p => p.choices[0].message.content).join('\n');
    }
  };

  try {
    const planText = await getPlanContent();

    const doc = new PDFKit();
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

      await transporter.sendMail({
        from: '"BulkBot AI" <bulkbotplans@gmail.com>',
        to: email,
        subject: 'Your Personalized Workout & Meal Plan 💪',
        text: 'Your plan is attached. Open the PDF for your personalized fitness and meal plan.',
        html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #0066ff;">Your BulkBot Plan Is Ready!</h2>
          <p>Your personalized plan is attached. Download and follow it for best results.</p>
          <p><strong>Stay hydrated, consistent and well rested and results will come 💪</strong></p>
        </div>`,
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

    doc.registerFont('Lora-SemiBold', 'fonts/Lora-SemiBold.ttf');
    doc.registerFont('BebasNeue-Regular', 'fonts/BebasNeue-Regular.ttf');
    doc.image('./assets/logo.jpg', { width: 120, align: 'center' });
    doc.moveDown();
    doc.font('BebasNeue-Regular').fontSize(24).fillColor('#0066ff').text('Your Personalized Fitness Plan', { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).fillColor('#000').text(`Client: ${email}`, { align: 'center' });
    doc.addPage();

    const addWeekHeaders = (text) => {
      const weekMarkers = ['Day 1', 'Day 8', 'Day 15', 'Day 22'];
      const weekLabels = ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
      let processed = text;
      for (let i = 0; i < weekMarkers.length; i++) {
        const regex = new RegExp(`(?=\b${weekMarkers[i]}\b)`, 'i');
        processed = processed.replace(regex, `\n\n${weekLabels[i]}\n\n`);
      }
      return processed;
    };

    const finalText = addWeekHeaders(planText) + "\n\nStay hydrated, consistent and well rested and results will come.\nThank you for choosing BulkBot.";

    doc.font('Lora-SemiBold').fontSize(14).text(finalText, {
      align: 'left',
      lineGap: 4
    });
    doc.end();

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).send('Plan generation failed');
  }
};

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
