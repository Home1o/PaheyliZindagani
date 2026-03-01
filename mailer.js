'use strict';

/**
 * Sends an OTP code to `email`.
 * If SMTP env vars are set, sends a real email via nodemailer.
 * Otherwise, prints the code to the server console (great for local dev).
 */
async function sendOTPEmail(email, code) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT) || 587,
      secure: parseInt(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    await transporter.sendMail({
      from:    `"The Margin" <${SMTP_USER}>`,
      to:      email,
      subject: 'Your verification code — The Margin',
      text:    `Your verification code is: ${code}\n\nIt expires in 10 minutes.`,
      html:    `
        <div style="font-family:Georgia,serif;max-width:420px;margin:auto;padding:32px">
          <h2 style="font-size:1.4rem;margin-bottom:8px">The<span style="color:#d4782e">.</span>Margin</h2>
          <p style="color:#666;margin-bottom:24px">Your email verification code:</p>
          <div style="background:#f5f1eb;border:2px dashed #d4782e;border-radius:6px;padding:20px;text-align:center;margin-bottom:24px">
            <span style="font-family:monospace;font-size:2.4rem;font-weight:700;color:#d4782e;letter-spacing:.3em">${code}</span>
          </div>
          <p style="color:#999;font-size:.85rem">This code expires in 10 minutes. If you did not request this, ignore this email.</p>
        </div>
      `
    });

    console.log(`[otp] Email sent to ${email}`);
  } else {
    // Dev fallback — print to console
    console.log(`\n  ┌─────────────────────────────────┐`);
    console.log(`  │  OTP for ${email.padEnd(23)}│`);
    console.log(`  │  Code: ${code}                     │`);
    console.log(`  └─────────────────────────────────┘\n`);
  }
}

module.exports = { sendOTPEmail };
