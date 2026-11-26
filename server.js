/**
 * MediCare Hospital — Appointment Portal API
 * Express + MongoDB Atlas Primary (with SQLite offline fallback) + Email/SMS OTP Auth
 */
const path = require("path");
const express = require("express");

// Load .env if present (supported natively in Node.js 20.12+)
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // .env is optional (env vars may come from Vercel / Render)
}

const db = require("./lib/db");
const otp = require("./lib/otp");

const PORT = process.env.PORT || 3000;
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "256kb" }));
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: process.env.VERCEL ? "1h" : 0,
  })
);

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------------------------- Auth / Cookie Helpers ------------------------- */
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "")
    .split(";")
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i > -1) {
        try {
          out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
        } catch {
          out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
        }
      }
    });
  return out;
}

function extractToken(req) {
  let token = parseCookies(req).sid;
  if (!token && req.headers.authorization) {
    const m = req.headers.authorization.match(/^Bearer\s+(.+)$/i);
    if (m) token = m[1].trim();
  }
  return token || null;
}

function setSessionCookie(req, res, token, ttlMs) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secureFlag = isHttps ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secureFlag}`
  );
}

function clearSessionCookie(req, res) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secureFlag = isHttps ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`);
}

function hasValidLookupAccess(req, targetPhone) {
  const lookupToken = req.headers["x-lookup-token"] || req.query.lookupToken;
  if (!lookupToken) return false;
  return otp.verifyLookupToken(String(lookupToken), targetPhone);
}

function userCanAccessAppt(req, appt) {
  if (!appt) return false;
  if (req.user && req.user.role === "admin") return true;
  if (req.user) {
    if (appt.user_id != null && Number(appt.user_id) === Number(req.user.id)) return true;
    if (req.user.phone && otp.phoneDigitsMatch(req.user.phone, appt.phone)) return true;
  }
  if (hasValidLookupAccess(req, appt.phone)) return true;
  return false;
}

/* ----------------------------- Validation Helpers --------------------------- */
async function verifyStoredOtp(purpose, channel, target, code) {
  const cleanCode = String(code || "").trim();
  if (!/^\d{6}$/.test(cleanCode)) {
    return { ok: false, status: 400, error: "Please enter the 6-digit OTP code." };
  }
  const record = await db.getLatestOtp(purpose, channel, target);
  if (!record) {
    return { ok: false, status: 400, error: "No OTP found for this request. Please send a new OTP." };
  }
  if (record.verified) {
    return { ok: false, status: 400, error: "This OTP has already been used. Please request a new OTP." };
  }
  if (new Date(record.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 400, error: "This OTP has expired. Please request a new OTP." };
  }
  if ((record.attempts || 0) >= (record.max_attempts || 5)) {
    return { ok: false, status: 429, error: "Too many wrong OTP attempts. Please request a new OTP." };
  }
  const valid = otp.verifyOtpHash(cleanCode, record.salt, record.code_hash);
  if (!valid) {
    await db.incrementOtpAttempts(record);
    const remaining = Math.max(0, (record.max_attempts || 5) - (record.attempts || 0) - 1);
    return {
      ok: false,
      status: 400,
      error: remaining > 0 ? `Incorrect OTP. ${remaining} attempt(s) left.` : "Incorrect OTP. Please request a new OTP.",
    };
  }
  await db.markOtpVerified(record);
  return { ok: true };
}

async function validateBooking(body, ignoreApptId = null, allowOccupied = false) {
  const { patient_name, phone, email, doctor_id, appt_date, slot_time } = body;
  if (!patient_name || String(patient_name).trim().length < 2) return "Patient full name is required.";
  const phoneRes = otp.normalizePhoneNumber(phone);
  if (!phoneRes.ok) return phoneRes.error;
  if (email && String(email).trim()) {
    const emailRes = await otp.validateEmailAddress(email);
    if (!emailRes.ok) return emailRes.error;
  }
  if (!doctor_id) return "Please select a doctor.";
  if (!appt_date || !/^\d{4}-\d{2}-\d{2}$/.test(appt_date)) return "Date must be in YYYY-MM-DD format.";
  if (appt_date < db.todayIST()) return "Cannot book an appointment in the past.";
  if (!slot_time || !db.SLOT_TIMES.includes(slot_time)) return "Please pick a valid time slot.";

  const doctor = await db.getDoctor(doctor_id);
  if (!doctor) return "Selected doctor was not found.";
  if (!db.doctorWorksOn(doctor, appt_date)) {
    return `${doctor.name} does not see patients on ${db.weekdayOf(appt_date)}. Pick another day.`;
  }
  if (!allowOccupied && !(await db.slotIsFree(doctor_id, appt_date, slot_time, ignoreApptId))) {
    return `The ${slot_time} slot on ${appt_date} was just booked. Please pick another slot.`;
  }
  return null;
}

/* ----------------------------- DB & Auth Gate ------------------------------- */
app.use(
  "/api",
  ah(async (req, res, next) => {
    await db.ensureReady();
    const token = extractToken(req);
    req.user = token ? await db.getSessionUser(token) : null;

    const p = req.path;
    const method = req.method;

    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin) {
        try {
          const originHost = new URL(origin).host;
          const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
          if (originHost !== reqHost && !originHost.endsWith(".vercel.app")) {
            return res.status(403).json({ error: "Cross-origin request blocked." });
          }
        } catch {
          return res.status(403).json({ error: "Cross-origin request blocked." });
        }
      }

      if (p.startsWith("/auth/") || p.startsWith("/alex/") || p === "/appointments/emergency") {
        return next();
      }

      const apptMatch = p.match(/^\/appointments\/(\d+)(?:\/.*)?$/);
      if (!req.user) {
        // Allow guest emergency owner with valid lookup token to edit/reschedule/cancel their own booking
        if (apptMatch && method !== "DELETE") {
          const appt = await db.findAppointmentRaw(Number(apptMatch[1]));
          if (appt && hasValidLookupAccess(req, appt.phone)) return next();
        }
        const hint = p.startsWith("/doctors")
          ? "Sign in with an admin account to manage doctors."
          : p.startsWith("/appointments")
            ? "Sign in to book or manage appointments."
            : p.startsWith("/payments")
              ? "Sign in to manage payments."
              : "Please sign in to continue.";
        return res.status(401).json({ error: hint, code: "auth_required" });
      }

      if (p.startsWith("/doctors") && req.user.role !== "admin") {
        return res.status(403).json({ error: "Only an admin account can manage doctors." });
      }
      if (apptMatch) {
        const appt = await db.findAppointmentRaw(Number(apptMatch[1]));
        if (appt && !userCanAccessAppt(req, appt)) {
          return res.status(403).json({ error: "That booking belongs to another patient." });
        }
      }
      return next();
    }

    // GET access control
    if (p === "/appointments") {
      if (req.query.mine) {
        if (!req.user) return res.status(401).json({ error: "Sign in to see your bookings.", code: "auth_required" });
        return next();
      }
      if (req.query.phone) {
        const qPhone = String(req.query.phone);
        if (req.user && (req.user.role === "admin" || (req.user.phone && otp.phoneDigitsMatch(req.user.phone, qPhone)))) {
          return next();
        }
        if (hasValidLookupAccess(req, qPhone)) return next();
        return res.status(401).json({
          error: "Verify this phone number with SMS OTP (or sign in) to view appointments.",
          code: "lookup_otp_required",
        });
      }
      if (!req.user || req.user.role !== "admin") {
        return res.status(401).json({ error: "Sign in as an admin to see every appointment.", code: "auth_required" });
      }
    }
    return next();
  })
);

/* --------------------------------- AUTH + OTP API --------------------------- */
app.post(
  "/api/auth/send-otp",
  ah(async (req, res) => {
    const { purpose = "register", channel = "email", email, phone, identifier } = req.body || {};
    if (!["register", "reset", "lookup"].includes(purpose)) {
      return res.status(400).json({ error: "Invalid OTP purpose." });
    }
    if (!["email", "sms", "both"].includes(channel)) {
      return res.status(400).json({ error: "Invalid OTP delivery channel." });
    }

    let cleanEmail = null;
    let normPhone = null;

    if (purpose === "register") {
      const emailCheck = await otp.validateEmailAddress(email);
      if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });
      cleanEmail = emailCheck.email;

      const phoneCheck = otp.normalizePhoneNumber(phone);
      if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });
      normPhone = phoneCheck;

      const existingByEmail = await db.findUserByEmail(cleanEmail);
      if (existingByEmail) {
        return res.status(409).json({ error: "An account with this email already exists — please sign in." });
      }
      const existingByPhone = await db.findUserByPhone(normPhone.phone);
      if (existingByPhone) {
        return res.status(409).json({ error: "An account with this phone number already exists — please sign in." });
      }
    } else if (purpose === "reset") {
      const rawId = identifier || (channel === "sms" ? phone : email);
      const user = await db.findUserByIdentifier(rawId);
      if (!user) {
        return res.status(404).json({
          error: "No registered account found for that email or phone. Please create an account first.",
        });
      }
      if (channel === "sms") {
        if (!user.phone) {
          return res.status(400).json({ error: "This account has no phone number linked. Use Email OTP instead." });
        }
        normPhone = otp.normalizePhoneNumber(user.phone);
        if (!normPhone.ok) {
          return res.status(400).json({ error: "Account phone number is invalid. Use Email OTP instead." });
        }
      } else {
        cleanEmail = user.email;
        if (channel === "both" && user.phone) {
          const p = otp.normalizePhoneNumber(user.phone);
          if (p.ok) normPhone = p;
        }
      }
    } else if (purpose === "lookup") {
      const phoneCheck = otp.normalizePhoneNumber(phone);
      if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });
      normPhone = phoneCheck;
      const matchingAppts = await db.listAppointments({ phone: normPhone.phone });
      if (!matchingAppts.length) {
        return res.status(404).json({ error: `No appointments found for ${normPhone.phone}.` });
      }
    }

    // Cooldown check (30s) per channel target
    const checkCooldown = async (ch, target) => {
      const prev = await db.getLatestOtp(purpose, ch, target);
      if (prev && prev.created_at) {
        const ageMs = Date.now() - new Date(prev.created_at).getTime();
        if (ageMs < 25 * 1000 && !prev.verified) {
          const wait = Math.ceil((25 * 1000 - ageMs) / 1000);
          return `Please wait ${wait}s before requesting another OTP.`;
        }
      }
      return null;
    };

    const sendEmail = (channel === "email" || channel === "both") && cleanEmail;
    const sendSms = (channel === "sms" || channel === "both" || purpose === "lookup") && normPhone;

    if (sendEmail) {
      const msg = await checkCooldown("email", cleanEmail);
      if (msg) return res.status(429).json({ error: msg });
    }
    if (sendSms) {
      const msg = await checkCooldown("sms", normPhone.phone);
      if (msg) return res.status(429).json({ error: msg });
    }

    const delivery = {};
    const ttlMs = 5 * 60 * 1000;

    if (sendEmail) {
      const code = otp.generateOtpCode();
      const { salt, hash } = otp.hashOtpCode(code);
      await db.storeOtpRecord({ purpose, channel: "email", target: cleanEmail, codeHash: hash, salt, ttlMs });
      delivery.email = await otp.sendEmailOtp(cleanEmail, code, purpose);
      delivery.email.target = cleanEmail;
    }

    if (sendSms) {
      const code = otp.generateOtpCode();
      const { salt, hash } = otp.hashOtpCode(code);
      await db.storeOtpRecord({ purpose, channel: "sms", target: normPhone.phone, codeHash: hash, salt, ttlMs });
      delivery.sms = await otp.sendSmsOtp(normPhone, code, purpose);
      delivery.sms.target = normPhone.phone;
    }

    res.json({
      ok: true,
      purpose,
      channel: purpose === "lookup" ? "sms" : channel,
      expiresInSeconds: 300,
      delivery,
    });
  })
);

app.post(
  "/api/auth/register",
  ah(async (req, res) => {
    const { name, email, phone, password, channel = "email", otp: singleOtp, email_otp, sms_otp } = req.body || {};

    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ error: "Your full name is required." });
    }
    const emailCheck = await otp.validateEmailAddress(email);
    if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });
    const cleanEmail = emailCheck.email;

    const phoneCheck = otp.normalizePhoneNumber(phone);
    if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });
    const normPhone = phoneCheck.phone;

    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (!["email", "sms", "both"].includes(channel)) {
      return res.status(400).json({ error: "Invalid verification channel." });
    }

    // Never allow overwriting or hijacking existing accounts (including admin)
    if (await db.findUserByEmail(cleanEmail)) {
      return res.status(409).json({ error: "An account with that email already exists — please sign in." });
    }
    if (await db.findUserByPhone(normPhone)) {
      return res.status(409).json({ error: "An account with that phone number already exists — please sign in." });
    }

    // Strict OTP verification gate
    let emailVerified = false;
    let phoneVerified = false;

    if (channel === "email" || channel === "both") {
      const code = email_otp || (channel === "email" ? singleOtp : "");
      const resEmail = await verifyStoredOtp("register", "email", cleanEmail, code);
      if (!resEmail.ok) return res.status(resEmail.status).json({ error: `Email OTP: ${resEmail.error}` });
      emailVerified = true;
    }
    if (channel === "sms" || channel === "both") {
      const code = sms_otp || (channel === "sms" ? singleOtp : "");
      const resSms = await verifyStoredOtp("register", "sms", normPhone, code);
      if (!resSms.ok) return res.status(resSms.status).json({ error: `SMS OTP: ${resSms.error}` });
      phoneVerified = true;
    }

    const user = await db.createUser({
      name: String(name).trim(),
      email: cleanEmail,
      phone: normPhone,
      password,
      role: "patient",
      email_verified: emailVerified,
      phone_verified: phoneVerified,
    });

    const { token, ttlMs } = await db.createSession(user.id);
    setSessionCookie(req, res, token, ttlMs);
    res.status(201).json({ ok: true, token, user });
  })
);

app.post(
  "/api/auth/login",
  ah(async (req, res) => {
    const { identifier, email, password } = req.body || {};
    const rawId = String(identifier || email || "").trim();
    if (!rawId || !password) {
      return res.status(400).json({ error: "Enter your email/phone and password." });
    }

    const row = await db.findUserByIdentifier(rawId);
    if (!row || !db.verifyPassword(password, row.salt, row.password_hash)) {
      return res.status(401).json({ error: "Incorrect email/phone or password." });
    }

    const user = db.cleanUser(row);
    const { token, ttlMs } = await db.createSession(user.id);
    setSessionCookie(req, res, token, ttlMs);
    res.json({ ok: true, token, user });
  })
);

app.post(
  "/api/auth/reset-password",
  ah(async (req, res) => {
    const { channel = "email", identifier, email, phone, otp: code, new_password } = req.body || {};
    const rawId = String(identifier || (channel === "sms" ? phone : email) || "").trim();
    if (!rawId) {
      return res.status(400).json({ error: "Enter your registered email or phone number." });
    }
    if (!["email", "sms"].includes(channel)) {
      return res.status(400).json({ error: "Invalid verification channel." });
    }
    if (!new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }

    const row = await db.findUserByIdentifier(rawId);
    if (!row) {
      return res.status(404).json({ error: "No registered account found for that email or phone." });
    }

    let check;
    if (channel === "sms") {
      const p = otp.normalizePhoneNumber(row.phone);
      if (!p.ok) return res.status(400).json({ error: "Account has no valid phone number linked." });
      check = await verifyStoredOtp("reset", "sms", p.phone, code);
    } else {
      check = await verifyStoredOtp("reset", "email", row.email, code);
    }
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    await db.updateUserPassword(row.id, String(new_password));
    await db.deleteUserSessions(row.id);

    res.json({
      ok: true,
      email: row.email,
      message: "Password reset successfully. Please sign in with your new password.",
    });
  })
);

app.post(
  "/api/auth/verify-lookup-otp",
  ah(async (req, res) => {
    const { phone, otp: code } = req.body || {};
    const phoneCheck = otp.normalizePhoneNumber(phone);
    if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });
    const check = await verifyStoredOtp("lookup", "sms", phoneCheck.phone, code);
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    const lookupToken = otp.signLookupToken(phoneCheck.phone);
    res.json({ ok: true, phone: phoneCheck.phone, lookupToken });
  })
);

app.post(
  "/api/auth/logout",
  ah(async (req, res) => {
    const token = extractToken(req);
    if (token) await db.deleteSession(token);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  })
);

app.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.json({ ok: true, user: null });
  const { token, ...user } = req.user;
  res.json({ ok: true, token, user });
});

app.get("/api/db-status", (req, res) => {
  res.json({
    ...db.getDbStatus(),
    otpProviders: {
      email: otp.isEmailProviderConfigured(),
      sms: otp.isSmsProviderConfigured(),
    },
  });
});

/* ------------------------------ PAYMENTS API ------------------------------- */
const luhn = (num) => {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
};

function cardBrand(num) {
  if (/^4/.test(num)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(num)) return "Mastercard";
  if (/^3[47]/.test(num)) return "Amex";
  if (/^(60|65|81|82|508)/.test(num)) return "RuPay";
  if (/^35/.test(num)) return "JCB";
  return "Card";
}

app.post(
  "/api/payments",
  ah(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to complete payment.", code: "auth_required" });
    const { appointment_id, card_number, card_name, expiry, cvv } = req.body || {};
    const appt = await db.getAppointmentById(Number(appointment_id));
    if (!appt) return res.status(404).json({ error: "Appointment not found." });
    if (!userCanAccessAppt(req, appt)) {
      return res.status(403).json({ error: "That booking belongs to another patient." });
    }
    if (appt.payment_status === "paid") return res.status(409).json({ error: "This appointment is already paid for." });
    if (appt.status === "cancelled") return res.status(400).json({ error: "A cancelled appointment cannot be paid." });

    const digits = String(card_number || "").replace(/[\s-]/g, "");
    if (!/^\d{13,19}$/.test(digits)) return res.status(400).json({ error: "Enter a valid card number (13–19 digits)." });
    if (!luhn(digits)) return res.status(400).json({ error: "That card number failed validation — please re-check it." });
    if (!String(card_name || "").trim()) return res.status(400).json({ error: "Cardholder name is required." });

    const m = String(expiry || "").match(/^(\d{2})\s*\/\s*(\d{2})$/);
    if (!m) return res.status(400).json({ error: "Expiry must be in MM/YY format." });
    const mm = Number(m[1]);
    const yy = 2000 + Number(m[2]);
    const nowD = db.nowIST();
    if (mm < 1 || mm > 12) return res.status(400).json({ error: "Expiry month must be between 01 and 12." });
    if (yy < nowD.getUTCFullYear() || (yy === nowD.getUTCFullYear() && mm < nowD.getUTCMonth() + 1)) {
      return res.status(400).json({ error: "That card has expired." });
    }
    if (!/^\d{3,4}$/.test(String(cvv || ""))) return res.status(400).json({ error: "CVV must be 3 or 4 digits." });
    if (digits.endsWith("0002")) {
      return res.status(402).json({ error: "Card declined by the issuer — try another card." });
    }

    const txnId = "MC-" + Date.now().toString(36).toUpperCase() + "-" + String(Math.floor(Math.random() * 900) + 100);
    const payment = await db.createPayment({
      appointment_id: appt.id,
      user_id: req.user.id,
      amount: appt.fee,
      method: "card",
      card_brand: cardBrand(digits),
      card_last4: digits.slice(-4),
      txn_id: txnId,
    });
    const updated = await db.getAppointmentById(appt.id);
    res.status(201).json({ payment, appointment: updated });
  })
);

app.get(
  "/api/payments/:id",
  ah(async (req, res) => {
    const payment = await db.getPaymentById(Number(req.params.id));
    if (!payment) return res.status(404).json({ error: "Payment not found." });
    if (!req.user) return res.status(401).json({ error: "Sign in to view this receipt.", code: "auth_required" });
    if (req.user.role !== "admin" && Number(payment.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "That receipt belongs to another patient." });
    }
    res.json(payment);
  })
);

app.post(
  "/api/payments/:id/refund",
  ah(async (req, res) => {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({ error: "Only an admin can issue refunds." });
    }
    const existing = await db.getPaymentById(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: "Payment not found." });
    if (existing.status === "refunded") return res.status(409).json({ error: "This payment was already refunded." });
    const payment = await db.refundPayment(existing.id);
    res.json({ refunded: true, payment });
  })
);

/* --------------------------- ALEX — trainable model ------------------------- */
app.get(
  "/api/alex/model",
  ah(async (req, res) => {
    res.json(await db.listAlexExamples());
  })
);

app.post(
  "/api/alex/feedback",
  ah(async (req, res) => {
    const { text, intent } = req.body || {};
    const norm = String(text || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
    if (!norm || !intent) return res.status(400).json({ error: "text and intent are required." });
    await db.recordAlexFeedback(norm, intent);
    res.json({ ok: true });
  })
);

/* --------------------------------- DOCTORS API ------------------------------ */
app.get(
  "/api/doctors",
  ah(async (req, res) => {
    const rows = await db.listDoctors(req.query.specialty || null);
    res.json(rows);
  })
);

app.post(
  "/api/doctors",
  ah(async (req, res) => {
    const { name, specialty, department, fee, rating, experience, bio, days } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Doctor name is required." });
    if (!specialty || !String(specialty).trim()) return res.status(400).json({ error: "Specialty is required." });
    const feeNum = Number(fee);
    if (!Number.isFinite(feeNum) || feeNum < 0) return res.status(400).json({ error: "Fee must be a non-negative number." });
    const daysArr = Array.isArray(days) ? days.filter((d) => db.DAY_NAMES.includes(d)) : [];
    if (!daysArr.length) return res.status(400).json({ error: "Select at least one working day." });

    const created = await db.createDoctor({ name, specialty, department, fee: feeNum, rating, experience, bio, days: daysArr });
    res.status(201).json(created);
  })
);

app.put(
  "/api/doctors/:id",
  ah(async (req, res) => {
    const existing = await db.getDoctor(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: "Doctor not found." });
    const merged = { ...existing, ...req.body };
    if (!merged.name || !String(merged.name).trim()) return res.status(400).json({ error: "Doctor name is required." });
    if (!merged.specialty || !String(merged.specialty).trim()) return res.status(400).json({ error: "Specialty is required." });
    const feeNum = Number(merged.fee);
    if (!Number.isFinite(feeNum) || feeNum < 0) return res.status(400).json({ error: "Fee must be a non-negative number." });
    const daysArr = Array.isArray(merged.days) ? merged.days.filter((d) => db.DAY_NAMES.includes(d)) : existing.days;
    if (!daysArr.length) return res.status(400).json({ error: "Select at least one working day." });

    const updated = await db.updateDoctor(existing.id, {
      name: String(merged.name).trim(),
      specialty: String(merged.specialty).trim(),
      department: (merged.department || merged.specialty).trim(),
      fee: feeNum,
      rating: Number(merged.rating) || existing.rating,
      experience: Number(merged.experience) || existing.experience,
      bio: merged.bio || null,
      days: daysArr,
    });
    res.json(updated);
  })
);

app.delete(
  "/api/doctors/:id",
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const doctor = await db.getDoctor(id);
    if (!doctor) return res.status(404).json({ error: "Doctor not found." });
    const apptCount = await db.countDoctorAppointments(id);
    if (apptCount > 0) {
      return res.status(409).json({
        error: `${doctor.name} still has ${apptCount} appointment record(s). Cancel or delete those bookings first.`,
      });
    }
    await db.deleteDoctor(id);
    res.json({ deleted: true, id });
  })
);

/* ------------------------------- APPOINTMENTS API --------------------------- */
app.post(
  "/api/appointments/emergency",
  ah(async (req, res) => {
    const { patient_name, phone, email, specialty, reason } = req.body || {};
    if (!patient_name || String(patient_name).trim().length < 2) {
      return res.status(400).json({ error: "Patient name is required." });
    }
    const phoneCheck = otp.normalizePhoneNumber(phone);
    if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });

    let cleanEmail = null;
    if (email && String(email).trim()) {
      const emailCheck = await otp.validateEmailAddress(email);
      if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });
      cleanEmail = emailCheck.email;
    }

    let doctors = await db.listDoctors();
    if (specialty) {
      const match = doctors.filter((d) => d.specialty.toLowerCase() === String(specialty).toLowerCase());
      if (match.length) doctors = match;
    }
    if (!doctors.length) return res.status(400).json({ error: "No doctor available for that specialty." });

    const istNow = db.nowIST();
    const currentMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
    let best = null;

    for (let offset = 0; offset <= 6 && !best; offset++) {
      const date = db.isoDateOffsetIST(offset);
      const workingDocs = doctors.filter((doc) => db.doctorWorksOn(doc, date));
      const maps = await Promise.all(workingDocs.map((doc) => db.bookedMap(doc.id, date)));
      for (let i = 0; i < workingDocs.length && !best; i++) {
        const doc = workingDocs[i];
        const booked = maps[i];
        for (const t of db.SLOT_TIMES) {
          if (!booked.has(t)) {
            if (offset === 0) {
              const [h, m] = t.split(":").map(Number);
              if (h * 60 + m <= currentMin + 30) continue;
            }
            best = { doctor: doc, date, time: t };
            break;
          }
        }
      }
    }
    if (!best) {
      return res.status(409).json({ error: "No free slot found in the next 7 days. Please try again later." });
    }

    const created = await db.createAppointment({
      patient_name: String(patient_name).trim(),
      phone: phoneCheck.phone,
      email: cleanEmail || (req.user ? req.user.email : null),
      doctor_id: best.doctor.id,
      appt_date: best.date,
      slot_time: best.time,
      reason: reason || "Emergency booking",
      emergency: 1,
      notes: `Emergency booking on ${db.formatStampIST()} — slot auto-assigned to earliest availability.`,
      user_id: req.user ? req.user.id : null,
    });

    otp.sendBookingConfirmationEmail(created).catch(() => {});
    res.status(201).json({
      ...created,
      lookupToken: otp.signLookupToken(phoneCheck.phone),
    });
  })
);

app.get(
  "/api/slots",
  ah(async (req, res) => {
    const { doctorId, date } = req.query;
    const doctor = await db.getDoctor(Number(doctorId));
    if (!doctor) return res.status(404).json({ error: "Doctor not found." });
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "A date in YYYY-MM-DD format is required." });
    }
    const works = db.doctorWorksOn(doctor, date);
    const booked = works ? await db.bookedMap(doctor.id, date) : new Map();
    const hideNames = !req.user || req.user.role !== "admin";
    res.json({
      doctor: doctor.name,
      date,
      working: works,
      weekday: db.weekdayOf(date),
      slots: db.SLOT_TIMES.map((t) => ({
        time: t,
        available: works && !booked.has(t),
        booked_by: booked.has(t) ? (hideNames ? "Booked" : booked.get(t)) : null,
      })),
    });
  })
);

app.get(
  "/api/appointments",
  ah(async (req, res) => {
    const { search, status, doctorId, phone, from, to, sort = "upcoming", mine } = req.query;
    const rows = await db.listAppointments({
      user: req.user,
      mine: Boolean(mine),
      search,
      status,
      doctorId,
      phone,
      from,
      to,
      sort,
    });
    res.json(rows);
  })
);

app.get(
  "/api/appointments/:id",
  ah(async (req, res) => {
    const row = await db.getAppointmentById(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "Appointment not found." });
    if (!req.user && !hasValidLookupAccess(req, row.phone)) {
      return res.status(401).json({ error: "Sign in to view this appointment.", code: "auth_required" });
    }
    if (!userCanAccessAppt(req, row)) {
      return res.status(403).json({ error: "That booking belongs to another patient." });
    }
    res.json(row);
  })
);

app.get(
  "/api/stats",
  ah(async (req, res) => {
    res.json(await db.getStats());
  })
);

app.post(
  "/api/appointments",
  ah(async (req, res) => {
    const err = await validateBooking(req.body || {});
    if (err) return res.status(400).json({ error: err });

    const { patient_name, phone, email, doctor_id, appt_date, slot_time, reason } = req.body;
    const phoneCheck = otp.normalizePhoneNumber(phone);
    const cleanEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : req.user?.email || null;

    const created = await db.createAppointment({
      patient_name: String(patient_name).trim(),
      phone: phoneCheck.phone,
      email: cleanEmail,
      doctor_id: Number(doctor_id),
      appt_date,
      slot_time,
      reason: reason || null,
      user_id: req.user ? req.user.id : null,
    });

    otp.sendBookingConfirmationEmail(created).catch(() => {});
    res.status(201).json(created);
  })
);

app.put(
  "/api/appointments/:id",
  ah(async (req, res) => {
    const existing = await db.findAppointmentRaw(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: "Appointment not found." });

    const merged = { ...existing, ...req.body };
    const err = await validateBooking(merged, existing.id);
    if (err) return res.status(400).json({ error: err });

    const phoneCheck = otp.normalizePhoneNumber(merged.phone);
    const slotChanged = merged.appt_date !== existing.appt_date || merged.slot_time !== existing.slot_time;
    const updated = await db.updateAppointment(existing.id, {
      ...merged,
      phone: phoneCheck.phone,
    });
    res.json({ ...updated, slot_moved: slotChanged });
  })
);

app.post(
  "/api/appointments/:id/emergency-shift",
  ah(async (req, res) => {
    const existing = await db.findAppointmentRaw(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: "Appointment not found." });
    if (existing.status === "cancelled") {
      return res.status(400).json({ error: "A cancelled booking cannot be shifted." });
    }

    const { new_date, new_slot, allow_swap = false } = req.body || {};
    const err = await validateBooking({ ...existing, appt_date: new_date, slot_time: new_slot }, existing.id, true);
    if (err) return res.status(400).json({ error: err });

    const occupant = await db.findOccupant(existing.doctor_id, new_date, new_slot, existing.id);
    let swappedWith = null;
    const stamp = db.formatStampIST();

    if (occupant) {
      if (!allow_swap) {
        return res.status(409).json({
          error: `${new_slot} on ${new_date} is already taken. Enable swap to exchange slots.`,
        });
      }
      await db.patchAppointmentFields(occupant.id, {
        appt_date: existing.appt_date,
        slot_time: existing.slot_time,
        notes: `Slot swapped on ${stamp} — exchanged due to another patient's emergency.`,
      });
      swappedWith = occupant;
    }

    const updated = await db.patchAppointmentFields(existing.id, {
      appt_date: new_date,
      slot_time: new_slot,
      emergency: 1,
      swapped_from: `${existing.appt_date} ${existing.slot_time}`,
      notes: `Emergency shift on ${stamp}${swappedWith ? ` — swapped with ${swappedWith.patient_name}` : ""}.`,
    });

    res.json({ appointment: updated, swapped_with: swappedWith || null });
  })
);

app.patch(
  "/api/appointments/:id/status",
  ah(async (req, res) => {
    const { status } = req.body || {};
    if (!["confirmed", "cancelled", "completed"].includes(status)) {
      return res.status(400).json({ error: "Status must be confirmed, cancelled or completed." });
    }
    const updated = await db.patchAppointmentFields(Number(req.params.id), { status });
    if (!updated) return res.status(404).json({ error: "Appointment not found." });
    res.json(updated);
  })
);

app.delete(
  "/api/appointments/:id",
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const deleted = await db.deleteAppointment(id);
    if (!deleted) return res.status(404).json({ error: "Appointment not found." });
    res.json({ deleted: true, id });
  })
);

// SPA fallback for non-API GET routes
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error("[Server Error]", err);
  res.status(500).json({ error: err.message || "Internal server error." });
});

if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  db.ensureReady().catch(() => {});
  app.listen(PORT, () => {
    console.log(`MediCare Hospital portal running at http://localhost:${PORT}`);
  });
}

module.exports = app;
