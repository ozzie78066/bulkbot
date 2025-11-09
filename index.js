/* === BulkBot server ==================================================== */
/* v3 – dark-theme PDF, auto-styled pages & polished e-mails with Free Trial */
require('dotenv').config();
const express = require('express');
const bodyP = require('body-parser');
const nodemailer = require('nodemailer');
const PDFKit = require('pdfkit');
const crypto = require('crypto');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const yts = require('yt-search');

const app = express();
app.use(bodyP.json());
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------------------------- Video library ---------------------------- */
const libraryPath = path.join(__dirname, 'videoLibrary.json');
let videoLibrary = fs.existsSync(libraryPath) ? require(libraryPath) : {};
function saveLibrary() {
  fs.writeFileSync(libraryPath, JSON.stringify(videoLibrary, null, 2));
}
async function fetchYouTubeLink(query, label) {
  if (videoLibrary[label]) return videoLibrary[label];
  try {
    const r = await yts(query);
    const video = r.videos[0];
    if (video) {
      videoLibrary[label] = video.url;
      saveLibrary();
      return video.url;
    }
    return '';
  } catch (e) {
    console.error('YouTube fetch error:', e);
    return '';
  }
}

/* --------------------------- Token persistence ------------------------- */
const TOKENS_FILE = './tokens.json';
let validTokens = new Map();
if (fs.existsSync(TOKENS_FILE)) {
  try { validTokens = new Map(JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))); console.log('🔐 tokens loaded'); }
  catch (e) { console.error('❌ token load', e); }
}
const saveTokens = () => { try { fs.writeFileSync(TOKENS_FILE, JSON.stringify([...validTokens])); console.log('💾 tokens saved'); } catch (e) { console.error('❌ token save', e); } };

/* --------------------------- Dropdown mapping ------------------------- */
const dropdown = {
  question_7KljZA: {
    '15ac77be-80c4-4020-8e06-6cc9058eb826': 'Gain muscle mass',
    'aa5e8858-f6e1-4535-9ce1-8b02cc652e28': 'Cut (fat loss)',
    'd441804a-2a44-4812-b505-41f63c80d50c': 'Recomp (build muscle / lose fat)',
    'e3a2a823-67ae-4f69-a2b0-8bca4effb500': 'Strength & power',
    '839e27ce-c311-4a7c-adbb-88ce03488614': 'Athletic performance',
    '6b61091e-cecd-4a9b-ad9f-1e871bff8ebd': 'Endurance / fitness',
    '2912e3f7-6122-4a82-91e3-2d5c81f7e89f': 'Toning & sculpting',
    'bce9ebca-f750-4516-99df-44c1e9dc5a03': 'General health & fitness'
  },
  question_6KJ4xB: {
    '68fb3388-c809-4c91-8aa0-edecc63cba67': 'Full gym access',
    '67e66192-f0be-4db6-98a8-a8c3f18364bc': 'Home dumbbells',
    '0a2111b9-efcd-4e52-9ef0-22f104c7d3ca': 'Body-weight workouts only'
  },
  question_qG5pBO: {
    '39195a16-8869-41b9-96e0-6b2159f1a14e': 'home dumbbells',
    '8f19fc4-e16d-400b-b4dc-de4e747c58fe': 'body weight workout only',
    '3f4efea4-48cd-4c14-a377-6e743acc7158': 'full gym access'
  }
};

/* --------------------------- OpenAI prompt builder --------------------- */
const buildPrompt = (info, allergies, plan, part = 1, budget = null) => {
  const span = plan === '4 Week' ? `Weeks ${part === 1 ? '1 and 2' : '3 and 4'}`
              : plan === 'Free 1 Day Trial' ? '1 Day'
              : '1 Week';
  let requestBlock = '';
  if (plan === 'Workout Only') {
    requestBlock = `Generate ${span} as instructed:\n• ${plan === '4 Week' ? '2-week' : '7-day'} workout plan only (no meals).\n• Include sets, reps, intensity, and tips for each exercise.`;
  } else if (plan === 'Meals Only') {
    requestBlock = `Generate ${span} as instructed:\n• ${plan === '4 Week' ? '2-week' : '7-day'} meal plan only (Breakfast, Lunch, Dinner, Snack).\n• Include macros and kcal for each meal.`;
  } else if (plan === 'Free 1 Day Trial') {
    requestBlock = `Generate a 1-day sample plan that shows the quality of your paid plans.\n• Include one full day's worth of both workouts and meals.\n• Keep it concise but realistic.\n• Include kcal and macros for meals.`;
  } else {
    requestBlock = plan === '1 Week'
      ? `• 7-day workout plan (Mon-Sun)\n• 7-day meal plan (Breakfast, Lunch, Dinner, Snack)`
      : `• 2-week workout plan (7 days/week)\n• 2-week meal plan (7 days/week, 4 meals/day + macros)`;
  }
  return `You are a professional fitness and nutrition expert creating personalised PDF workout and meal plans for paying clients. 
Analyze the entire user info and calculate the perfect plan to get them to their goals with new interesting meals and tried and tested workouts.
A customer purchased the **${plan}** plan.

PROFILE
-------
${info}

Allergies / intolerances: **${allergies || 'None'}** (avoid silently)
Weekly meal budget: **${budget || 'No budget'}**

Generate the following:

${requestBlock}

FORMAT (plain text, no markdown symbols):

Day [X]:
Workout:
- Exercise – sets x reps • intensity or load • coaching tip
Meal:
- Breakfast: Name + ingredients + kcal/P/C/F
- Lunch: Name + ingredients + kcal/P/C/F
- Dinner: Name + ingredients + kcal/P/C/F
- Snack: Name + ingredients + kcal/P/C/F

RULES
-----
• Each day unique – no “repeat previous day”
• Show kcal + macros for **every** meal
• Use a friendly, expert tone
• No boring meals, mix it up and keep it interesting, find new recipes
• Calculate meal costs using the user's budget and current food costs. Avoid expensive meals for low-budget users.`;
};

/* --------------------------- PDF helpers ------------------------------ */
const fonts = { header: path.join(__dirname, 'fonts', 'BebasNeue-Regular.ttf'), body: path.join(__dirname, 'fonts', 'Lora-SemiBold.ttf') };
const colours = { bg: '#0f172a', text: '#e2e8f0', accent: '#3b82f6' };
const decorateNewPage = doc => { doc.rect(0, 0, doc.page.width, doc.page.height).fill(colours.bg); doc.fillColor(colours.text); };
const startTitlePage = (doc, user) => {
  decorateNewPage(doc);
  doc.fillColor(colours.accent).font('header').fontSize(38).text(`PERSONAL ${user.plan || 'FITNESS'} PLAN`, { align: 'center', y: 140 });
  doc.image(path.join(__dirname, 'assets/logo.jpg'), doc.page.width / 2 - 90, 215, { width: 180 });
  doc.fillColor(colours.text).font('body').fontSize(14).text(`Name : ${user.name}`, { align: 'center', y: 420 }).text(`Email: ${user.email}`, { align: 'center' }).text(`Allergies: ${user.allergies}`, { align: 'center' });
};
const headerUnderline = (doc, txt) => {
  doc.fillColor(colours.accent).font('header').fontSize(18).text(txt, { align: 'center' });
  const w = doc.widthOfString(txt), x = (doc.page.width - w) / 2, y = doc.y;
  doc.moveTo(x, y + 2).lineTo(x + w, y + 2).stroke(colours.accent);
  doc.moveDown(1);
};

/* --------------------------- Shopify webhook -------------------------- */
app.post('/webhook/shopify', async (req, res) => {
  try {
    const { email, line_items = [] } = req.body;
    if (!email || !line_items.length) return res.status(400).send('Bad order');
    let plan;
    const titleText = line_items.map(i => i.title.toLowerCase()).join(' ');
    if (titleText.includes('4 week')) plan = '4 Week';
    else if (titleText.includes('workout')) plan = 'Workout Only';
    else if (titleText.includes('meal')) plan = 'Meals Only';
    else if (titleText.includes('free') || titleText.includes('trial')) plan = 'Free 1 Day Trial';
    else plan = '1 Week';

    const token = crypto.randomBytes(16).toString('hex');
    validTokens.set(token, { used: false, email, plan }); saveTokens();

    let tallyURL;
    switch (plan) {
      case '4 Week': tallyURL = `https://tally.so/r/wzRD1g?token=${token}&plan=4week`; break;
      case 'Workout Only': tallyURL = `https://tally.so/r/YOUR_WORKOUT_FORM_ID?token=${token}&plan=workout`; break;
      case 'Meals Only': tallyURL = `https://tally.so/r/YOUR_MEALS_FORM_ID?token=${token}&plan=meals`; break;
      case 'Free 1 Day Trial': tallyURL = `https://tally.so/r/GxvQgL?token=${token}&plan=trial`; break;
      default: tallyURL = `https://tally.so/r/wMq9vX?token=${token}&plan=1week`;
    }

    const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } });
    await mail.sendMail({
      from: 'BulkBot AI <bulkbotplans@gmail.com>',
      to: email,
      subject: `Let's build your ${plan} plan – form link inside`,
      html: `<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 0;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:12px;padding:40px">
            <tr><td align="center"><img src="cid:logo" width="120" style="margin-bottom:20px"/></td></tr>
            <tr><td style="font-size:22px;font-weight:bold;color:#3b82f6;text-align:center">Welcome to BulkBot AI</td></tr>
            <tr><td style="padding:20px 0;font-size:16px;text-align:center">
              Thanks for purchasing the <b>${plan}</b> plan.<br>
              Tap the button below to tell us about your goals and preferences.
            </td></tr>
            <tr><td align="center" style="padding-bottom:30px">
              <a href="${tallyURL}" style="background:#3b82f6;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-size:16px">Fill in the form</a>
            </td></tr>
            <tr><td style="font-size:12px;text-align:center;color:#94a3b8">
              This link works once and expires after submission.
            </td></tr>
          </table></td></tr></table>`,
      attachments: [{ filename: 'logo.jpg', path: './assets/logo.jpg', cid: 'logo' }]
    });
    console.log('✅ form link e-mail sent', email);
    res.send('OK');
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

/* --------------------------- Tally webhook handler -------------------- */
const processed = new Set();
const handleWebhook = planType => async (req, res) => {
  try {
    const raw = req.body.data || req.body;

    const budget = raw.fields.find(f => f.label.toLowerCase().includes('meal budget'))?.value || 'No budget';
    console.log('📥 Tally submission', raw.submissionId);
    console.log('🔎 Logging all fields:');
    raw.fields.forEach(f => console.log(`🧾 ${f.label} (${f.key}) →`, f.value));
    if (processed.has(raw.submissionId)) return res.send('duplicate');
    processed.add(raw.submissionId); setTimeout(() => processed.delete(raw.submissionId), 9e5);

    const tokenKeys = {
      '4 Week': 'question_OX4qD8_279a746e-6a87-47a2-af5f-9015896eda25',
      '1 Week': 'question_xDJv8d_25b0dded-df81-4e6b-870b-9244029e451c',
      'Free 1 Day Trial': 'question_TRIAL_123456',   // <-- replace with actual Tally key
      'Workout Only': 'question_WORKOUT_123456',
      'Meals Only': 'question_MEALS_123456'
    };

    const tokenKey = tokenKeys[planType];
    if (!tokenKey) return res.status(400).send('unknown plan type');

    const token = raw.fields.find(f => f.key === tokenKey)?.value;
    const meta = validTokens.get(token);
    if (!meta || meta.used || meta.plan !== planType) return res.status(401).send('bad token');

    // Map dropdowns
    raw.fields.forEach(f => { const map = dropdown[f.key]; if (map && map[f.value]) f.value = map[f.value]; });

    const user = {
      name: raw.fields.find(f => f.label.toLowerCase().includes('name'))?.value || 'Client',
      email: raw.fields.find(f => f.label.toLowerCase().includes('email'))?.value || meta.email,
      allergies: raw.fields.find(f => f.label.toLowerCase().includes('allergies'))?.value || 'None',
      plan: planType
    };
    const info = raw.fields.map(f => Array.isArray(f.value) ? f.value.join(', ') : f.value).join('\n');

    console.log('👤 User info:', user);
    console.log('🧾 Profile summary:\n' + info);

    const ask = async p => {
      console.log('🧠 Sending prompt to OpenAI (chars):', p.length);
      const r = await openai.chat.completions.create({
        model: 'gpt-4o', temperature: 0.4, max_tokens: 10000,
        messages: [{ role: 'system', content: 'You are a fitness & nutrition expert.' }, { role: 'user', content: p }]
      });
      return r.choices[0].message.content;
    };

    const prompt1 = buildPrompt(info, user.allergies, planType, 1, budget);
    const text1 = await ask(prompt1);
    const prompt2 = planType === '4 Week' ? buildPrompt(info, user.allergies, planType, 2, budget) : '';
    const text2 = prompt2 ? await ask(prompt2) : '';
    let full = (text1 + '\n\n' + text2).replace(/\*+/g, '').replace(/(Day\s+\d+:)/g, '\n$1').replace(/(Meal:)/g, '\n$1');

    const lines = full.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*-\s*.+–/.test(lines[i]) && !lines[i].includes('http')) {
        const exercise = lines[i].split('–')[0].replace('-', '').trim();
        const link = await fetchYouTubeLink(exercise + ' exercise tutorial', exercise);
        if (link) lines.splice(i + 1, 0, `Video: ${exercise} Technique`, link);
      }
      if (/^\s*-\s*(Breakfast|Lunch|Dinner|Snack)/.test(lines[i]) && !lines[i].includes('http')) {
        const meal = lines[i].split(':')[1]?.split('+')[0]?.trim();
        if (meal) {
          const link = await fetchYouTubeLink(meal + ' recipe', meal);
          if (link) lines.splice(i + 1, 0, `Video: ${meal} Recipe`, link);
        }
      }
    }
    full = lines.join('\n');

    // PDF generation
    const doc = new PDFKit({ margin: 50 });
    doc.registerFont('header', fonts.header);
    doc.registerFont('body', fonts.body);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('pageAdded', () => { decorateNewPage(doc); });
    startTitlePage(doc, user);
    doc.addPage();
    headerUnderline(doc, 'YOUR PLAN');
    doc.font('body').fontSize(12).fillColor(colours.text).text(full, { align: 'left', lineGap: 6 });
    doc.end();
    const pdfBuffer = Buffer.concat(chunks);
    console.log('📄 PDF generated, bytes:', pdfBuffer.length);

    // Send email with PDF
    const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } });
    await mail.sendMail({
      from: 'BulkBot AI <bulkbotplans@gmail.com>',
      to: user.email,
      subject: `Your ${planType} plan is ready!`,
      html: `<p>Hey ${user.name},</p><p>Your ${planType} plan is ready. Download your PDF attached.</p>`,
      attachments: [{ filename: `${planType}_Plan.pdf`, content: pdfBuffer }]
    });

    validTokens.set(token, { ...meta, used: true });
    saveTokens();
    console.log('✉️ Plan sent to', user.email);

    res.send('ok');
  } catch (e) { console.error(e); res.status(500).send('error'); }
};

/* --------------------------- Tally webhook routes -------------------- */
app.post('/api/tally-webhook/1week', handleWebhook('1 Week'));
app.post('/api/tally-webhook/4week', handleWebhook('4 Week'));
app.post('/api/tally-webhook/trial', handleWebhook('Free 1 Day Trial'));
app.post('/api/tally-webhook/workout', handleWebhook('Workout Only'));
app.post('/api/tally-webhook/meals', handleWebhook('Meals Only'));

/* --------------------------- Server start ---------------------------- */
app.listen(process.env.PORT || 3000, () => console.log('🚀 BulkBot server running'));
