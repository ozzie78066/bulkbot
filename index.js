/* -----------------------------  BulkBot server  ----------------------------- */
/*   A single-file Express service that:                                        *
 *   1. Receives a Shopify “order paid” webhook, mails the buyer a one-time     *
 *      Tally form link that carries a secure token.                            *
 *   2. Receives the Tally response, validates + locks the token,               *
 *      sends the user profile to GPT-4o, builds a beautiful PDF,               *
 *      and emails it back to the customer.                                     *
 *   3. Persists unused/used tokens in tokens.json so redeploys are safe.       */

require('dotenv').config();
const express   = require('express');
const bodyP     = require('body-parser');
const nodemailer= require('nodemailer');
const PDFKit    = require('pdfkit');
const crypto    = require('crypto');
const { OpenAI }= require('openai');
const fs        = require('fs');
const path      = require('path');

const PORT = process.env.PORT || 3000;
const app  = express();
const open = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(bodyP.json());

/* ─────────────────────── 1. Token persistence ─────────────────────────── */
const TOKENS_FILE = './tokens.json';
let   tokens = new Map();                     // token  → { used,email,plan }
if (fs.existsSync(TOKENS_FILE)) {
  try {
    tokens = new Map(JSON.parse(fs.readFileSync(TOKENS_FILE,'utf-8')));
    console.log('🔐  Loaded tokens:', tokens.size);
  } catch (e) { console.error('❌  Could not parse tokens.json', e); }
}
function saveTokens() {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify([...tokens])); }
  catch(e){ console.error('❌  Saving tokens failed', e); }
}

/* ─────────────────────── 2. Dropdown → text maps ──────────────────────── */
const dropdown = {
  question_7KljZA : { // fitness goal
    '15ac77be-80c4-4020-8e06-6cc9058eb826':'Gain muscle mass',
    'aa5e8858-f6e1-4535-9ce1-8b02cc652e28':'Cut (fat-loss)',
    'd441804a-2a44-4812-b505-41f63c80d50c':'Recomp (build muscle, lose fat)',
    'e3a2a823-67ae-4f69-a2b0-8bca4effb500':'Strength & power',
    '839e27ce-c311-4a7c-adbb-88ce03488614':'Athletic performance',
    '6b61091e-cecd-4a9b-ad9f-1e871bff8ebd':'Endurance / cardio fitness',
    '2912e3f7-6122-4a82-91e3-2d5c81f7e89f':'Toning & sculpting',
    'bce9ebca-f750-4516-99df-44c1e9dc5a03':'General health & fitness'
  },
  question_6KJ4xB : { // equipment access
    '68fb3388-c809-4c91-8aa0-edecc63cba67':'Full gym access',
    '67e66192-f0be-4db6-98a8-a8c3f18364bc':'Home dumbbells / bands',
    '0a2111b9-efcd-4e52-9ef0-22f104c7d3ca':'Body-weight only'
  }
};

/* ─────────────────────── 3. PDF theme helpers ─────────────────────────── */
const FONT_HEADER = path.join(__dirname,'fonts','BebasNeue-Regular.ttf');
const FONT_BODY   = path.join(__dirname,'fonts','Lora-SemiBold.ttf');
const COLOR       = { bg:'#0f172a', text:'#e2e8f0', accent:'#3b82f6' };

function paintBackground(doc) {
  doc.save();
  doc.rect(0,0,doc.page.width,doc.page.height).fill(COLOR.bg);
  doc.restore();
  doc.fillColor(COLOR.text);
}
function titlePage(doc, user) {
  paintBackground(doc);
  doc.fillColor(COLOR.accent)
     .font('header').fontSize(40)
     .text('PERSONAL GYM & MEAL PLAN', { align:'center', y: 140 });

  doc.image(path.join(__dirname,'assets','logo.jpg'),
            doc.page.width/2-90, 215, { width:180 });

  doc.fillColor(COLOR.text)
     .font('body').fontSize(14);
  const startY = 420;
  doc.text(`Name   : ${user.name}`,   0, startY, { align:'center' });
  doc.text(`Email  : ${user.email}`,                { align:'center' });
  doc.text(`Allergies: ${user.allergies}`,          { align:'center' });
}
function newContentPage(doc) {
  doc.addPage({ margin:40 });
  paintBackground(doc);
}
function weekHeader(doc, n) {
  const txt = `Week ${n}`;
  doc.fillColor(COLOR.accent).font('header').fontSize(20)
     .text(txt, { align:'center' });
  const w = doc.widthOfString(txt);
  const x = (doc.page.width - w)/2, y = doc.y;
  doc.moveTo(x, y+2).lineTo(x+w, y+2).stroke(COLOR.accent);
  doc.moveDown(1.5);
}

/* ─────────────────────── 4. AI prompt builder ─────────────────────────── */
function buildPrompt(info, allergies, planType, part=1) {
  const span = planType==='4 Week'
      ? `Weeks ${part===1?'1 and 2':'3 and 4'}`
      : '1 Week';

  return `You are a professional fitness and nutrition expert creating personalized PDF workout and meal plans for paying clients.

Customer purchased the **${planType}** plan.

Profile:
${info}

Allergies/intolerances → **${allergies||'None'}** (avoid silently).

Generate the plan for **${span}** using PLAIN TEXT (no bullets / no markdown):

Day [X]:
Workout:
- Exercise – sets x reps • intensity/load • form tip
Meal:
- Breakfast: Name + ingredients + Calories / Protein / Carbs / Fats
(Lunch / Dinner / Snack structured the same)

Rules:
- Every day must be unique.
- Show calories & macros for every meal.
- Friendly expert tone suitable for a premium PDF.
`;
}

/* ─────────────────────── 5. Shopify order webhook ─────────────────────── */
app.post('/webhook/shopify', async (req,res)=>{
  try{
    const { email, line_items=[] } = req.body;
    if(!email || !line_items.length) return res.status(400).send('missing data');
    const plan  = line_items.some(i=>i.title.toLowerCase().includes('4 week'))
                 ? '4 Week' : '1 Week';
    const token = crypto.randomBytes(16).toString('hex');
    tokens.set(token, { used:false, email, plan });
    saveTokens();

    const tally = plan==='4 Week'
      ? `https://tally.so/r/wzRD1g?token=${token}&plan=4week`
      : `https://tally.so/r/wMq9vX?token=${token}&plan=1week`;

    /* ---------- send “form link” email ---------- */
    const mail = nodemailer.createTransport({
      service:'gmail',
      auth:{ user:process.env.MAIL_USER, pass:process.env.MAIL_PASS }
    });

    const formHTML = `
      <div style="font-family:Inter,Arial,sans-serif;padding:32px;max-width:600px;margin:auto;
                  background:#0f172a;color:#e2e8f0;border-radius:12px">
        <img src="cid:logo" style="width:100px;margin:auto;display:block"/>
        <h2 style="text-align:center;color:#3b82f6;margin-top:24px">
            Welcome to BulkBot!</h2>
        <p style="font-size:15px;line-height:1.6">
           Thanks for purchasing the <b>${plan}</b> programme.<br>
           To build your personalised plan please complete this short form
           (link works <b>once</b> for security):
        </p>
        <p style="text-align:center;margin:30px 0">
          <a href="${tally}"
             style="background:#3b82f6;color:#fff;padding:14px 28px;
                    border-radius:8px;text-decoration:none;font-weight:600;
                    display:inline-block">Open Form 🔗</a>
        </p>
        <p style="font-size:13px;color:#94a3b8;text-align:center">
           Need help? Reply to this email any time.
        </p>
      </div>`;

    await mail.sendMail({
      from:'BulkBot AI <bulkbotplans@gmail.com>',
      to: email,
      subject:'Secure link – tell us about yourself',
      html:formHTML,
      attachments:[{
        filename:'logo.jpg',path:'./assets/logo.jpg',cid:'logo'
      }]
    });
    console.log('📧  Form-link email sent to', email);
    res.send('ok');
  }catch(e){ console.error('❌  Shopify hook',e); res.status(500).send('err'); }
});

/* ─────────────────────── 6. Tally webhooks (1 & 4 week) ───────────────── */
const dedupe = new Set();               // ignore accidental double posts
function tallyRoute(planType){
return async (req,res)=>{
 try{
   const body = req.body.data || req.body;
   console.log('📥  Tally submission', body.submissionId);
   if(dedupe.has(body.submissionId)){ console.log('↩️ dup'); return res.send('dup'); }
   dedupe.add(body.submissionId); setTimeout(()=>dedupe.delete(body.submissionId), 300000);

   const tokenKey = planType==='4 Week'
        ?'question_OX4qD8_279a746e-6a87-47a2-af5f-9015896eda25'
        :'question_xDJv8d_25b0dded-df81-4e6b-870b-9244029e451c';
   const token    = body.fields.find(f=>f.key===tokenKey)?.value;
   const meta     = tokens.get(token);
   if(!meta || meta.used || meta.plan!==planType){
     console.log('🛑 bad token'); return res.status(401).send('token');
   }

   /* Map dropdown IDs -> labels */
   body.fields.forEach(f=>{
     const map = dropdown[f.key];
     if(map && map[f.value]) f.value = map[f.value];
   });

   const user = {
     name : body.fields.find(f=>f.label.toLowerCase().includes('name'))?.value||'Client',
     email: meta.email,
     allergies:body.fields.find(f=>f.label.toLowerCase().includes('allergies'))?.value||'None'
   };
   const profile = body.fields.map(f=>{
     const v = Array.isArray(f.value)?f.value.join(', '):f.value;
     return `${f.label}: ${v}`;
   }).join('\n');

   /* ──  Ask OpenAI  ──────────────────────────────────────────────── */
   async function getPlan(prompt){
     const r = await open.chat.completions.create({
       model:'gpt-4o',temperature:0.35,max_tokens:10000,
       messages:[
         {role:'system',content:'You are a fitness and nutrition expert.'},
         {role:'user',content:prompt}]
     });
     return r.choices[0].message.content;
   }
   console.log('🧠  Prompting GPT-4o...');
   const t1 = await getPlan(buildPrompt(profile,user.allergies,planType,1));
   const t2 = planType==='4 Week'
            ? await getPlan(buildPrompt(profile,user.allergies,planType,2))
            : '';
   const planText = (t1 + '\n\n' + t2).replace(/\*+/g,'').trim();
   console.log('✅  GPT-4o response received');

   /* ──  Build PDF  ───────────────────────────────────────────────── */
   const doc = new PDFKit({ margin:0, size:'A4' });
   doc.registerFont('header', FONT_HEADER);
   doc.registerFont('body',   FONT_BODY);

   const chunks=[]; doc.on('data',d=>chunks.push(d));

   /* Title page (uses the implicit first page) */
   titlePage(doc, user);

   /* Content page(s) */
   newContentPage(doc);
   weekHeader(doc,1);
   doc.font('body').fontSize(13).fillColor(COLOR.text)
      .text(planText,{ lineGap:6 });
   doc.moveDown(2);
   doc.fillColor(COLOR.text).fontSize(11)
      .text('Stay hydrated, consistent & rested – results will come.',
            { align:'center' });

   doc.end();
   const pdf = Buffer.concat(await new Promise(r=>{doc.on('end',()=>r(chunks));}));

   /* ──  Mail the finished plan  ─────────────────────────────────── */
   const mail = nodemailer.createTransport({
     service:'gmail',
     auth:{user:process.env.MAIL_USER,pass:process.env.MAIL_PASS}
   });

   const planHTML = `
     <div style="font-family:Inter,Arial,sans-serif;padding:32px;max-width:600px;
                 margin:auto;background:#0f172a;color:#e2e8f0;border-radius:12px">
       <img src="cid:logo" style="width:90px;margin:auto;display:block"/>
       <h2 style="color:#3b82f6;text-align:center;margin-top:20px">
           Your personalised plan is here! 🎉</h2>
       <p style="font-size:15px;line-height:1.6">
         Hi <b>${user.name}</b>,<br>
         Attached is your bespoke workout & meal plan.<br>
         Give it your best for the next few weeks – consistency wins.
       </p>
       <p style="font-size:13px;color:#94a3b8;text-align:center;margin-top:32px">
         Need tweaks?  Reply and we’ve got you. 💪
       </p>
     </div>`;

   await mail.sendMail({
     from:'BulkBot AI <bulkbotplans@gmail.com>',
     to:  user.email,
     subject:'Your BulkBot plan PDF 💪',
     html:planHTML,
     attachments:[
       { filename:'Plan.pdf', content:pdf },
       { filename:'logo.jpg', path:'./assets/logo.jpg', cid:'logo' }
     ]
   });
   console.log('📧  Plan sent to', user.email);

   meta.used=true; saveTokens();
   res.send('sent');
 }catch(e){
   console.error('❌  Tally handler',e);
   res.status(500).send('err');
 }};
}
app.post('/api/tally-webhook/1week', tallyRoute('1 Week'));
app.post('/api/tally-webhook/4week', tallyRoute('4 Week'));

/* ─────────────────────── 7. Ready! ───────────────────────────────────── */
app.listen(PORT, ()=>console.log(`🚀  BulkBot running on :${PORT}`));
