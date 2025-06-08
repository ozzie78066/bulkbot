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
    You are a professional fitness and nutrition expert creating personalized PDF workout and meal plans for paying clients.

A customer has purchased the **${planType}** plan. Use the following profile data to create a fully customized plan:

${userInfo}

❗️IMPORTANT:
The user has the following allergies/intolerances:  
**${allergyNote || 'None'}**  
Exclude these allergens from all recipes. Do NOT mention or reference them — just silently avoid them in all meals.

---

✅ Generate the plan based on the type selected:

${planType === '1 Week' ? `
• A complete **1-week workout plan** — one workout per day, Monday to Sunday.  
• A complete **1-week meal plan** — including **Breakfast, Lunch, Dinner, and Snack** per day.  
` : `
• A full **4-week workout plan** — structured by week, detailed by day (7 days per week).  
• A full **4-week meal plan** — broken into weeks, then days, each with **Breakfast, Lunch, Dinner, and Snack**.  
`}

Ensure all workouts and meals support the user’s fitness goal. Each meal and workout must be unique and varied, not copy-pasted.

---

📄 FORMAT (Must be followed exactly for PDF readability):

[User’s Name]

Day [X]:  
Workout:  
- [Exercise name, sets x reps, intensity or weight, form tips]  
- ...  
- ...  

Meal:  
- Breakfast: [Name + short recipe or ingredients + estimated macros]  
- Lunch: ...  
- Dinner: ...  
- Snack: ...

---

📌 PDF End Section:
"Remember to hydrate and stay rested for best results.  
[Include a motivational line tied to their fitness goal]

Thank you for choosing BulkBot."

---

🧾 STRICT RULES:
- DO NOT include tables, bullet symbols, or markdown (#, *, etc.)
- Meals and workouts must be plain text and structured cleanly for PDF output
- Every meal must show estimated **Calories**, **Protein**, **Carbs**, and **Fats**
- Do not mention allergies or dietary restrictions — just respect them quietly
- Avoid filler text — keep every day detailed and high-quality
- Tone: **Expert, positive, supportive, premium-quality**

Treat this as a professional deliverable for a paying customer. Output must be polished and consistent.
  `;

  try {
    console.log('🧾 Final prompt sent to OpenAI:\n', prompt);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
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
