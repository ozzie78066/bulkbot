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

  console.log("\uD83E\uDDE0 Incoming Tally data:", data);

  const email = data.email || process.env.ZOHO_EMAIL;
  if (!email) {
    console.error("\u274C No email found in webhook payload.");
    return res.status(400).send("Missing email.");
  }

  console.log("🧪 Parsed incoming data:\n", JSON.stringify(data, null, 2));
  const userInfo = Object.entries(data)
    .map(([key, val]) => {
    // If it's an array, join it nicely
    const cleanVal = Array.isArray(val) ? val.join(', ') : val;
    return `${key}: ${cleanVal}`;
  })
  .join('\n');

  const prompt = `You are a professional fitness and nutrition coach. Based on the following user profile, generate a highly detailed and structured personalized workout and meal plan:

${userInfo}

---

**Requirements for the response:**
- the format should be as follows:
- Name of user profile
- then a formatted day by day detailed workout plan, with workout type, reps and weight
- then the formatted detailed meal plan that helps them hit their goals based on current weights and workout regime
- No hashtags or markdown symbols (e.g., #)
- Separate sections clearly with titles: "Workout Plan" and "Meal Plan"
- Organize each plan weekly (Week 1–4)
- For workouts: list specific daily routines (e.g., Day 1: Push-ups 3x15, Plank 3x1min, etc.)
- For meals: provide breakfast, lunch, dinner, and snack suggestions with portion guidance
- Format it for readability and clarity in a PDF document

Make the response professional, supportive, and customized to the user.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a fitness and nutrition expert.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
    });

    const planText = completion.choices[0].message.content;
    console.log("\u2705 GPT generated plan");

    const doc = new PDFKit();
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));

    doc.on('end', async () => {
      const pdfData = Buffer.concat(buffers);

      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: process.env.ZOHO_EMAIL,
          pass: process.env.ZOHO_PASS,
        },
      });

      try {
        await transporter.sendMail({
          from: `BulkBot <${process.env.ZOHO_EMAIL}>`,
          to: email,
          subject: 'Your Custom Workout & Meal Plan',
          text: 'Attached is your personalized plan!',
          attachments: [
            {
              filename: 'Plan.pdf',
              content: pdfData,
            },
          ],
        });

        console.log(`\uD83D\uDCE4 Plan emailed to ${email}`);
        res.status(200).send('Plan emailed!');
      } catch (mailErr) {
        console.error('❌ Email failed:', mailErr);
        res.status(500).send('Email failed');
      }
    });

    doc.fontSize(12).text(planText);
    doc.end();
  } catch (err) {
    console.error('❌ OpenAI or PDF error:', err);
    res.status(500).send('Plan generation failed');
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
