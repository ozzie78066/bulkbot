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

  console.log("🤖 Incoming Tally data:", data);

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

  const allergyField = data.fields.find(
    f => f.label.toLowerCase().trim() === 'allergies'
  );
  const allergyNote = allergyField?.value || 'None';

  const prompt = `
    Create my customer a professional PDF file.

    The user has purchased the **${planType}** plan.

    You are a professional fitness and nutrition coach. Based on the following user profile, generate a highly detailed and structured personalized workout and meal plan:

    ${userInfo}

    IMPORTANT:  
    The user has stated the following allergies and intolerances:  
    Allergens: ${allergyNote || 'None'}  
    These ingredients MUST NOT be included in any meals. Do NOT mention or reference them in any way — just silently exclude them.
    do not even use a recipe that calls for their allergen.
    ---

    ${planType === '1 Week' ? `
    • Make a **1-week workout plan**, detailing workouts **day by day all 7 days monday to sunday**
    • Make a **1-week meal plan**, including breakfast, lunch, dinner, and snack for **each day monday to sunday**
    ` : `
    • Make a **4-week workout plan**, organized by week and detailed **day by day each day for that whole week**
    • Make a **4-week meal plan**, broken down by week, and then by day with full meal guidance
    `}

    Each recipe must be unique, healthy, and suitable for their stated fitness goal
    Strictly avoid allergens without referencing them

    ---

    Please use the following layout EXACTLY for the PDF:

    [User's Name] 

    Day [X]:  
    Workout:  
    - [Workout name, reps, sets, weight or bodyweight, form notes]  
    - ...  
    - ...  

    Meal:  
    - Breakfast: [Name + short recipe + macros]  
    - Lunch: ...  
    - Dinner: ...  
    - Snack: ...

    (repeat for every day of the week)

    End the pdf with:  

    "Remember to hydrate and stay rested for best results.  
    [Include a short motivational note tied to the user’s specific fitness goal]

    Thank you for choosing BulkBot."

    ---

    STRICT FORMAT RULES:
    - NEVER include tables or charts
    - NEVER include markdown symbols (#)
    - Meals must be formatted as plain text, sectioned by day and meal
    - Include estimated **calories + macros** for each meal: Protein, Carbs, Fat
    - No duplicated meals unless part of a structured cycle
    - Do not mention allergies or restrictions in the plan — just respect them
    - Avoid filler — each day should have full detail for both workout and meals
    - Maintain clean structure for readability in a PDF
    - Tone should be expert, motivating, and supportive

    This plan will be sold to customers. Treat it as a premium fitness product.
  `;

  try {
    console.log('🧾 Final prompt sent to OpenAI:\n', prompt);
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
          html: `<div>See attached plan.</div>`,
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
};

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
