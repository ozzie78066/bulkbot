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
  const userInfo = data.fields
  .map(field => {
    const val = Array.isArray(field.value) ? field.value.join(', ') : field.value;

    // If dropdown, replace ID with label
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
  const planType = data.formName?.startsWith('4') ? '4 Week' : '1 Week';

  const prompt = `
  Create my customer a proffessional pdf file 
  if the user purchased the 1 week plan then only make a 1 week long workout plan but please detail the workout day by day with direct instructions on what to do. And a 1 week long meal plan day by day breakfast lunch and dinner recipes, find new and interesting healthy meals that work for the clients diets and allergies. 
  if the user purchased the 1 month plan then make a 1 month long workout plan and detail each week with each days workout and meal plan structured in week blocks.
  the user has purchased the **${planType}** plan.
  You are a professional fitness and nutrition coach. Based on the following user profile, generate a highly detailed and structured personalized workout and meal plan:

${userInfo}

the user has purchased the **${planType}** plan.
---
For each day, present meals using **clear sectioned blocks** like:

Day 1  
Breakfast: ...  
Lunch: ...  
Dinner: ...  
Snack: ...

Do NOT use tables or charts. Format meals as clean text.

**Requirements for the response:**
- the format should be as follows:
- Name of user profile
- then a formatted day by day detailed workout plan, with workout type, reps and weight
- then the formatted detailed meal plan that helps them hit their goals based on current weights and workout regime
- please format in a chart for easy readabiity
- Separate sections clearly with titles: "Workout Plan" and "Meal Plan"
-
- For workouts: list specific daily routines 
- For meals: provide breakfast, lunch, dinner, and snack suggestions with portion guidance and recipes
- Format it for readability and clarity in a PDF document

Make the response professional, supportive, and customized to the user.`;

  try {
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
    doc.registerFont('Lora-SemiBold', 'fonts/Lora-SemiBold.ttf');
    doc.registerFont('BebasNeue-Regular', 'fonts/BebasNeue-Regular.ttf');
    doc.font('BebasNeue-Regular').fontSize(16).text('Workout Plan');
    doc.moveDown();
    doc.font('Lora-SemiBold').fontSize(14).text(planText);
    doc.end();
  } catch (err) {
    console.error('❌ OpenAI or PDF error:', err);
    res.status(500).send('Plan generation failed');
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
