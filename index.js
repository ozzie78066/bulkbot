require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const PDFKit = require('pdfkit');
const crypto = require('crypto');
const { OpenAI } = require('openai');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(bodyParser.json());
app.use(express.raw({ type: 'application/json' }));

const processedSubmissions = new Set();
const validTokens = new Map(); // token -> { used: boolean, email: string, planType: string }

const buildPrompt = (userInfo, allergyNote, planType, part = 1) => {
  const weeks = planType === '4 Week' ? `Weeks ${part === 1 ? '1 and 2' : '3 and 4'}` : '1 Week';
  return `
You are a professional fitness and nutrition expert creating personalized PDF workout and meal plans for paying clients.

A customer has purchased the **${planType}** plan. Carefully analyze the following profile data to create a fully customized plan:

${userInfo}

❗️IMPORTANT:
The user has the following allergies/intolerances:  
**${allergyNote || 'None'}**  
Exclude these allergens from all recipes. Do NOT mention or reference them — just silently avoid them in all meals.

---

✅ Generate the plan for ${weeks}:

${planType === '1 Week' ? `
- A complete 1-week workout plan (7 days: Monday to Sunday)
- A complete 1-week meal plan (each day includes: Breakfast, Lunch, Dinner, Snack)` : `
- A 2-week workout plan (7 days/week, with full details: Week > Day > Exercises)
- A 2-week meal plan (7 days/week, each with 4 meals + full macros)

❗ Write every single day out completely. NO summaries or statements like "continue similar format".
❗ Each day must include unique details. This is for a paid product.
`}

---

📄 FORMAT:
Day [X]:  
Workout:  
- Exercise Name – sets x reps, intensity or weight, form tips  
- ...  
- ...  

Meal:  
- Breakfast: Name + short recipe or ingredients + estimated macros  
- Lunch: ...  
- Dinner: ...  
- Snack: ...

---

STRICT RULES:
- NO tables, bullets, or markdown symbols
- Use clean, plain formatting
- Every meal must show estimated Calories, Protein, Carbs, and Fats
- Do NOT mention allergies — just respect them silently
- Tone: expert, motivating, supportive
- Output must be professional and clean for PDF use
`;
};

app.post('/webhook/shopify', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const shopifyData = JSON.parse(rawBody);

    const email = shopifyData.email;
    const lineItems = shopifyData.line_items || [];

    if (!email || !lineItems.length) return res.status(400).send('Missing order data');

    const bought4Week = lineItems.some(item => item.title.toLowerCase().includes('4 week'));
    const planType = bought4Week ? '4 Week' : '1 Week';

    const token = crypto.randomBytes(16).toString('hex');
    validTokens.set(token, { used: false, email, planType });

    const tallyURL = `https://tally.so/r/wzRD1g?token=${token}`;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.MAIL_USER || 'bulkbotplans@gmail.com',
        pass: process.env.MAIL_PASS
      }
    });

    await transporter.sendMail({
      from: 'BulkBot AI <bulkbotplans@gmail.com>',
      to: email,
      subject: 'Your BulkBot Plan Form Link',
      html: `
        <p>Hi!</p>
        <p>Thanks for your order of the <strong>${planType}</strong> plan.</p>
        <p>To get your custom AI-generated plan, please fill out this form:</p>
        <a href="${tallyURL}">${tallyURL}</a>
        <p>This link is only valid once — please don’t share it.</p>
      `
    });

    console.log(`✅ Token ${token} sent to ${email}`);
    res.status(200).send('Webhook handled');
  } catch (err) {
    console.error('❌ Error in Shopify webhook:', err);
    res.status(500).send('Server error');
  }
});

// Existing code for handleWebhook and tally webhook routes remains unchanged

app.post('/api/tally-webhook/1week', (req, res) => handleWebhook(req, res, '1 Week'));
app.post('/api/tally-webhook/4week', (req, res) => handleWebhook(req, res, '4 Week'));

app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
