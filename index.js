/* --- BulkBot server (polished PDF layout) ------------------------------- */
require('dotenv').config();
const express  = require('express');
const bodyP    = require('body-parser');
const nodemailer = require('nodemailer');
const PDFKit   = require('pdfkit');
const crypto   = require('crypto');
const { OpenAI } = require('openai');
const fs       = require('fs');
const path     = require('path');

const app   = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(bodyP.json());

/* ----------------------------------------------------------------------- */
/*                token bookkeeping (unchanged)                            */
const TOKENS_FILE = './tokens.json';
let   validTokens = new Map();
if (fs.existsSync(TOKENS_FILE)) {
  try {
    validTokens = new Map(JSON.parse(fs.readFileSync(TOKENS_FILE,'utf-8')));
    console.log('🔐 tokens loaded');
  } catch (e) { console.error('❌ token load', e); }
}
const saveTokens = () => {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify([...validTokens])); }
  catch (e) { console.error('❌ token save', e); }
};
/* ----------------------------------------------------------------------- */
/*                  dropdown mappings                                      */
const dropdown = {
  /* Fitness goal -------------------------------------------------------- */
  question_7KljZA : {
    '15ac77be-80c4-4020-8e06-6cc9058eb826' : 'Gain muscle mass',
    'aa5e8858-f6e1-4535-9ce1-8b02cc652e28' : 'Cut (fat loss)',
    'd441804a-2a44-4812-b505-41f63c80d50c' : 'Recomp (build muscle / lose fat)',
    'e3a2a823-67ae-4f69-a2b0-8bca4effb500' : 'Strength & power',
    '839e27ce-c311-4a7c-adbb-88ce03488614' : 'Athletic performance',
    '6b61091e-cecd-4a9b-ad9f-1e871bff8ebd' : 'Endurance / fitness',
    '2912e3f7-6122-4a82-91e3-2d5c81f7e89f' : 'Toning & sculpting',
    'bce9ebca-f750-4516-99df-44c1e9dc5a03' : 'General health & fitness'
  },
  /* Equipment access ---------------------------------------------------- */
  question_6KJ4xB : {
    '68fb3388-c809-4c91-8aa0-edecc63cba67' : 'Full gym access',
    '67e66192-f0be-4db6-98a8-a8c3f18364bc' : 'Home dumbbells / bands',
    '0a2111b9-efcd-4e52-9ef0-22f104c7d3ca' : 'Body-weight only'
  }
};
/* ----------------------------------------------------------------------- */
/*                    helper: build AI prompt                              */
const buildPrompt = (info, allergies, planType, part=1) => {
  const span = planType==='4 Week'
    ? `Weeks ${part===1?'1 and 2':'3 and 4'}` : '1 Week';

  return `You are a professional fitness and nutrition expert creating personalised PDF workout and meal plans for paying clients.

A customer purchased the **${planType}** plan. Profile:

${info}

Allergies / intolerances: **${allergies||'None'}** (avoid silently)

Generate ${span} with the following structure
${planType==='1 Week'
  ? `- 7-day workout plan (Mon-Sun)\n- 7-day meal plan (Breakfast, Lunch, Dinner, Snack)`
  : `- 2-week workout plan (7 days/week, Week > Day > Exercises)\n- 2-week meal plan (7 days/week, 4 meals/day + macros)`}

FORMAT (plain text, no bullets / tables):

Day [X]:
Workout:
- Exercise – sets x reps • intensity or load • form tip
Meal:
- Breakfast: Name + ingredients + Calories / P/C/F
…etc…

RULES:
- Every day unique
- Show kcal, protein, carbs, fat for each meal
- Friendly expert tone
`;};
/* ----------------------------------------------------------------------- */
/*                       PDF helpers                                       */
const fonts = {
  header: path.join(__dirname,'fonts','BebasNeue-Regular.ttf'),
  body  : path.join(__dirname,'fonts','Lora-SemiBold.ttf')
};
const colours = {
  bg   : '#0f172a',      // slate-900 (dark blue/grey)
  text : '#e2e8f0',      // slate-100 (light grey)
  accent : '#3b82f6'     // blue-500
};

const startTitlePage = (doc, user) => {
  /* Title page is the very first page – no addPage() */
  doc.rect(0,0,doc.page.width,doc.page.height).fill(colours.bg);
  doc.fillColor(colours.accent)
     .font('header').fontSize(38)
     .text('PERSONAL GYM & MEAL PLAN', {align:'center',y:140});
  doc.image(path.join(__dirname,'assets','logo.jpg'),
            doc.page.width/2-90, 215, {width:180});

  doc.fillColor(colours.text)
     .font('body').fontSize(14)
     .text(`Name : ${user.name}`,  {align:'center',y:420})
     .text(`Email: ${user.email}`, {align:'center'})
     .text(`Allergies: ${user.allergies}`, {align:'center'});
};

const openContentPage = (doc) => {
  doc.addPage();
  doc.rect(0,0,doc.page.width,doc.page.height).fill(colours.bg);
  doc.fillColor(colours.text);
};

const underlineHeader = (doc, text) => {
  doc.fillColor(colours.accent).font('header').fontSize(18)
     .text(text,{align:'center'});
  const w = doc.widthOfString(text);
  const x = (doc.page.width-w)/2, y = doc.y;
  doc.moveTo(x,y+2).lineTo(x+w,y+2).stroke(colours.accent);
  doc.moveDown(1);
};
/* ----------------------------------------------------------------------- */
/*                Shopify order webhook                                    */
app.post('/webhook/shopify', async (req,res)=>{
  try{
    const {email, line_items=[]}=req.body;
    if(!email||!line_items.length) return res.status(400).send('Bad order');
    const plan = line_items.some(it=>it.title.toLowerCase().includes('4 week'))
                ? '4 Week':'1 Week';
    const token = crypto.randomBytes(16).toString('hex');
    validTokens.set(token,{used:false,email,plan}); saveTokens();

    const tallyURL = plan==='4 Week'
      ? `https://tally.so/r/wzRD1g?token=${token}&plan=4week`
      : `https://tally.so/r/wMq9vX?token=${token}&plan=1week`;

    const mail = nodemailer.createTransport({
      service:'gmail',
      auth:{user:process.env.MAIL_USER,pass:process.env.MAIL_PASS}
    });
    await mail.sendMail({
      from:'BulkBot AI <bulkbotplans@gmail.com>',
      to: email,
      subject:'Your BulkBot form link',
      html:`<p>Thanks for buying the <b>${plan}</b> plan!</p>
            <p>Fill in your details here (link is single-use):<br>
            <a href="${tallyURL}">${tallyURL}</a></p>`
    });
    console.log('✅ token sent'); return res.send('OK');
  }catch(e){console.error(e); res.status(500).send('err');}
});
/* ----------------------------------------------------------------------- */
/*                       Tally submission webhooks                         */
const processed = new Set();

const handleWebhook = (planType)=>(async(req,res)=>{
try{
  const data = req.body.data || req.body;
  if(processed.has(data.submissionId)) return res.send('dup');
  processed.add(data.submissionId); setTimeout(()=>processed.delete(data.submissionId),9e5);

  /* token -------------------------------------------------------------- */
  const tokenKey = planType==='4 Week'
        ? 'question_OX4qD8_279a746e-6a87-47a2-af5f-9015896eda25'
        : 'question_xDJv8d_25b0dded-df81-4e6b-870b-9244029e451c';
  const token = data.fields.find(f=>f.key===tokenKey)?.value;
  const meta  = validTokens.get(token);
  if(!meta||meta.used||meta.plan!==planType) return res.status(401).send('bad token');

  /* convert dropdown ids ---------------------------------------------- */
  data.fields.forEach(f=>{
    const map = dropdown[f.key];
    if(map && map[f.value]) f.value = map[f.value];
  });

  const user = {
    name : data.fields.find(f=>f.label.toLowerCase().includes('name'))?.value||'Client',
    email: meta.email,
    allergies : data.fields.find(f=>f.label.toLowerCase().includes('allergies'))?.value||'None'
  };
  const info = data.fields.map(f=>{
    const v = Array.isArray(f.value)?f.value.join(', '):f.value;
    return `${f.label}: ${v}`;}).join('\n');

  /* -------- Ask OpenAI ----------------------------------------------- */
  const getChunk = async prompt=>{
    const r = await openai.chat.completions.create({
      model:'gpt-4o',temperature:0.4,max_tokens:10000,
      messages:[{role:'system',content:'You are a fitness & nutrition expert.'},
                {role:'user',content:prompt}]});
    return r.choices[0].message.content;
  };
  const p1 = buildPrompt(info,user.allergies,planType,1);
  const p2 = planType==='4 Week'?buildPrompt(info,user.allergies,planType,2):'';
  const txt = (await getChunk(p1) + '\n\n' + (p2?await getChunk(p2):''))
              .replace(/\*+/g,'').trim();

  /* -------- Generate PDF --------------------------------------------- */
  const doc = new PDFKit({margin:50});
  doc.registerFont('header',fonts.header);
  doc.registerFont('body',  fonts.body);
  const bufs=[]; doc.on('data',d=>bufs.push(d));
  doc.on('end',async()=>{
     const pdf = Buffer.concat(bufs);
     const mail = nodemailer.createTransport({
       service:'gmail',
       auth:{user:process.env.MAIL_USER,pass:process.env.MAIL_PASS}
     });
     await mail.sendMail({
       from:'BulkBot AI <bulkbotplans@gmail.com>',
       to: user.email,
       subject:'Your BulkBot Plan 💪',
       html:`<p>Hi ${user.name}, your personalised plan is attached!</p>`,
       attachments:[{filename:'Plan.pdf',content:pdf},
                    {filename:'logo.jpg',path:'./assets/logo.jpg',cid:'logo'}]
     });
     meta.used=true; saveTokens();
     res.send('sent');
  });

  /* first (title) page */
  decoratePage = () => {};
  startTitlePage(doc,user);

  /* content pages ------------------------------------------------------ */
  openContentPage(doc);
  underlineHeader(doc,'Week 1');
  doc.font('body').fontSize(14).fillColor(colours.text)
     .text(txt,{lineGap:6});
  doc.fillColor(colours.text).fontSize(12)
     .text('Stay hydrated, consistent & rested – results will come.',
           doc.page.margins.left, doc.page.height-60, {align:'center'});
  doc.end();

}catch(e){console.error(e); res.status(500).send('err');}});
/* register tally routes ------------------------------------------------- */
app.post('/api/tally-webhook/1week', handleWebhook('1 Week'));
app.post('/api/tally-webhook/4week', handleWebhook('4 Week'));
/* ----------------------------------------------------------------------- */
app.listen(3000,()=>console.log('🚀 BulkBot listening on 3000'));
/* ----------------------------------------------------------------------- */
