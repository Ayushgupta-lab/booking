/**
 * MediCare Hospital — Real Validation, OTP & Multi-Channel Delivery (Email + SMS)
 */
const crypto = require("crypto");
const dns = require("dns");
const nodemailer = require("nodemailer");

const COMMON_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "zoho.com", "zohomail.in", "rediffmail.com",
  "aol.com", "yandex.com",
]);

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com",
  "yopmail.com", "throwawaymail.com", "fakeinbox.com", "trashmail.com",
  "test.com", "example.com", "invalid.com", "fake.com",
]);

const OTP_SECRET = process.env.OTP_SECRET || process.env.SESSION_SECRET || "medicare-otp-hmac-2026";
let cachedTransporter = null;

/**
 * Validate email syntax and check domain MX records so fake domains are rejected.
 */
async function validateEmailAddress(rawEmail) {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!email || email.length > 150) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  const basicRe = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
  if (!basicRe.test(email)) {
    return { ok: false, error: "Enter a valid email format (e.g. name@gmail.com)." };
  }
  const domain = email.split("@")[1];
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { ok: false, error: "Temporary or test email domains are not allowed. Use a real email address." };
  }
  if (COMMON_EMAIL_DOMAINS.has(domain)) {
    return { ok: true, email };
  }

  // Real DNS MX check for custom/corporate domains (2.5s cap so requests stay snappy)
  try {
    const mxPromise = dns.promises.resolveMx(domain).catch(async () => {
      const resolver = new dns.promises.Resolver();
      resolver.setServers(["8.8.8.8", "1.1.1.1"]);
      return resolver.resolveMx(domain);
    });
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("MX_TIMEOUT")), 2500));
    const records = await Promise.race([mxPromise, timeoutPromise]);
    if (!Array.isArray(records) || records.length === 0 || (records.length === 1 && !records[0].exchange)) {
      return { ok: false, error: `Email domain "${domain}" cannot receive emails. Please check the spelling.` };
    }
    return { ok: true, email };
  } catch (err) {
    if (err && err.message === "MX_TIMEOUT") {
      return { ok: true, email };
    }
    return { ok: false, error: `Email domain "${domain}" does not exist. Please enter a real email address.` };
  }
}

/**
 * Normalize and strictly validate phone numbers (defaults 10-digit Indian mobiles to +91).
 */
function normalizePhoneNumber(rawPhone) {
  const cleaned = String(rawPhone || "").trim().replace(/[\s\-().]/g, "");
  if (!cleaned) {
    return { ok: false, error: "Phone number is required." };
  }

  let e164 = "";
  let digits10 = "";

  if (/^[6-9]\d{9}$/.test(cleaned)) {
    digits10 = cleaned;
    e164 = `+91${cleaned}`;
  } else if (/^0[6-9]\d{9}$/.test(cleaned)) {
    digits10 = cleaned.slice(1);
    e164 = `+91${digits10}`;
  } else if (/^(\+?91)([6-9]\d{9})$/.test(cleaned)) {
    digits10 = cleaned.slice(-10);
    e164 = `+91${digits10}`;
  } else if (/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    e164 = cleaned;
    digits10 = cleaned.slice(-10);
  } else {
    return {
      ok: false,
      error: "Enter a valid 10-digit mobile number (or international +country code, e.g. +91 9876543210).",
    };
  }

  // Reject obviously fake repeating patterns like 0000000000 or 9999999999
  if (/^(\d)\1{7,}$/.test(digits10)) {
    return { ok: false, error: "Please enter your real mobile number — repeated digits are not accepted." };
  }
  if (digits10 === "1234567890" || digits10 === "0123456789") {
    return { ok: false, error: "Please enter a real mobile number." };
  }

  return { ok: true, phone: e164, digits10 };
}

function phoneDigitsMatch(a, b) {
  const na = String(a || "").replace(/\D/g, "");
  const nb = String(b || "").replace(/\D/g, "");
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 10 && nb.length >= 10) {
    return na.slice(-10) === nb.slice(-10);
  }
  return false;
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtpCode(code, salt = crypto.randomBytes(12).toString("hex")) {
  const hash = crypto.createHmac("sha256", OTP_SECRET).update(`${salt}:${String(code)}`).digest("hex");
  return { salt, hash };
}

function verifyOtpHash(code, salt, expectedHash) {
  if (!code || !salt || !expectedHash) return false;
  try {
    const { hash } = hashOtpCode(String(code).trim(), salt);
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(expectedHash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function signLookupToken(phone) {
  const norm = normalizePhoneNumber(phone);
  const target = norm.ok ? norm.phone : String(phone || "").trim();
  const exp = Date.now() + 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ phone: target, exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", OTP_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyLookupToken(token, requestedPhone) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", OTP_SECRET).update(payload).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data || Date.now() > Number(data.exp)) return false;
    if (requestedPhone) return phoneDigitsMatch(data.phone, requestedPhone);
    return data.phone;
  } catch {
    return false;
  }
}

function isEmailProviderConfigured() {
  return Boolean(
    (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) ||
    (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  );
}

function isSmsProviderConfigured() {
  return Boolean(
    process.env.FAST2SMS_API_KEY ||
    (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) ||
    process.env.TWOFACTOR_API_KEY ||
    process.env.SMS_WEBHOOK_URL
  );
}

function getEmailTransporter() {
  if (cachedTransporter) return cachedTransporter;
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 7000,
      greetingTimeout: 7000,
    });
    return cachedTransporter;
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    cachedTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER.trim(),
        pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, ""),
      },
      connectionTimeout: 7000,
      greetingTimeout: 7000,
    });
    return cachedTransporter;
  }
  return null;
}

function buildOtpEmailHtml(otp, purposeLabel) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff;color:#0f172a;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <span style="display:inline-block;background:#0d9488;color:#fff;font-weight:800;padding:6px 10px;border-radius:8px;">+</span>
        <strong style="font-size:18px;color:#0b1f33;">MediCare Hospital</strong>
      </div>
      <p style="font-size:15px;color:#334155;margin:0 0 12px;">Your verification code for <strong>${purposeLabel}</strong>:</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#0f766e;background:#f0fdfa;border:1px dashed #14b8a6;border-radius:10px;padding:16px;text-align:center;margin:16px 0;">
        ${otp}
      </div>
      <p style="font-size:13px;color:#64748b;margin:0;">This OTP is valid for <strong>5 minutes</strong>. Do not share this code with anyone.</p>
    </div>
  `;
}

/**
 * Send Email OTP using configured Gmail/SMTP, or return explicit sandbox notice when unconfigured.
 */
async function sendEmailOtp(toEmail, otp, purpose = "verification") {
  const purposeLabel =
    purpose === "login" ? "Account Sign-In"
    : purpose === "register" ? "New Account Registration"
    : "Verification";

  const transporter = getEmailTransporter();
  if (transporter) {
    const fromAddr = process.env.SMTP_FROM || process.env.GMAIL_USER || process.env.SMTP_USER;
    await transporter.sendMail({
      from: `"MediCare Hospital" <${fromAddr}>`,
      to: toEmail,
      subject: `${otp} is your MediCare Hospital ${purposeLabel} OTP`,
      text: `Your MediCare Hospital OTP is ${otp}. Valid for 5 minutes.`,
      html: buildOtpEmailHtml(otp, purposeLabel),
    });
    return { delivered: true, mode: "live", provider: process.env.GMAIL_USER ? "gmail" : "smtp" };
  }

  // Fallback when SMTP env vars are not configured yet
  return {
    delivered: false,
    mode: "sandbox",
    provider: "sandbox",
    sandboxOtp: otp,
    note: "Email SMTP is not configured in environment variables (GMAIL_USER / GMAIL_APP_PASSWORD). Use the sandbox OTP shown below to continue.",
  };
}

/**
 * Send SMS OTP using Fast2SMS, Twilio, 2Factor, or Webhook, or return explicit sandbox notice.
 */
async function sendSmsOtp(phoneObj, otp, purpose = "verification") {
  const e164 = typeof phoneObj === "string" ? phoneObj : phoneObj.phone;
  const digits10 = typeof phoneObj === "string" ? phoneObj.replace(/\D/g, "").slice(-10) : phoneObj.digits10;

  if (process.env.FAST2SMS_API_KEY) {
    const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
      method: "POST",
      headers: {
        authorization: process.env.FAST2SMS_API_KEY.trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        route: "otp",
        variables_values: otp,
        numbers: digits10,
      }),
      signal: AbortSignal.timeout(7000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.return === false) {
      throw new Error(data.message || "Fast2SMS failed to send OTP.");
    }
    return { delivered: true, mode: "live", provider: "fast2sms" };
  }

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    const sid = process.env.TWILIO_ACCOUNT_SID.trim();
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN.trim()}`).toString("base64");
    const params = new URLSearchParams({
      To: e164,
      From: process.env.TWILIO_PHONE_NUMBER.trim(),
      Body: `Your MediCare Hospital ${purpose} OTP is ${otp}. Valid for 5 minutes.`,
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(7000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || "Twilio SMS failed to send OTP.");
    }
    return { delivered: true, mode: "live", provider: "twilio" };
  }

  if (process.env.TWOFACTOR_API_KEY) {
    const key = process.env.TWOFACTOR_API_KEY.trim();
    const res = await fetch(`https://2factor.in/API/V1/${encodeURIComponent(key)}/SMS/${encodeURIComponent(e164)}/${encodeURIComponent(otp)}`, {
      signal: AbortSignal.timeout(7000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.Status !== "Success") {
      throw new Error(data.Details || "2Factor SMS failed to send OTP.");
    }
    return { delivered: true, mode: "live", provider: "2factor" };
  }

  if (process.env.SMS_WEBHOOK_URL) {
    const res = await fetch(process.env.SMS_WEBHOOK_URL.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: e164, otp, message: `MediCare Hospital OTP: ${otp}` }),
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) throw new Error("SMS webhook delivery failed.");
    return { delivered: true, mode: "live", provider: "webhook" };
  }

  return {
    delivered: false,
    mode: "sandbox",
    provider: "sandbox",
    sandboxOtp: otp,
    note: "SMS gateway is not configured in environment variables (FAST2SMS_API_KEY or TWILIO_*). Use the sandbox OTP shown below to continue.",
  };
}

/**
 * Send non-blocking booking confirmation email if SMTP is configured.
 */
async function sendBookingConfirmationEmail(appt) {
  if (!appt || !appt.email) return;
  const transporter = getEmailTransporter();
  if (!transporter) return;
  try {
    const fromAddr = process.env.SMTP_FROM || process.env.GMAIL_USER || process.env.SMTP_USER;
    await transporter.sendMail({
      from: `"MediCare Hospital" <${fromAddr}>`,
      to: appt.email,
      subject: `Appointment Confirmed (#${appt.id}) — ${appt.doctor_name}`,
      text: `Hello ${appt.patient_name}, your appointment #${appt.id} with ${appt.doctor_name} (${appt.specialty}) is confirmed for ${appt.appt_date} at ${appt.slot_time}.`,
    });
  } catch (err) {
    console.warn("[Email] Booking confirmation notice failed:", err.message);
  }
}

module.exports = {
  validateEmailAddress,
  normalizePhoneNumber,
  phoneDigitsMatch,
  generateOtpCode,
  hashOtpCode,
  verifyOtpHash,
  signLookupToken,
  verifyLookupToken,
  isEmailProviderConfigured,
  isSmsProviderConfigured,
  sendEmailOtp,
  sendSmsOtp,
  sendBookingConfirmationEmail,
};
