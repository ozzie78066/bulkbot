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

  const emailField = (data.fields || []).find(
  (f) => f.label.toLowerCase().includes('email') && typeof f.value === 'string'
);
const email = emailField?.value || process.env.ZOHO_EMAIL;
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
  const allergyField = data.fields.find(
  f => f.label.toLowerCase().trim() === 'allergies'
  );
  const allergyNote = allergyField?.value || 'None';
 
  const prompt = `
  Create my customer a proffessional pdf file 
  if the user purchased the 1 week plan then only make a 1 week long workout plan but please detail the workout day by day with direct instructions on what to do. And a 1 week long meal plan day by day breakfast lunch and dinner recipes, find new and interesting healthy meals that work for the clients diets and allergies. 
  if the user purchased the 1 month plan then make a 1 month long workout plan and detail each week with each days workout and meal plan structured in week blocks.
  the user has purchased the **${planType}** plan.
  You are a professional fitness and nutrition coach. Based on the following user profile, generate a highly detailed and structured personalized workout and meal plan:

${userInfo}
IMPORTANT: The user has stated the following allergies and intolerances:
DO NOT INCLUDE these ingredients in any meals under any circumstance.

Allergens: ${allergyNote || 'None'}
the user has purchased the **${planType}** plan.
---
Make sure that if it is a 1 week plan to include every day of the weeks workout and meal (all 7 days)
And the same for the month, this has to be a fully fledged product to sell.
please make the pdf layout to this exact template:

			BulkBot
	
 [users name] personalized fitness and nutrition plan [centered with no symbols]


Workout plan

format each day of the week like 
Day:

workout

-[workout type, reps and explanation]
-
-
-

Meal 

-breakfast
-lunch
-dinner
-snack

etc



Remember to hydrate and stay rested for best results
[include note to help with their goal]

Thank you for chosing BulkBot


Do NOT use tables or charts. Format meals as clean text.

**Requirements for the response:**
- do not have # or any other symbols where not needed eg for spacing

- the format should be as follows:
- Name of user profile
- then a formatted day by day detailed workout plan, with workout type, reps and weight
- then the formatted detailed meal plan that helps them hit their goals based on current weights and workout regime
- include macros for each meal to make it easier for user to track protien
- please format in a chart for easy readabiity
-
- For workouts: list specific daily routines 
- For meals: provide breakfast, lunch, dinner, and snack suggestions with portion guidance and recipes and macros
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
  subject: 'Your Personalized Workout & Meal Plan 💪',
  text: 'Attached is your personalized plan!',
  html: `
  <div style="max-width: 600px; margin: auto; font-family: 'Segoe UI', Roboto, sans-serif; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);">
    <div style="background: #101e29; padding: 30px; text-align: center;">
      <img src="cid:logo" alt="BulkBot Logo" style="width: 100px; height: auto; margin-bottom: 20px;" />
      <h1 style="color: #ffffff; margin: 0; font-size: 26px;">Your Personalized Plan Awaits</h1>
    </div>

    <div style="padding: 30px;">
      <p style="font-size: 16px; color: #333; line-height: 1.6;">
        Hey there,
        <br><br>
        Thanks for trusting <strong>BulkBot</strong> with your fitness journey. 
        Attached is your customized <strong>${planType}</strong> Workout & Meal Plan — built just for you using our AI-powered training engine.
      </p>

      <div style="margin: 30px 0; text-align: center;">
        <a href="#" style="display: inline-block; background: #ff3c00; color: #fff; text-decoration: none; padding: 14px 26px; border-radius: 8px; font-weight: bold; font-size: 15px;">Download Attached Plan Below</a>
      </div>

      <p style="font-size: 15px; color: #555; line-height: 1.5;">
        If you have any suggestions please email us at plans@bulkbot.store
        <br><br>
        Let’s get bigger, faster, stronger — together. 💪
      </p>

      <p style="font-size: 14px; color: #aaa; margin-top: 40px; text-align: center;">
        Follow us on Instagram and tik tok @BulkBotAI
      </p>
    </div>
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
,
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
