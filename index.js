/* === BulkBot server ==================================================== */
/* v3 – dark-theme PDF, auto-styled pages & polished e-mails              */
require('dotenv').config();
const express   = require('express');
const bodyP     = require('body-parser');
const nodemailer= require('nodemailer');
const PDFKit    = require('pdfkit');
const crypto    = require('crypto');
const { OpenAI }= require('openai');
const fs        = require('fs');
const path      = require('path');
const yts = require('yt-search');


const libraryPath = path.join(__dirname, 'videoLibrary.json');
let videoLibrary = require(libraryPath);

// Save updated library to disk
function saveLibrary() {
  fs.writeFileSync(libraryPath, JSON.stringify(videoLibrary, null, 2));
}

async function fetchYouTubeLink(query, label) {
  // 1. Check local library first
  if (videoLibrary[label]) {
    return videoLibrary[label];
  }

  try {
    // 2. Search YouTube
    const r = await yts(query);
    const video = r.videos[0];
    if (video) {
      const link = video.url;
      // 3. Cache it
      videoLibrary[label] = link;
      saveLibrary();
      return link;
    }
    return '';
  } catch (e) {
    console.error('YouTube fetch error:', e);
    return '';
  }
}

/* ---------------------------------------------------------------------- */
/* ── basic app & helpers ──────────────────────────────────────────────── */
const app   = express();
const openai= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(bodyP.json());



/* ---------------------------------------------------------------------- */
/* ── token persistence ───────────────────────────────────────────────── */
const TOKENS_FILE='./tokens.json';
let validTokens=new Map();
if(fs.existsSync(TOKENS_FILE)){
  try{ validTokens=new Map(JSON.parse(fs.readFileSync(TOKENS_FILE,'utf8')));
      console.log('🔐 tokens loaded'); }
  catch(e){ console.error('❌ token load',e);}
}
const saveTokens=()=>{try{
  fs.writeFileSync(TOKENS_FILE,JSON.stringify([...validTokens]));
  console.log('💾 tokens saved');
}catch(e){console.error('❌ token save',e);}};

/* ---------------------------------------------------------------------- */
/* ── dropdown mappings (unchanged) ───────────────────────────────────── */
const dropdown={
  question_7KljZA:{
    '15ac77be-80c4-4020-8e06-6cc9058eb826':'Gain muscle mass',
    'aa5e8858-f6e1-4535-9ce1-8b02cc652e28':'Cut (fat loss)',
    'd441804a-2a44-4812-b505-41f63c80d50c':'Recomp (build muscle / lose fat)',
    'e3a2a823-67ae-4f69-a2b0-8bca4effb500':'Strength & power',
    '839e27ce-c311-4a7c-adbb-88ce03488614':'Athletic performance',
    '6b61091e-cecd-4a9b-ad9f-1e871bff8ebd':'Endurance / fitness',
    '2912e3f7-6122-4a82-91e3-2d5c81f7e89f':'Toning & sculpting',
    'bce9ebca-f750-4516-99df-44c1e9dc5a03':'General health & fitness'
  },
  question_6KJ4xB:{
    '68fb3388-c809-4c91-8aa0-edecc63cba67':'Full gym access', 
    '67e66192-f0be-4db6-98a8-a8c3f18364bc':'Home dumbbells',
    '0a2111b9-efcd-4e52-9ef0-22f104c7d3ca':'Body-weight wrokouts only'
  },
  question_qG5pBO:{
    '39195a16-8869-41b9-96e0-6b2159f1a14e':'home dumbells ',
    '8f19fc4a-e16d-400b-b4dc-de4e747c58fe':'body weight workout only',
    '3f4efea4-48cd-4c14-a377-6e743acc7158':'full gym access'
  }
};

/* ---------------------------------------------------------------------- */
/* ── OpenAI prompt builder (unchanged) ───────────────────────────────── */
const buildPrompt = (info, allergies, plan, part = 1, budget = null) => {
  const span =
  plan === '4 Week'
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

/* ---------------------------------------------------------------------- */    
/* ── PDF style helpers ───────────────────────────────────────────────── */
const fonts={
  header:path.join(__dirname,'fonts','BebasNeue-Regular.ttf'),
  body  :path.join(__dirname,'fonts','Lora-SemiBold.ttf')
};
const colours={ bg:'#0f172a', text:'#e2e8f0', accent:'#3b82f6' };

const decorateNewPage=doc=>{
  doc.rect(0,0,doc.page.width,doc.page.height).fill(colours.bg);
  doc.fillColor(colours.text);
  
};

const startTitlePage=(doc,user)=>{
  decorateNewPage(doc);
  doc.fillColor(colours.accent)
     .font('header').fontSize(38)
     .text(`PERSONAL ${user.plan || 'FITNESS'} PLAN`,{align:'center',y:140});
  doc.image(path.join(__dirname,'assets','logo.jpg'),
            doc.page.width/2-90, 215,{width:180});
  doc.fillColor(colours.text)
     .font('body').fontSize(14)
     .text(`Name : ${user.name}`,  {align:'center',y:420})
     .text(`Email: ${user.email}`, {align:'center'})
     .text(`Allergies: ${user.allergies}`, {align:'center'});
};

const headerUnderline=(doc,txt)=>{
  doc.fillColor(colours.accent)
     .font('header').fontSize(18).text(txt,{align:'center'});
  const w=doc.widthOfString(txt), x=(doc.page.width-w)/2, y=doc.y;
  doc.moveTo(x,y+2).lineTo(x+w,y+2).stroke(colours.accent);
  doc.moveDown(1);
  
};

/* ---------------------------------------------------------------------- */
/* ── Shopify webhook – send form link e-mail ─────────────────────────── */
app.post('/webhook/shopify',async(req,res)=>{
try{
  const { email, line_items=[] }=req.body;
  if(!email||!line_items.length){return res.status(400).send('Bad order');}
  let plan;
const titleText = line_items.map(i=>i.title.toLowerCase()).join(' ');
if (titleText.includes('4 week')) plan = '4 Week';
else if (titleText.includes('workout')) plan = 'Workout Only';
else if (titleText.includes('meal')) plan = 'Meals Only';
else if (titleText.includes('free') || titleText.includes('trial')) plan = 'Free 1 Day Trial';
else plan = '1 Week';
  const token=crypto.randomBytes(16).toString('hex');
  validTokens.set(token,{used:false,email,plan}); saveTokens();
  let tallyURL;
switch (plan) {
  case '4 Week': 
    tallyURL = `https://tally.so/r/wzRD1g?token=${token}&plan=4week`; 
    break;
  case 'Workout Only': 
    tallyURL = `https://tally.so/r/YOUR_WORKOUT_FORM_ID?token=${token}&plan=workout`; 
    break;
  case 'Meals Only': 
    tallyURL = `https://tally.so/r/YOUR_MEALS_FORM_ID?token=${token}&plan=meals`; 
    break;
  case 'Free 1 Day trial': 
    tallyURL = `https://tally.so/r/GxvQgL?token=${token}&plan=trial`; 
    break;
  default: 
    tallyURL = `https://tally.so/r/wMq9vX?token=${token}&plan=1week`; 
}

  const mail=nodemailer.createTransport({
      service:'gmail', auth:{user:process.env.MAIL_USER,pass:process.env.MAIL_PASS}});
  await mail.sendMail({
    from:'BulkBot AI <bulkbotplans@gmail.com>',
    to:email,
    subject:`Let's build your ${plan} plan – form link inside`,
    html:`<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 0;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif">
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
    attachments:[{filename:'logo.jpg',path:'./assets/logo.jpg',cid:'logo'}]
  });
  console.log('✅ form link e-mail sent', email);
  res.send('OK');
}catch(e){console.error(e); res.status(500).send('Server error');}
});

/* ---------------------------------------------------------------------- */
/* ── Tally webhook handler factory ───────────────────────────────────── */

const processed=new Set();

const handleWebhook=planType=>async(req,res)=>{
try{
  const raw=req.body.data||req.body;
  
  const budget = raw.fields.find(f =>
    f.label.toLowerCase().includes('meal budget')
  )?.value || 'No budget';
  
  console.log('📥 Tally submission', raw.submissionId);
  console.log('🔎 Logging all field keys and labels:');
raw.fields.forEach(f => {
  console.log(`🧾 Field: ${f.label} (${f.key}) →`, f.value);
});
  if(processed.has(raw.submissionId)) return res.send('duplicate');
  processed.add(raw.submissionId); setTimeout(()=>processed.delete(raw.submissionId),9e5);

  // Map each plan type to its Tally hidden token field key 
const tokenKeys = {
  '4 Week': 'question_OX4qD8_279a746e-6a87-47a2-af5f-9015896eda25',
  '1 Week': 'question_xDJv8d_25b0dded-df81-4e6b-870b-9244029e451c',
  'Free 1 Day Trial': 'question_ABC123_...',       // replace with actual Tally key
  'Workout-only': 'question_DEF456_...', // replace with actual Tally key
  'Meals-only': 'question_GHI789_...',   // replace with actual Tally key
};
app.post('/webhook', (req, res) => {
  console.log('Webhook payload:', req.body); // <-- log the entire incoming data
  res.sendStatus(200);
});
// Lookup the token key for the current plan type
const tokenKey = tokenKeys[planType];
if (!tokenKey) return res.status(400).send('unknown plan type');

// Find the token value in the webhook fields
const token = raw.fields.find(f => f.key === tokenKey)?.value;

// Validate the token
const meta = validTokens.get(token);
if (!meta || meta.used || meta.plan !== planType) {
  return res.status(401).send('bad token');
}

// Map dropdown values as before
raw.fields.forEach(f => {
  const map = dropdown[f.key];
  if (map && map[f.value]) f.value = map[f.value];
});

  const user={
    name : raw.fields.find(f=>f.label.toLowerCase().includes('name'))?.value||'Client',
    email: raw.fields.find(f=>f.label.toLowerCase().includes('email'))?.value || meta.email,
    allergies: raw.fields.find(f=>f.label.toLowerCase().includes('allergies'))?.value||'None'
  };
  user.plan = planType;
  const info=raw.fields.map(f=>{
      const v=Array.isArray(f.value)?f.value.join(', '):f.value;
      return `${f.label}: ${v}`;}).join('\n');
  console.log('👤 User info:', user);
  console.log('🧾 Profile summary:\n'+info);

  const ask=async p=>{
    console.log('🧠 Sending prompt to OpenAI (chars):', p.length);
    const r=await openai.chat.completions.create({
      model:'gpt-4o',temperature:0.4,max_tokens:10000,
      messages:[{role:'system',content:'You are a fitness & nutrition expert.'},
                {role:'user',content:p}]});
    return r.choices[0].message.content;
  };

  const prompt1 = buildPrompt(info, user.allergies, planType, 1, budget);
  console.log('🧠 Prompt preview:\n'+prompt1);
  const text1 = await ask(prompt1);
  const prompt2 = planType==='4 Week' ? buildPrompt(info, user.allergies, planType, 2, budget) : '';
  if (prompt2) console.log('🧠 Prompt preview (Week 3/4):\n'+prompt2);
  const text2 = prompt2 ? await ask(prompt2) : '';
  let full=text1+'\n\n'+text2;
  full=full.replace(/\*+/g,'');
  full=full.replace(/(Day\s+\d+:)/g,'\n$1');
  full=full.replace(/(Meal:)/g,'\n$1');
  console.log('📝 Plan text length:', full.length);
  const lines = full.split('\n');
for (let i = 0; i < lines.length; i++) {
  // Workout line
  if (/^\s*-\s*.+–/.test(lines[i]) && !lines[i].includes('http')) {
    const exercise = lines[i].split('–')[0].replace('-', '').trim();
    const link = await fetchYouTubeLink(exercise + ' exercise tutorial', exercise);
    if (link) {
      lines.splice(i + 1, 0, `Video: ${exercise} Technique`, link);
    }
  }

  // Meal line
  if (/^\s*-\s*(Breakfast|Lunch|Dinner|Snack)/.test(lines[i]) && !lines[i].includes('http')) {
    const meal = lines[i].split(':')[1]?.split('+')[0]?.trim();
    if (meal) {
      const link = await fetchYouTubeLink(meal + ' recipe', meal);
      if (link) {
        lines.splice(i + 1, 0, `Video: ${meal} Recipe`, link);
      }
    }
  }
}
full = lines.join('\n');


  const doc = new PDFKit({ margin: 50 });
doc.registerFont('header', fonts.header);
doc.registerFont('body', fonts.body);

const chunks = [];
doc.on('data', c => chunks.push(c));
doc.on('pageAdded', () => { decorateNewPage(doc); });

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
          <tr><td style="font-size:14px;text-align:center;color:#94a3b8">
            Crush your goals – we're cheering you on! 💪
          </td></tr>
        </table></td></tr></table>`,
    attachments: [
      { filename: 'Plan.pdf', content: pdf },
      { filename: 'logo.jpg', path: './assets/logo.jpg', cid: 'logo' }
    ]
  });

  meta.used = true;
  saveTokens();
  console.log('📤 plan e-mailed to', user.email);
  res.send('PDF sent');
});

startTitlePage(doc, user);
doc.addPage();
decorateNewPage(doc);
headerUnderline(doc, 'Week 1');
doc.moveDown(0.5);

lines.forEach(line => {
  // Workout / Exercise
  if (/^\s*-\s*.+–/.test(line)) {
    const parts = line.split('–');
    doc.font('body').fontSize(14).fillColor('#3b82f6')
       .text(parts[0].replace('-', '').trim() + ':', {continued: true});
    doc.fillColor(colours.text)
       .text(' ' + parts[1].trim(), {lineGap: 6});
    doc.moveDown(0.5);
  }
  // Meal
  else if (/^\s*-\s*(Breakfast|Lunch|Dinner|Snack)/.test(line)) {
    const parts = line.split(':');
    doc.font('body').fontSize(14).fillColor('#3b82f6')
       .text(parts[0].trim() + ':', {continued: true});
    doc.fillColor(colours.text)
       .text(parts.slice(1).join(':').trim(), {lineGap: 6});
    doc.moveDown(0.5);
  }
  // Video links
  else if (/^Video:/.test(line)) {
    doc.font('body').fontSize(12).fillColor('#facc15')
       .text(line, {link: line.includes('http') ? line : undefined});
    doc.moveDown(0.3);
  }
  // Any other text
  else if (line.trim() !== '') {
    doc.font('body').fontSize(12).fillColor(colours.text)
       .text(line);
    doc.moveDown(0.3);
  }
});



doc.moveDown();
doc.fontSize(12).fillColor(colours.text).text(
  'Stay hydrated, consistent & rested – results will come.',
  { align: 'center' }
);

doc.end();



}catch(e){console.error('❌ Tally handler',e); res.status(500).send('err');}
};

app.post('/api/tally-webhook/1week',handleWebhook('1 Week'));
app.post('/api/tally-webhook/4week',handleWebhook('4 Week'));
app.post('/api/tally-webhook/trial', handleWebhook('Free 1 Day Trial'));

app.listen(3000,()=>console.log('🚀 BulkBot live on :3000'));
