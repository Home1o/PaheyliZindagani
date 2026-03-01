'use strict';

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const dbModule = require('../db');
const { signToken, requireAuth } = require('../auth');
const { sendOTPEmail } = require('../mailer');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@themargin.com').toLowerCase();
const ADMIN_PASS  =  process.env.ADMIN_PASSWORD || 'Admin@Margin2025!';

// Access db lazily so it's always the initialised instance
function db() { return dbModule.db; }

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function storeOTP(email) {
  const code      = generateOTP();
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  db().prepare(`DELETE FROM otps WHERE email = ?`).run(email);
  db().prepare(`INSERT INTO otps (email, code, expires_at) VALUES (?, ?, ?)`).run(email.toLowerCase(), code, expiresAt);
  return code;
}

function verifyOTP(email, inputCode) {
  email = email.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const row = db().prepare(`SELECT * FROM otps WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1`).get(email, now);
  if (!row) return { ok: false, error: 'No valid code found. Request a new one.' };
  if (row.code !== inputCode.trim()) return { ok: false, error: 'Incorrect code. Try again.' };
  db().prepare(`UPDATE otps SET used = 1 WHERE id = ?`).run(row.id);
  return { ok: true };
}

router.post('/register', async (req, res) => {
  try {
    let { email, name, password } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'All fields are required.' });
    email = email.trim().toLowerCase(); name = name.trim();
    if (email === ADMIN_EMAIL) return res.status(400).json({ error: 'This email is reserved.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (db().prepare(`SELECT id FROM users WHERE email = ?`).get(email))
      return res.status(409).json({ error: 'An account already exists with that email.' });
    const hash = await bcrypt.hash(password, 12);
    db().prepare(`INSERT INTO users (email, name, password, is_admin, verified) VALUES (?, ?, ?, 0, 0)`).run(email, name, hash);
    const code = storeOTP(email);
    await sendOTPEmail(email, code);
    res.json({ ok: true, message: 'Account created. Check your email for a verification code.' });
  } catch (err) { console.error('[register]', err); res.status(500).json({ error: 'Registration failed.' }); }
});

router.post('/login', async (req, res) => {
  try {
    let { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Please fill in all fields.' });
    email = email.trim().toLowerCase();

    if (email === ADMIN_EMAIL) {
      if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Incorrect password.' });
      let admin = db().prepare(`SELECT * FROM users WHERE email = ?`).get(email);
      if (!admin) {
        const hash = await bcrypt.hash(password, 12);
        db().prepare(`INSERT INTO users (email, name, password, is_admin, verified) VALUES (?, 'Admin', ?, 1, 1)`).run(email, hash);
        admin = db().prepare(`SELECT * FROM users WHERE email = ?`).get(email);
      }
      return res.json({ ok: true, token: signToken(admin), user: { email: admin.email, name: admin.name, isAdmin: true, verified: true } });
    }

    const user = db().prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    if (!user) return res.status(401).json({ error: 'No account found with that email.' });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Incorrect password.' });
    if (!user.verified) {
      const code = storeOTP(email);
      await sendOTPEmail(email, code);
      return res.status(403).json({ error: 'Email not verified.', needsVerify: true, email });
    }
    res.json({ ok: true, token: signToken(user), user: { email: user.email, name: user.name, isAdmin: false, verified: true } });
  } catch (err) { console.error('[login]', err); res.status(500).json({ error: 'Login failed.' }); }
});

router.post('/verify-otp', (req, res) => {
  try {
    let { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });
    email = email.trim().toLowerCase();
    const result = verifyOTP(email, code);
    if (!result.ok) return res.status(400).json({ error: result.error });
    db().prepare(`UPDATE users SET verified = 1 WHERE email = ?`).run(email);
    const user = db().prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    res.json({ ok: true, token: signToken(user), user: { email: user.email, name: user.name, isAdmin: false, verified: true } });
  } catch (err) { console.error('[verify-otp]', err); res.status(500).json({ error: 'Verification failed.' }); }
});

router.post('/resend-otp', async (req, res) => {
  try {
    let { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    email = email.trim().toLowerCase();
    if (!db().prepare(`SELECT id FROM users WHERE email = ?`).get(email))
      return res.status(404).json({ error: 'No account with that email.' });
    const code = storeOTP(email);
    await sendOTPEmail(email, code);
    res.json({ ok: true });
  } catch (err) { console.error('[resend-otp]', err); res.status(500).json({ error: 'Could not send code.' }); }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
