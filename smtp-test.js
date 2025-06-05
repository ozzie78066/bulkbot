const nodemailer = require("nodemailer");
require("dotenv").config();

(async () => {
  let transporter = nodemailer.createTransport({
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
      from: process.env.ZOHO_EMAIL,
      to: process.env.ZOHO_EMAIL,
      subject: "SMTP Test",
      text: "If you get this, Gmail SMTP is working!",
    });

    console.log("✅ Email sent.");
  } catch (err) {
    console.error("❌ SMTP FAILED:", err);
  }
})();
