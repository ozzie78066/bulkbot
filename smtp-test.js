const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: 'oscar@bulkbot.store',
    pass: 'nz4V ENDy xEf5'
  }
});

transporter.sendMail({
  from: '"BulkBot AI" <bulkbotplans@gmail.com>',
  to: 'oscar.d.harrison@gmail.com',
  subject: 'Zoho SMTP Test',
  text: '✅ This is a test email from BulkBot.',
}, (err, info) => {
  if (err) {
    console.error('❌ SEND FAILED:', err);
  } else {
    console.log('✅ Email sent:', info.response);
  }
});