/* === BulkBot server v4 – fully async, multi-plan PDF generator === */
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const PDFKit = require('pdfkit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const yts = require('yt-search');

const libraryPath = path.join(__dirname, 'videoLibrary.json');
let videoLibrary = fs.existsSync(libraryPath)
  ? require(libraryPath)
  : {};

const saveLibrary = () => fs.writeFileSync(libraryPath, JSON.stringify(videoLibrary, null, 2));

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

/* --- Express app & OpenAI --- */
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(bodyParser.json());

/* --- Token persistence --- */
const TOKENS_FILE = './tokens.json';
let validTokens = new Map();
if (fs.existsSync(TOKENS_FILE)) {
  try {
    validTokens = new Map(JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')));
    console.log('🔐 Tokens loaded');
  } catch (e) { console.error('❌ Token load error', e); }
}
const saveTokens = () => {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify([...validTokens]));
    console.log('💾 Tokens saved');
  } catch (e) { console.error('❌ Token save error', e); }
};

/* --- Dropdown mappings --- */
const dropdown = {
  question_7KljZA: { /* example mapping */ },
  question_6KJ4xB: { /* example mapping */ },
  question_qG5pBO: { /* example mapping */ }
};

/* --- PDF helpers --- */
const fonts = {
  header: path.join(__dirname, 'fonts', 'BebasNeue-Regular.ttf'),
  body: path.join(__dirname, 'fonts', 'Lora-SemiBold.ttf')
};
const colours = { bg: '#0f172a', text: '#e2e8f0', accent: '#3b82f6' };

const decorateNewPage = doc => {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(colours.bg);
  doc.fillColor(colours.text);
};

const startTitlePage = (doc, user) => {
  decorateNewPage(doc);
  doc.fillColor(colours.accent)
    .font('header').fontSize(38)
    .text(`PERSONAL ${user.plan || 'FITNESS'} PLAN`, { align: 'center', y: 140 });
  doc.image(path.join(__dirname, 'assets', 'logo.jpg'),
    doc.page.width / 2 - 90, 215, { width: 180 });
  doc.fillColor(colours.text)
    .font('body').fontSize(14)
    .text(`Name : ${user.name}`, { align: 'center', y: 420 })
    .text(`Email: ${user.email}`, { align: 'center' })
    .text(`Allergies: ${user.allergies}`, { align: 'center' });
};

const headerUnderline = (doc, txt) => {
  doc.fillColor(colours.accent).font('header').fontSize(18).text(txt, { align: 'center' });
  const w = doc.widthOfString(txt), x = (doc.page.width - w) / 2, y = doc.y;
  doc.moveTo(x, y + 2).lineTo(x + w, y + 2).stroke(colours.accent);
  doc.moveDown(1);
};

/* --- Prompt builder --- */
const buildPrompt = (info, allergies, plan, part = 1, budget = null) => {
  const span = plan === '4 Week'
    ? `Weeks ${part === 1 ? '1 and 2' : '3 and 4'}`
    : plan === 'Free 1 Day Trial'
      ? '1 Day'
      : '1 Week';
  let requestBlock = '';
  if (plan === 'Workout Only') {
    requestBlock = `Generate ${span} as instructed:
• ${plan === '4 Week' ? '2-week' : '7-day'} workout plan only (no meals).
• Include sets, reps, intensity, and tips for each exercise.`;
  } else if (plan === 'Meals Only') {
    requestBlock = `Generate ${span} as instructed:
• ${plan === '4 Week' ? '2-week' : '7-day'} meal plan only (Breakfast, Lunch, Dinner, Snack).
• Include macros and kcal for each meal.`;
  } else if (plan === 'Free 1 Day Trial') {
    requestBlock = `Generate a 1-day sample plan that shows the quality of your paid plans.
• Include one full day's worth of both workouts and meals.
• Keep it concise but realistic.
• Include kcal and macros for meals.`;
  } else {
    requestBlock = plan === '1 Week'
      ? `• 7-day workout plan (Mon-Sun)
• 7-day meal plan (Breakfast, Lunch, Dinner, Snack)`
      : `• 2-week workout plan (7 days/week)
• 2-week meal plan (7 days/week, 4 meals/day + macros)`;
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
• Calculate meal costs using the user's budget and current food costs. Avoid expensive meals for low-budget users.
`;
};

/* --- Webhook processing --- */
const processed = new Set();

const handleWebhook = planType => async (req, res) => {
  try {
    const raw = req.body.data || req.body;

    // --- Log everything for debugging ---
    console.log('📥 Tally submission received:', raw.submissionId);
    console.log('🧾 Full payload:', JSON.stringify(raw, null, 2));

    if (processed.has(raw.submissionId)) return res.send('duplicate');
    processed.add(raw.submissionId);
    setTimeout(() => processed.delete(raw.submissionId), 9e5);

    // --- Map token keys (replace with your actual Tally keys) ---
    const tokenKeys = {
      '4 Week': 'question_OX4qD8_279a746e-6a87-47a2-af5f-9015896eda25',
      '1 Week': 'question_xDJv8d_25b0dded-df81-4e6b-870b-9244029e451c',
      'Free 1 Day Trial': 'question_ABC123_...',
      'Workout Only': 'question_DEF456_...',
      'Meals Only': 'question_GHI789_...'
    };
    const tokenKey = tokenKeys[planType];
    if (!tokenKey) return res.status(400).send('unknown plan type');

    const token = raw.fields.find(f => f.key === tokenKey)?.value;
    const meta = validTokens.get(token);
    if (!meta || meta.used || meta.plan !== planType) return res.status(401).send('bad token');

    raw.fields.forEach(f => {
      const map = dropdown[f.key];
      if (map && map[f.value]) f.value = map[f.value];
    });

    // --- Build user object & profile string ---
    const user = {
      name: raw.fields.find(f => f.label.toLowerCase().includes('name'))?.value || 'Client',
      email: raw.fields.find(f => f.label.toLowerCase().includes('email'))?.value || meta.email,
      allergies: raw.fields.find(f => f.label.toLowerCase().includes('allergies'))?.value || 'None',
      plan: planType
    };

    const info = raw.fields.map(f => {
      const v = Array.isArray(f.value) ? f.value.join(', ') : f.value;
      return `${f.label}: ${v}`;
    }).join('\n');

    console.log('👤 User info:', user);
    console.log('🧾 Profile summary:\n' + info);

    const budget = raw.fields.find(f =>
      f.label.toLowerCase().includes('meal budget')
    )?.value || 'No budget';

    // --- Helper to call OpenAI ---
    const ask = async p => {
      console.log('🧠 Sending prompt to OpenAI (chars):', p.length);
      const r = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.4,
        max_tokens: 10000,
        messages: [
          { role: 'system', content: 'You are a fitness & nutrition expert.' },
          { role: 'user', content: p }
        ]
      });
      return r.choices[0].message.content;
    };

    // --- Build and fetch plan(s) ---
    const prompts = [buildPrompt(info, user.allergies, planType, 1, budget)];
    if (planType === '4 Week') prompts.push(buildPrompt(info, user.allergies, planType, 2, budget));

    let full = '';
    for (const p of prompts) {
      const text = await ask(p);
      full += text + '\n\n';
    }

    full = full.replace(/\*+/g, '');
    full = full.replace(/(Day\s+\d+:)/g, '\n$1');
    full = full.replace(/(Meal:)/g, '\n$1');

    const lines = full.split('\n');

    // --- Async YouTube links safely ---
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Workout
      if (/^\s*-\s*.+–/.test(line) && !line.includes('http')) {
        const exercise = line.split('–')[0].replace('-', '').trim();
        const link = await fetchYouTubeLink(exercise + ' exercise tutorial', exercise);
        if (link) lines.splice(i + 1, 0, `Video: ${exercise} Technique`, link);
      }

      // Meal
      if (/^\s*-\s*(Breakfast|Lunch|Dinner|Snack)/.test(line) && !line.includes('http')) {
        const meal = line.split(':')[1]?.split('+')[0]?.trim();
        if (meal) {
          const link = await fetchYouTubeLink(meal + ' recipe', meal);
          if (link) lines.splice(i + 1, 0, `Video: ${meal} Recipe`, link);
        }
      }
    }

    // --- Generate PDF ---
    const doc = new PDFKit({ margin: 50 });
    doc.registerFont('header', fonts.header);
    doc.registerFont('body', fonts.body);

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('pageAdded', () => decorateNewPage(doc));

    startTitlePage(doc, user);
    headerUnderline(doc, 'Week 1');
    doc.addPage();
    decorateNewPage(doc);
    headerUnderline(doc, 'Week 2');

    lines.forEach(line => {
      if (/^\s*-\s*.+–/.test(line)) {
        const parts = line.split('–');
        doc.font('body').fontSize(14).fillColor('#3b82f6')
          .text(parts[0].replace('-', '').trim() + ':', { continued: true });
        doc.fillColor(colours.text).text(' ' + parts[1].trim(), { lineGap: 6 });
        doc.moveDown(0.5);
      } else if (/^\s*-\s*(Breakfast|Lunch|Dinner|Snack)/.test(line)) {
        const parts = line.split(':');
        doc.font('body').fontSize(14).fillColor('#3b82f6')
          .text(parts[0].trim() + ':', { continued: true });
        doc.fillColor(colours.text).text(parts.slice(1).join(':').trim(), { lineGap: 6 });
        doc.moveDown(0.5);
      } else if (/^Video:/.test(line)) {
        doc.font('body').fontSize(12).fillColor('#facc15')
          .text(line, { link: line.includes('http') ? line : undefined });
        doc.moveDown(0.3);
      } else if (line.trim() !== '') {
        doc.font('body').fontSize(12).fillColor(colours.text)
          .text(line);
        doc.moveDown(0.3);
      }
    });

    doc.moveDown();
    doc.fontSize(12).fillColor(colours.text)
      .text('Stay hydrated, consistent & rested – results will come.', { align: 'center' });
    doc.end();

    doc.on('end', async () => {
      const pdf = Buffer.concat(chunks);
      console.log('📎 PDF size (bytes):', pdf.length);

      const mail = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
      });

      await mail.sendMail({
        from: 'BulkBot AI <bulkbotplans@gmail.com>',
        to: user.email,
        subject: 'Your personalised BulkBot plan 📦',
        html: `<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 0;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:12px;padding:40px">
              <tr><td align="center"><img src="cid:logo" width="120" style="margin-bottom:20px"/></td></tr>
              <tr><td style="font-size:22px;font-weight:bold;color:#3b82f6;text-align:center">Your plan is ready!</td></tr>
              <tr><td style="padding:20px 0;font-size:16px;text-align:center">
                Hi ${user.name},<br>find your customised workout & meal plan attached.
              </td></tr>
            </table></td></tr></table>`,
        attachments: [
          { filename: 'Plan.pdf', content: pdf },
          { filename: 'logo.jpg', path: './assets/logo.jpg', cid: 'logo' }
        ]
      });

      meta.used = true;
      saveTokens();
      console.log('📤 Plan e-mailed to', user.email);
      res.send('PDF sent');
    });

  } catch (e) {
    console.error('❌ Tally handler error', e);
    res.status(500).send('err');
  }
};

/* --- Webhook endpoints --- */
app.post('/api/tally-webhook/1week', handleWebhook('1 Week'));
app.post('/api/tally-webhook/4week', handleWebhook('4 Week'));
app.post('/api/tally-webhook/trial', handleWebhook('Free 1 Day Trial'));
app.post('/api/tally-webhook/workout', handleWebhook('Workout Only'));
app.post('/api/tally-webhook/meals', handleWebhook('Meals Only'));

app.listen(3000, () => console.log('🚀 BulkBot live on :3000'));
