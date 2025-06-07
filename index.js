require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const { PDFDocument } = require('pdfkit');
const PDFKit = require('pdfkit');
const { OpenAI } = require('openai');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(bodyParser.json());

app.post('/api/tally-webhook', async (req, res) => {
  const raw = req.body;
  const data = raw.data || raw;
  const processedSubmissions = new Set();
  const submissionId = data.submissionId;

  if (processedSubmissions.has(submissionId)) {
    console.log(`⚠️ Duplicate submission ${submissionId} ignored`);
    return res.status(200).send("Already processed");
  }
  processedSubmissions.add(submissionId);
  setTimeout(() => processedSubmissions.delete(submissionId), 15 * 60 * 1000);

  console.log("🧠 Incoming Tally data:", data);

  const emailField = (data.fields || []).find(
    (f) => f.label.toLowerCase().includes('email') && typeof f.value === 'string'
  );
  const email = emailField?.value || process.env.ZOHO_EMAIL;
  if (!email) {
    console.error("❌ No email found in webhook payload.");
    return res.status(400).send("Missing email.");
  }

  console.log("🧪 Parsed incoming data:\n", JSON.stringify(data, null, 2));
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

  const formId = data.formId || '';
  let planType = '1 Week';
  if (formId === 'wkQ9RZ') {
    planType = '4 Week';
  } else if (formId === 'wMq9vX') {
    planType = '1 Week';
  } else {
    console.warn(`⚠️ Unknown formId: ${formId}, defaulting to 1 Week`);
  }

  const allergyField = data.fields.find(
    f => f.label.toLowerCase().trim() === 'allergies'
  );
  const allergyNote = allergyField?.value || 'None';

  const prompt = `...` // Keep your original prompt string here as it was.

  try {
    console.log('🧾 Form ID:', formId);
    console.log("📤 Final prompt sent to OpenAI:\n", prompt);
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a fitness and nutrition expert.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
    });

    const planText = completion.choices[0].message.content;
    console.log("✅ GPT generated plan");

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

      try {
        await transporter.sendMail({
          from: `"BulkBot AI" <bulkbotplans@gmail.com>`,
          to: email,
          subject: 'Your Personalized Workout & Meal Plan 💪',
          text: 'Attached is your personalized plan!',
          html: `...`, // Keep your original email HTML here
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
      } catch (mailErr) {
        console.error('❌ Email failed:', mailErr);
        res.status(500).send('Email failed');
      }
    });

    doc.registerFont('Lora-SemiBold', 'fonts/Lora-SemiBold.ttf');
    doc.registerFont('BebasNeue-Regular', 'fonts/BebasNeue-Regular.ttf');
    doc.font('BebasNeue-Regular').fontSize(18).text('Your Personalized Plan', { align: 'center' });
    doc.moveDown();
    doc.font('Lora-SemiBold').fontSize(14).text(planText, {
      align: 'left',
      lineGap: 4
    });
    doc.end();
  } catch (err) {
    console.error('❌ OpenAI or PDF error:', err);
    res.status(500).send('Plan generation failed');
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
