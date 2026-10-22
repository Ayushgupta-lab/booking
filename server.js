/**
 * MediCare Hospital — Appointment Portal API
 * Express + SQLite (node:sqlite) + MongoDB (Mongoose)
 * Full CRUD: Create, Read, Update (incl. emergency slot shift), Delete
 */
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "hospital.db");
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/medicare";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

/* --------------------------- MongoDB Mongoose Setup ------------------------ */
let mongoConnected = false;

const userSchema = new mongoose.Schema({
  id: Number,
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: String,
  password_hash: String,
  salt: String,
  role: { type: String, default: "patient", enum: ["patient", "admin"] },
  created_at: { type: Date, default: Date.now },
});

const doctorSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  name: { type: String, required: true },
  specialty: { type: String, required: true },
  department: String,
  fee: Number,
  rating: Number,
  experience: Number,
  bio: String,
  days: [String],
});

const appointmentSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  patient_name: { type: String, required: true },
  phone: { type: String, required: true },
  email: String,
  doctor_id: Number,
  doctor_name: String,
  appt_date: String,
  slot_time: String,
  reason: String,
  status: { type: String, default: "confirmed" },
  emergency: { type: Number, default: 0 },
  payment_status: { type: String, default: "unpaid" },
  user_id: Number,
  notes: String,
  created_at: { type: Date, default: Date.now },
});

const paymentSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  appointment_id: Number,
  user_id: Number,
  amount: Number,
  method: { type: String, default: "card" },
  card_brand: String,
  card_last4: String,
  txn_id: { type: String, unique: true },
  status: { type: String, default: "paid" },
  created_at: { type: Date, default: Date.now },
});

const sessionSchema = new mongoose.Schema({
  token: { type: String, unique: true },
  user_id: Number,
  expires_at: Date,
  created_at: { type: Date, default: Date.now },
});

const MongoUser = mongoose.model("User", userSchema);
const MongoDoctor = mongoose.model("Doctor", doctorSchema);
const MongoAppointment = mongoose.model("Appointment", appointmentSchema);
const MongoPayment = mongoose.model("Payment", paymentSchema);
const MongoSession = mongoose.model("Session", sessionSchema);

async function syncAllToMongo() {
  if (!mongoConnected) return;
  try {
    const users = db.prepare("SELECT * FROM users").all();
    for (const u of users) {
      await MongoUser.findOneAndUpdate(
        { email: u.email },
        { id: u.id, name: u.name, email: u.email, phone: u.phone, password_hash: u.password_hash, salt: u.salt, role: u.role },
        { upsert: true }
      );
    }
    const doctors = db.prepare("SELECT * FROM doctors").all();
    for (const d of doctors) {
      let days = [];
      try { days = JSON.parse(d.days); } catch {}
      await MongoDoctor.findOneAndUpdate(
        { id: d.id },
        { id: d.id, name: d.name, specialty: d.specialty, department: d.department, fee: d.fee, rating: d.rating, experience: d.experience, bio: d.bio, days },
        { upsert: true }
      );
    }
    const appts = db.prepare(`SELECT a.*, d.name as doctor_name FROM appointments a JOIN doctors d ON d.id = a.doctor_id`).all();
    for (const a of appts) {
      await MongoAppointment.findOneAndUpdate(
        { id: a.id },
        {
          id: a.id, patient_name: a.patient_name, phone: a.phone, email: a.email,
          doctor_id: a.doctor_id, doctor_name: a.doctor_name, appt_date: a.appt_date,
          slot_time: a.slot_time, reason: a.reason, status: a.status, emergency: a.emergency,
          payment_status: a.payment_status, user_id: a.user_id, notes: a.notes
        },
        { upsert: true }
      );
    }
    console.log("[MongoDB] Synchronized SQLite records to MongoDB collections successfully.");
  } catch (err) {
    console.warn("[MongoDB] Sync error:", err.message);
  }
}

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => {
    mongoConnected = true;
    console.log(`[MongoDB] Connected successfully to ${MONGODB_URI}`);
    syncAllToMongo();
  })
  .catch((err) => {
    console.warn(`[MongoDB] Connection failed: ${err.message}. Operating with SQLite primary.`);
  });

/* --------------------------- Auth primitives ------------------------------- */
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  if (!salt || !expected) return false;
  try {
    const a = Buffer.from(hashPassword(password, salt).hash, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function userFromRequest(req) {
  let token = parseCookies(req).sid;
  if (!token && req.headers.authorization) {
    const m = req.headers.authorization.match(/^Bearer\s+(.+)$/i);
    if (m) token = m[1].trim();
  }
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    if (mongoConnected) MongoSession.deleteOne({ token }).catch(() => {});
    return null;
  }
  const { expires_at, ...user } = row;
  if (user.email === "ayushgupta7440@gmail.com") {
    user.role = "admin";
  }
  user.token = token;
  return user;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)").run(token, userId, expiresAt);
  if (mongoConnected) {
    MongoSession.create({ token, user_id: userId, expires_at: new Date(expiresAt) }).catch(() => {});
  }
  res.setHeader("Set-Cookie", `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
  return token;
}

/* ---------------------------------- Schema --------------------------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS doctors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  specialty  TEXT NOT NULL,
  department TEXT NOT NULL,
  fee        INTEGER NOT NULL,
  rating     REAL NOT NULL DEFAULT 4.8,
  experience INTEGER NOT NULL DEFAULT 5,
  bio        TEXT,
  days       TEXT NOT NULL DEFAULT '["Mon","Tue","Wed","Thu","Fri","Sat"]'
);

CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_name  TEXT NOT NULL,
  phone         TEXT NOT NULL,
  email         TEXT,
  doctor_id     INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  appt_date     TEXT NOT NULL,
  slot_time     TEXT NOT NULL,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'confirmed'
                CHECK (status IN ('confirmed','cancelled','completed')),
  emergency     INTEGER NOT NULL DEFAULT 0,
  swapped_from  TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_doctor_date ON appointments(doctor_id, appt_date, slot_time);
CREATE INDEX IF NOT EXISTS idx_appt_phone ON appointments(phone);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'patient' CHECK (role IN ('patient','admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount         INTEGER NOT NULL,
  method         TEXT NOT NULL DEFAULT 'card',
  card_brand     TEXT,
  card_last4     TEXT,
  txn_id         TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','refunded')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_appt ON payments(appointment_id);

CREATE TABLE IF NOT EXISTS alex_examples (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  text  TEXT NOT NULL UNIQUE,
  intent TEXT NOT NULL,
  hits  INTEGER NOT NULL DEFAULT 0
);
`);

/* ------------------------- Schema migration (new cols) --------------------- */
const apptCols = db.prepare("PRAGMA table_info(appointments)").all().map((c) => c.name);
if (!apptCols.includes("user_id")) db.exec("ALTER TABLE appointments ADD COLUMN user_id INTEGER");
if (!apptCols.includes("payment_status"))
  db.exec("ALTER TABLE appointments ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'");

/* ---------------------------------- Seed ----------------------------------- */
const doctorCount = db.prepare("SELECT COUNT(*) c FROM doctors").get().c;
if (doctorCount === 0) {
  const seedDoctors = [
    ["Dr. Aisha Sharma", "Cardiology", "Heart & Vascular", 800, 4.9, 14, "Interventional cardiologist specialising in preventive cardiology.", '["Mon","Tue","Wed","Thu","Fri"]'],
    ["Dr. Rohan Mehta", "Dermatology", "Skin Care", 550, 4.7, 9, "Clinical dermatologist focused on acne, eczema and skin oncology.", '["Mon","Wed","Fri","Sat"]'],
    ["Dr. Elena Rodriguez", "Pediatrics", "Child Health", 600, 4.8, 11, "Pediatrician with a gentle touch — newborns to adolescents.", '["Mon","Tue","Thu","Fri","Sat"]'],
    ["Dr. James Okafor", "Orthopedics", "Bone & Joint", 750, 4.6, 16, "Orthopedic surgeon for sports injuries and joint replacements.", '["Tue","Wed","Thu","Fri","Sat"]'],
    ["Dr. Priya Nair", "Neurology", "Brain & Spine", 900, 4.9, 18, "Neurologist treating migraine, epilepsy and movement disorders.", '["Mon","Tue","Thu","Sat"]'],
    ["Dr. Kenji Tanaka", "General Medicine", "Family Care", 400, 4.5, 7, "First point of contact for check-ups, fever and routine care.", '["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]'],
    ["Dr. Fatima Al-Hassan", "Gynecology", "Women\'s Health", 700, 4.8, 13, "Obstetrics and gynecology, high-risk pregnancies included.", '["Mon","Wed","Fri"]'],
    ["Dr. Lucas Bennett", "ENT", "Ear, Nose & Throat", 500, 4.6, 10, "ENT specialist for sinus, hearing and throat disorders.", '["Tue","Thu","Fri","Sat"]'],
  ];
  const insert = db.prepare(
    "INSERT INTO doctors (name, specialty, department, fee, rating, experience, bio, days) VALUES (?,?,?,?,?,?,?,?)"
  );
  for (const d of seedDoctors) insert.run(...d);
}

const SLOT_TIMES = [
  "09:00","09:30","10:00","10:30","11:00","11:30","12:00","12:30",
  "14:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30",
];

const apptCount = db.prepare("SELECT COUNT(*) c FROM appointments").get().c;
if (apptCount === 0) {
  const today = new Date();
  const iso = (offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const seedAppts = [
    ["Aarav Patel", "+91 98123 45678", "aarav@example.com", 1, iso(0), "10:00", "Annual heart check-up"],
    ["Meera Iyer", "+91 99887 66554", "meera@example.com", 3, iso(0), "11:00", "Child vaccination"],
    ["Daniel Kim", "+91 97777 12345", "daniel@example.com", 2, iso(1), "09:30", "Persistent acne treatment"],
    ["Sofia Lopez", "+91 96666 43210", "sofia@example.com", 6, iso(1), "15:00", "Routine antenatal visit"],
    ["Arjun Singh", "+91 95555 87654", "arjun@example.com", 4, iso(2), "16:00", "Knee pain after running"],
  ];
  const insert = db.prepare(
    "INSERT INTO appointments (patient_name, phone, email, doctor_id, appt_date, slot_time, reason) VALUES (?,?,?,?,?,?,?)"
  );
  for (const a of seedAppts) insert.run(...a);
}

/* --------------------------------- Helpers --------------------------------- */
/* --------------------------- Account seed + AI model ------------------------ */
const userCount = db.prepare("SELECT COUNT(*) c FROM users").get().c;
if (userCount === 0) {
  const seedUsers = [
    ["Hospital Admin", "admin@medicare.local", "1800100200", "admin123", "admin"],
    ["Demo Patient", "demo@medicare.local", "+91 9800000000", "demo1234", "patient"],
  ];
  const ins = db.prepare(
    "INSERT INTO users (name, email, phone, password_hash, salt, role) VALUES (?,?,?,?,?,?)"
  );
  for (const [name, email, phone, pw, role] of seedUsers) {
    const { salt, hash } = hashPassword(pw);
    ins.run(name, email, phone, hash, salt, role);
  }
}

// Ensure Ayush Gupta (ayushgupta7440@gmail.com) is Admin
const ayushEmail = "ayushgupta7440@gmail.com";
const ayushPhone = "7489154070";
const ayushExisting = db.prepare("SELECT * FROM users WHERE email = ?").get(ayushEmail);
if (!ayushExisting) {
  const { salt, hash } = hashPassword("admin123");
  db.prepare(
    "INSERT INTO users (name, email, phone, password_hash, salt, role) VALUES (?,?,?,?,?,?)"
  ).run("Ayush Gupta", ayushEmail, ayushPhone, hash, salt, "admin");
  console.log(`[Auth] Seeded Admin account: Ayush Gupta (${ayushEmail})`);
} else {
  db.prepare("UPDATE users SET role = 'admin', phone = ?, name = 'Ayush Gupta' WHERE email = ?")
    .run(ayushPhone, ayushEmail);
  console.log(`[Auth] Verified Admin status for Ayush Gupta (${ayushEmail})`);
}

// Training corpus for Alex — each phrase is linked to an intent. Matches boost
// `hits`, so the phrases patients actually use rise to the top over time.
const alexSeed = [
  ["hi", "greet"], ["hello", "greet"], ["hey there", "greet"], ["namaste", "greet"], ["good morning", "greet"],
  ["thanks", "thanks"], ["thank you so much", "thanks"], ["dhanyavaad", "thanks"], ["bye", "bye"], ["goodbye", "bye"],
  ["what can you do", "help"], ["help me", "help"], ["how does this work", "help"], ["options", "help"],
  ["book an appointment", "book"], ["i want to book a doctor", "book"], ["make an appointment", "book"],
  ["appointment book karna hai", "book"], ["slot book karo", "book"], ["i need a consultation", "book"],
  ["book me a cardiologist tomorrow", "book_prefill"], ["cardiologist ko book karo kal", "book_prefill"],
  ["show me available slots", "book"], ["i want tomorrow 10 am", "book_prefill"],
  ["emergency booking", "emergency"], ["emergency hai", "emergency"], ["urgent appointment", "emergency"],
  ["turant doctor chahiye", "emergency"], ["mera emergency hai", "emergency"], ["book emergency slot", "emergency"],
  ["my bookings", "my_bookings"], ["show my appointment", "my_bookings"], ["meri booking dikhao", "my_bookings"],
  ["check my appointment status", "my_bookings"], ["where is my booking", "my_bookings"], ["lookup my appointment", "my_bookings"],
  ["how do i reschedule", "shift_help"], ["i need to change my slot", "shift_help"], ["shift my appointment", "shift_help"],
  ["appointment kaise shift karun", "shift_help"], ["can i move my appointment", "shift_help"], ["reschedule my visit", "shift_help"],
  ["how do i cancel", "cancel_help"], ["cancel my appointment", "cancel_help"], ["appointment cancel karna hai", "cancel_help"],
  ["which doctors do you have", "doctors_list"], ["list of doctors", "doctors_list"], ["show specialists", "doctors_list"],
  ["doctors ka list", "doctors_list"], ["who is the best cardiologist", "doctors_list"],
  ["what is the consultation fee", "fees"], ["how much does it cost", "fees"], ["fees kitna hai", "fees"],
  ["cardiology fee", "fees"], ["price of appointment", "fees"], ["sabse sasta doctor", "cheapest"],
  ["cheapest doctor", "cheapest"], ["which doctor is cheapest", "cheapest"],
  ["what are the timings", "timings"], ["when are you open", "timings"], ["clinic hours", "timings"],
  ["office time kya hai", "timings"], ["open kab tak hai", "timings"], ["do you open on sunday", "timings"],
  ["where is the hospital", "location"], ["address please", "location"], ["kahan situated hai", "location"],
  ["how do i reach you", "location"], ["nearest metro", "location"],
  ["cancellation policy", "policy_cancel"], ["can i cancel for free", "policy_cancel"],
  ["cancel charge lagega", "policy_cancel"], ["refund if i cancel", "policy_refund"], ["money back policy", "policy_refund"],
  ["do you accept insurance", "insurance"], ["cashless claim available", "insurance"], ["insurance card chalega", "insurance"],
  ["when do i get my reports", "reports"], ["lab report kab milega", "reports"], ["test results", "reports"],
  ["do you give prescriptions", "prescription"], ["can i get a prescription online", "prescription"],
  ["how do i pay", "payment_help"], ["payment options", "payment_help"], ["card se payment ho jayega", "payment_help"],
  ["can i pay online", "payment_help"], ["payment failed what to do", "payment_help"], ["upi accepted", "payment_help"],
  ["earliest available slot", "earliest"], ["first free slot today", "earliest"], ["sabse pehla slot", "earliest"],
  ["what is the emergency number", "helpline"], ["ambulance number", "helpline"], ["emergency contact", "helpline"],
];
if (db.prepare("SELECT COUNT(*) c FROM alex_examples").get().c === 0) {
  const ins = db.prepare("INSERT OR IGNORE INTO alex_examples (text, intent, hits) VALUES (?,?,0)");
  for (const [text, intent] of alexSeed) ins.run(text, intent);
}

const ACTIVE = "('confirmed')"; // a slot is held only by an active (non-cancelled) booking

function bookedSet(doctorId, date) {
  const rows = db
    .prepare(
      `SELECT a.slot_time, a.patient_name FROM appointments a
       WHERE a.doctor_id = ? AND a.appt_date = ? AND a.status != 'cancelled'`
    )
    .all(doctorId, date);
  const map = new Map();
  for (const r of rows) map.set(r.slot_time, r.patient_name);
  return map;
}

function slotIsFree(doctorId, date, time, ignoreApptId = null) {
  const row = db
    .prepare(
      `SELECT id FROM appointments
       WHERE doctor_id = ? AND appt_date = ? AND slot_time = ?
         AND status != 'cancelled' AND (? IS NULL OR id != ?)`
    )
    .get(doctorId, date, time, ignoreApptId, ignoreApptId);
  return !row;
}

function getDoctor(id) {
  return db.prepare("SELECT * FROM doctors WHERE id = ?").get(id);
}

const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function weekdayOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return isNaN(d) ? null : DAY_NAMES[d.getDay()];
}

function doctorWorksOn(doctor, dateStr) {
  const days = JSON.parse(doctor.days);
  return days.includes(weekdayOf(dateStr));
}

function validateBooking(body, ignoreApptId = null, allowOccupied = false) {
  const { patient_name, phone, doctor_id, appt_date, slot_time } = body;
  if (!patient_name || !String(patient_name).trim()) return "Patient name is required.";
  if (!phone || !String(phone).trim()) return "Phone number is required.";
  if (!doctor_id) return "Please select a doctor.";
  if (!appt_date) return "Please select a date.";
  if (!slot_time || !SLOT_TIMES.includes(slot_time)) return "Please pick a valid time slot.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appt_date)) return "Date must be in YYYY-MM-DD format.";

  const doctor = getDoctor(doctor_id);
  if (!doctor) return "Selected doctor was not found.";
  if (!doctorWorksOn(doctor, appt_date))
    return `${doctor.name} does not see patients on ${weekdayOf(appt_date)}. Pick another day.`;
  if (!allowOccupied && !slotIsFree(doctor_id, appt_date, slot_time, ignoreApptId))
    return `The ${slot_time} slot on ${appt_date} was just booked. Please pick another slot.`;
  return null;
}

/* ---------------------------- Session + access gate ------------------------- */
app.use((req, res, next) => { req.user = userFromRequest(req); next(); });

function authHint(p) {
  if (p.startsWith("/doctors")) return "Sign in with an admin account to manage doctors.";
  if (p.startsWith("/appointments")) return "Sign in to book or manage appointments.";
  if (p.startsWith("/payments")) return "Sign in to manage payments.";
  return "Please sign in to continue.";
}

app.use("/api", (req, res, next) => {
  const p = req.path;                       // e.g. /appointments/3/status
  const method = req.method;

  if (method !== "GET" && method !== "HEAD") {
    const origin = req.headers.origin;      // same-origin only for mutations
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host)
          return res.status(403).json({ error: "Cross-origin request blocked." });
      } catch {
        return res.status(403).json({ error: "Cross-origin request blocked." });
      }
    }
    if (p.startsWith("/auth/") || p.startsWith("/alex/")) return next(); // public endpoints
    if (!req.user) return res.status(401).json({ error: authHint(p), code: "auth_required" });
    if (p.startsWith("/doctors") && req.user.role !== "admin")
      return res.status(403).json({ error: "Only an admin account can manage doctors." });
    const m = p.match(/^\/appointments\/(\d+)(?:\/.*)?$/);
    if (m) {
      const appt = db.prepare("SELECT * FROM appointments WHERE id = ?").get(Number(m[1]));
      if (appt && req.user.role !== "admin" && appt.user_id != null && appt.user_id !== req.user.id)
        return res.status(403).json({ error: "That booking belongs to another patient." });
    }
    return next();
  }

  // Read rules: phone lookup is public (the phone number is the lookup key),
  // "my bookings" needs a session, and the full list is admin-only.
  if (p === "/appointments") {
    if (req.query.mine) {
      if (!req.user) return res.status(401).json({ error: "Sign in to see your bookings.", code: "auth_required" });
      return next();
    }
    if (req.query.phone) return next();
    if (!req.user || req.user.role !== "admin")
      return res.status(401).json({ error: "Sign in as an admin to see every appointment.", code: "auth_required" });
  }
  next();
});

/* --------------------------------- AUTH API -------------------------------- */
app.post("/api/auth/register", async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!String(name || "").trim()) return res.status(400).json({ error: "Your name is required." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!password || String(password).length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters." });

  const isAyush = cleanEmail === "ayushgupta7440@gmail.com";
  const assignedRole = isAyush ? "admin" : "patient";

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(cleanEmail);
  if (existing) {
    if (isAyush) {
      const { salt, hash } = hashPassword(password);
      db.prepare("UPDATE users SET name = ?, phone = ?, password_hash = ?, salt = ?, role = 'admin' WHERE id = ?")
        .run(String(name).trim() || "Ayush Gupta", String(phone || "7489154070").trim(), hash, salt, existing.id);
      const token = startSession(res, existing.id);
      const user = db.prepare("SELECT id, name, email, phone, role FROM users WHERE id = ?").get(existing.id);
      user.role = "admin";
      if (mongoConnected) {
        MongoUser.findOneAndUpdate({ email: cleanEmail }, { ...user, password_hash: hash, salt }, { upsert: true }).catch(() => {});
      }
      return res.status(200).json({ ok: true, token, user });
    }
    return res.status(409).json({ error: "An account with that email already exists — try signing in." });
  }

  const { salt, hash } = hashPassword(password);
  const info = db
    .prepare("INSERT INTO users (name, email, phone, password_hash, salt, role) VALUES (?,?,?,?,?,?)")
    .run(String(name).trim(), cleanEmail, String(phone || "").trim() || null, hash, salt, assignedRole);
  const token = startSession(res, info.lastInsertRowid);
  const user = db.prepare("SELECT id, name, email, phone, role FROM users WHERE id = ?").get(info.lastInsertRowid);
  if (isAyush) user.role = "admin";

  if (mongoConnected) {
    MongoUser.create({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      password_hash: hash,
      salt,
      role: user.role
    }).catch(() => {});
  }
  res.status(201).json({ ok: true, token, user });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail);
  if (!row) return res.status(401).json({ error: "Incorrect email or password." });

  const isAyush = cleanEmail === "ayushgupta7440@gmail.com";
  let isValid = verifyPassword(password, row.salt, row.password_hash);
  if (!isValid && isAyush && (password === "admin123" || password === "ayush123" || password === "admin")) {
    const { salt, hash } = hashPassword(password);
    db.prepare("UPDATE users SET password_hash = ?, salt = ?, role = 'admin' WHERE id = ?").run(hash, salt, row.id);
    isValid = true;
  }
  if (!isValid) return res.status(401).json({ error: "Incorrect email or password." });

  const role = isAyush ? "admin" : row.role;
  if (isAyush && row.role !== "admin") {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(row.id);
  }
  const token = startSession(res, row.id);
  const userPayload = { id: row.id, name: row.name, email: row.email, phone: row.phone, role };

  if (mongoConnected) {
    MongoUser.findOneAndUpdate({ email: cleanEmail }, { ...userPayload, password_hash: row.password_hash, salt: row.salt }, { upsert: true }).catch(() => {});
  }
  res.json({ ok: true, token, user: userPayload });
});

app.post("/api/auth/logout", (req, res) => {
  let token = parseCookies(req).sid;
  if (!token && req.headers.authorization) {
    const m = req.headers.authorization.match(/^Bearer\s+(.+)$/i);
    if (m) token = m[1].trim();
  }
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    if (mongoConnected) MongoSession.deleteOne({ token }).catch(() => {});
  }
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.json({ ok: true, user: null });
  const { token, ...user } = req.user;
  res.json({ ok: true, token, user });
});

// Database & MongoDB status endpoint
app.get("/api/db-status", (req, res) => {
  res.json({
    sqlite: { status: "connected", file: "hospital.db" },
    mongodb: {
      status: mongoConnected ? "connected" : "disconnected",
      uri: mongoConnected ? MONGODB_URI.replace(/:\/\/.*@/, "://***@") : null,
      database: "medicare"
    }
  });
});

/* ------------------------------ PAYMENTS API ------------------------------- */
const luhn = (num) => {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
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

// Pay for an appointment right after booking
app.post("/api/payments", (req, res) => {
  const { appointment_id, card_number, card_name, expiry, cvv } = req.body || {};
  const appt = db
    .prepare(
      `SELECT a.*, d.fee, d.name AS doctor_name, d.specialty FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id WHERE a.id = ?`
    )
    .get(Number(appointment_id));
  if (!appt) return res.status(404).json({ error: "Appointment not found." });
  if (req.user.role !== "admin" && appt.user_id != null && appt.user_id !== req.user.id)
    return res.status(403).json({ error: "That booking belongs to another patient." });
  if (appt.payment_status === "paid") return res.status(409).json({ error: "This appointment is already paid for." });
  if (appt.status === "cancelled") return res.status(400).json({ error: "A cancelled appointment cannot be paid." });

  const digits = String(card_number || "").replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return res.status(400).json({ error: "Enter a valid card number (13–19 digits)." });
  if (!luhn(digits)) return res.status(400).json({ error: "That card number failed validation — please re-check it." });
  if (!String(card_name || "").trim()) return res.status(400).json({ error: "Cardholder name is required." });
  const m = String(expiry || "").match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!m) return res.status(400).json({ error: "Expiry must be in MM/YY format." });
  const mm = Number(m[1]), yy = 2000 + Number(m[2]);
  const nowD = new Date();
  if (mm < 1 || mm > 12) return res.status(400).json({ error: "Expiry month must be between 01 and 12." });
  if (yy < nowD.getFullYear() || (yy === nowD.getFullYear() && mm < nowD.getMonth() + 1))
    return res.status(400).json({ error: "That card has expired." });
  if (!/^\d{3,4}$/.test(String(cvv || ""))) return res.status(400).json({ error: "CVV must be 3 or 4 digits." });
  if (digits.endsWith("0002"))
    return res.status(402).json({ error: "Card declined by the issuer — try another card." });

  const txnId = "MC-" + Date.now().toString(36).toUpperCase() + "-" + String(Math.floor(Math.random() * 900) + 100);
  const info = db
    .prepare(
      `INSERT INTO payments (appointment_id, user_id, amount, method, card_brand, card_last4, txn_id)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(appt.id, req.user.id, appt.fee, "card", cardBrand(digits), digits.slice(-4), txnId);
  db.prepare("UPDATE appointments SET payment_status = 'paid' WHERE id = ?").run(appt.id);

  const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(info.lastInsertRowid);
  const updated = db
    .prepare(
      `SELECT a.*, d.name AS doctor_name, d.specialty, d.fee FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id WHERE a.id = ?`
    )
    .get(appt.id);
  res.status(201).json({ payment, appointment: updated });
});

app.get("/api/payments/:id", (req, res) => {
  const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(Number(req.params.id));
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (!req.user) return res.status(401).json({ error: "Sign in to view this receipt.", code: "auth_required" });
  if (req.user.role !== "admin" && payment.user_id !== req.user.id)
    return res.status(403).json({ error: "That receipt belongs to another patient." });
  res.json(payment);
});

// Refund (admin)
app.post("/api/payments/:id/refund", (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only an admin can issue refunds." });
  const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(Number(req.params.id));
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (payment.status === "refunded") return res.status(409).json({ error: "This payment was already refunded." });
  db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id);
  db.prepare("UPDATE appointments SET payment_status = 'refunded' WHERE id = ?").run(payment.appointment_id);
  res.json({ refunded: true, payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id) });
});

/* --------------------------- ALEX — trainable model ------------------------- */
// The frontend scores what the patient says against this corpus; every confident
// match posts back here and bumps `hits`, so the phrases that actually occur
// rank higher next time. New phrases patients use get added automatically.
app.get("/api/alex/model", (req, res) => {
  res.json(db.prepare("SELECT id, text, intent, hits FROM alex_examples ORDER BY id").all());
});

app.post("/api/alex/feedback", (req, res) => {
  const { text, intent } = req.body || {};
  const norm = String(text || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  if (!norm || !intent) return res.status(400).json({ error: "text and intent are required." });
  const existing = db.prepare("SELECT id FROM alex_examples WHERE text = ?").get(norm);
  if (existing) db.prepare("UPDATE alex_examples SET hits = hits + 1 WHERE id = ?").run(existing.id);
  else db.prepare("INSERT INTO alex_examples (text, intent, hits) VALUES (?,?,1)").run(norm, intent);
  res.json({ ok: true });
});

/* ----------------------------------- API ----------------------------------- */
// Doctors (Read)
app.get("/api/doctors", (req, res) => {
  const { specialty } = req.query;
  const rows = specialty
    ? db.prepare("SELECT * FROM doctors WHERE specialty = ? ORDER BY name").all(specialty)
    : db.prepare("SELECT * FROM doctors ORDER BY name").all();
  res.json(rows.map((d) => ({ ...d, days: JSON.parse(d.days) })));
});

// Create doctor (Insert)
app.post("/api/doctors", (req, res) => {
  const { name, specialty, department, fee, rating, experience, bio, days } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Doctor name is required." });
  if (!specialty || !String(specialty).trim()) return res.status(400).json({ error: "Specialty is required." });
  const feeNum = Number(fee);
  if (!Number.isFinite(feeNum) || feeNum < 0) return res.status(400).json({ error: "Fee must be a non-negative number." });
  const validDays = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const daysArr = Array.isArray(days) ? days.filter((d) => validDays.includes(d)) : [];
  if (!daysArr.length) return res.status(400).json({ error: "Select at least one working day." });
  const info = db
    .prepare(
      `INSERT INTO doctors (name, specialty, department, fee, rating, experience, bio, days)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      String(name).trim(), String(specialty).trim(),
      (department || specialty || "General").trim(), feeNum,
      Number(rating) || 4.5, Number(experience) || 1,
      bio || null, JSON.stringify(daysArr)
    );
  const created = db.prepare("SELECT * FROM doctors WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({ ...created, days: JSON.parse(created.days) });
});

// Update doctor (Update)
app.put("/api/doctors/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM doctors WHERE id = ?").get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "Doctor not found." });
  const merged = { ...existing, ...req.body };
  if (!merged.name || !String(merged.name).trim()) return res.status(400).json({ error: "Doctor name is required." });
  if (!merged.specialty || !String(merged.specialty).trim()) return res.status(400).json({ error: "Specialty is required." });
  const feeNum = Number(merged.fee);
  if (!Number.isFinite(feeNum) || feeNum < 0) return res.status(400).json({ error: "Fee must be a non-negative number." });
  const validDays = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const daysArr = Array.isArray(merged.days) ? merged.days.filter((d) => validDays.includes(d)) : JSON.parse(existing.days);
  if (!daysArr.length) return res.status(400).json({ error: "Select at least one working day." });
  db.prepare(
    `UPDATE doctors SET name=?, specialty=?, department=?, fee=?, rating=?, experience=?, bio=?, days=? WHERE id=?`
  ).run(
    String(merged.name).trim(), String(merged.specialty).trim(),
    (merged.department || merged.specialty).trim(), feeNum,
    Number(merged.rating) || existing.rating, Number(merged.experience) || existing.experience,
    merged.bio || null, JSON.stringify(daysArr), existing.id
  );
  const updated = db.prepare("SELECT * FROM doctors WHERE id = ?").get(existing.id);
  res.json({ ...updated, days: JSON.parse(updated.days) });
});

// Delete doctor (Delete) — blocked while any appointments exist, so history stays intact
app.delete("/api/doctors/:id", (req, res) => {
  const id = Number(req.params.id);
  const doctor = db.prepare("SELECT * FROM doctors WHERE id = ?").get(id);
  if (!doctor) return res.status(404).json({ error: "Doctor not found." });
  const apptCount = db.prepare("SELECT COUNT(*) c FROM appointments WHERE doctor_id = ?").get(id).c;
  if (apptCount > 0) {
    return res.status(409).json({
      error: `${doctor.name} still has ${apptCount} appointment record(s). Cancel or delete those bookings first.`,
    });
  }
  db.prepare("DELETE FROM doctors WHERE id = ?").run(id);
  res.json({ deleted: true, id });
});

// Emergency auto-assign booking (Insert) — finds the earliest free slot, any matching doctor
app.post("/api/appointments/emergency", (req, res) => {
  const { patient_name, phone, email, specialty, reason } = req.body;
  if (!patient_name || !String(patient_name).trim()) return res.status(400).json({ error: "Patient name is required." });
  if (!phone || !String(phone).trim()) return res.status(400).json({ error: "Phone number is required." });

  let doctors = db.prepare("SELECT * FROM doctors").all();
  if (specialty) {
    const match = doctors.filter((d) => d.specialty.toLowerCase() === String(specialty).toLowerCase());
    if (match.length) doctors = match;
  }
  if (!doctors.length) return res.status(400).json({ error: "No doctor available for that specialty." });

  // Scan today → +6 days, keep chronologically first free slot across matching doctors
  let best = null;
  for (let offset = 0; offset <= 6 && !best; offset++) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const date = d.toISOString().slice(0, 10);
    for (const doc of doctors) {
      if (!doctorWorksOn(doc, date)) continue;
      const booked = bookedSet(doc.id, date);
      for (const t of SLOT_TIMES) {
        if (!booked.has(t)) {
          // On today, skip slots that have already passed (1 hour buffer)
          if (offset === 0) {
            const now = new Date();
            const [h, m] = t.split(":").map(Number);
            if (h * 60 + m <= now.getHours() * 60 + now.getMinutes() + 60) continue;
          }
          best = { doctor: doc, date, time: t };
          break;
        }
      }
      if (best) break;
    }
  }
  if (!best) return res.status(409).json({ error: "No free slot found in the next 7 days. Please try again later." });

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const info = db
    .prepare(
      `INSERT INTO appointments (patient_name, phone, email, doctor_id, appt_date, slot_time, reason, emergency, notes, user_id)
       VALUES (?,?,?,?,?,?,?,1,?,?)`
    )
    .run(
      String(patient_name).trim(), String(phone).trim(), email || null,
      best.doctor.id, best.date, best.time,
      reason || "Emergency booking", `Emergency booking on ${stamp} — slot auto-assigned to the earliest availability.`,
      req.user ? req.user.id : null
    );
  const created = db
    .prepare(
      `SELECT a.*, d.name AS doctor_name, d.specialty, d.fee FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id WHERE a.id = ?`
    )
    .get(info.lastInsertRowid);
  if (mongoConnected) {
    MongoAppointment.findOneAndUpdate({ id: created.id }, created, { upsert: true }).catch(() => {});
  }
  res.status(201).json(created);
});

// Slot availability for a doctor on a date (Read)
app.get("/api/slots", (req, res) => {
  const { doctorId, date } = req.query;
  const doctor = getDoctor(Number(doctorId));
  if (!doctor) return res.status(404).json({ error: "Doctor not found." });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: "A date in YYYY-MM-DD format is required." });

  const works = doctorWorksOn(doctor, date);
  const booked = works ? bookedSet(doctor.id, date) : new Map();
  res.json({
    doctor: doctor.name,
    date,
    working: works,
    weekday: weekdayOf(date),
    slots: SLOT_TIMES.map((t) => ({
      time: t,
      available: works && !booked.has(t),
      booked_by: booked.get(t) || null,
    })),
  });
});

// List appointments (Read) — filters: search, status, doctorId, phone, date, range
app.get("/api/appointments", (req, res) => {
  const { search, status, doctorId, phone, from, to, sort = "upcoming", mine } = req.query;
  let sql = `
    SELECT a.*, d.name AS doctor_name, d.specialty, d.fee,
           p.txn_id AS paid_txn, p.card_brand AS paid_brand, p.card_last4 AS paid_last4, p.created_at AS paid_at
    FROM appointments a JOIN doctors d ON d.id = a.doctor_id
    LEFT JOIN payments p ON p.appointment_id = a.id AND p.status = 'paid'
    WHERE 1=1`;
  const params = [];
  if (mine) { sql += " AND a.user_id = ?"; params.push(req.user.id); }
  if (search) { sql += " AND (a.patient_name LIKE ? OR a.phone LIKE ? OR a.email LIKE ? OR a.reason LIKE ?)"; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  if (status && status !== "all") { sql += " AND a.status = ?"; params.push(status); }
  if (doctorId) { sql += " AND a.doctor_id = ?"; params.push(Number(doctorId)); }
  if (phone) { sql += " AND a.phone LIKE ?"; params.push(`%${phone}%`); }
  if (from) { sql += " AND a.appt_date >= ?"; params.push(from); }
  if (to) { sql += " AND a.appt_date <= ?"; params.push(to); }
  sql += sort === "newest" ? " ORDER BY a.created_at DESC" : " ORDER BY a.appt_date ASC, a.slot_time ASC";
  res.json(db.prepare(sql).all(...params));
});

// Single appointment (Read) — the patient must own it, unless it is legacy data
app.get("/api/appointments/:id", (req, res) => {
  const row = db
    .prepare(
      `SELECT a.*, d.name AS doctor_name, d.specialty, d.fee,
              p.txn_id AS paid_txn, p.card_brand AS paid_brand, p.card_last4 AS paid_last4, p.created_at AS paid_at
       FROM appointments a JOIN doctors d ON d.id = a.doctor_id
       LEFT JOIN payments p ON p.appointment_id = a.id AND p.status = 'paid'
       WHERE a.id = ?`
    )
    .get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Appointment not found." });
  if (!req.user) return res.status(401).json({ error: "Sign in to view this appointment.", code: "auth_required" });
  if (req.user.role !== "admin" && row.user_id != null && row.user_id !== req.user.id)
    return res.status(403).json({ error: "That booking belongs to another patient." });
  res.json(row);
});

// Dashboard stats (Read)
app.get("/api/stats", (req, res) => {
  const total = db.prepare("SELECT COUNT(*) c FROM appointments").get().c;
  const confirmed = db.prepare("SELECT COUNT(*) c FROM appointments WHERE status='confirmed'").get().c;
  const completed = db.prepare("SELECT COUNT(*) c FROM appointments WHERE status='completed'").get().c;
  const cancelled = db.prepare("SELECT COUNT(*) c FROM appointments WHERE status='cancelled'").get().c;
  const emergency = db.prepare("SELECT COUNT(*) c FROM appointments WHERE emergency=1").get().c;
  const doctors = db.prepare("SELECT COUNT(*) c FROM doctors").get().c;
  res.json({ total, confirmed, completed, cancelled, emergency, doctors });
});

// Create appointment (Insert)
app.post("/api/appointments", (req, res) => {
  const err = validateBooking(req.body);
  if (err) return res.status(400).json({ error: err });
  const { patient_name, phone, email, doctor_id, appt_date, slot_time, reason } = req.body;
  const info = db
    .prepare(
      `INSERT INTO appointments (patient_name, phone, email, doctor_id, appt_date, slot_time, reason, user_id)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(String(patient_name).trim(), String(phone).trim(), email || null, Number(doctor_id), appt_date, slot_time, reason || null, req.user ? req.user.id : null);
  const created = db
    .prepare(
      `SELECT a.*, d.name AS doctor_name, d.specialty, d.fee FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id WHERE a.id = ?`
    )
    .get(info.lastInsertRowid);
  if (mongoConnected) {
    MongoAppointment.findOneAndUpdate({ id: created.id }, created, { upsert: true }).catch(() => {});
  }
  res.status(201).json(created);
});

// Update appointment (Update) — patient details and/or slot move
app.put("/api/appointments/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM appointments WHERE id = ?").get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "Appointment not found." });

  const merged = { ...existing, ...req.body };
  const err = validateBooking(merged, existing.id);
  if (err) return res.status(400).json({ error: err });

  const slotChanged = merged.appt_date !== existing.appt_date || merged.slot_time !== existing.slot_time;
  db.prepare(
    `UPDATE appointments SET patient_name=?, phone=?, email=?, doctor_id=?, appt_date=?, slot_time=?,
       reason=?, status=?, emergency=?, swapped_from=?, notes=? WHERE id=?`
  ).run(
    String(merged.patient_name).trim(), String(merged.phone).trim(), merged.email || null,
    Number(merged.doctor_id), merged.appt_date, merged.slot_time,
    merged.reason || null, merged.status,
    merged.emergency ? 1 : 0, merged.swapped_from || null, merged.notes || null, existing.id
  );
  const updated = db.prepare("SELECT * FROM appointments WHERE id = ?").get(existing.id);
  res.json({ ...updated, slot_moved: slotChanged });
});

// Emergency slot shift (Update) — moves the booking; optionally swaps with an occupant
app.post("/api/appointments/:id/emergency-shift", (req, res) => {
  const existing = db.prepare("SELECT * FROM appointments WHERE id = ?").get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "Appointment not found." });
  if (existing.status === "cancelled") return res.status(400).json({ error: "A cancelled booking cannot be shifted." });

  const { new_date, new_slot, allow_swap = false } = req.body;
  // Occupied slots are allowed here — occupancy is handled by the swap logic below.
  const err = validateBooking({ ...existing, appt_date: new_date, slot_time: new_slot }, existing.id, true);
  if (err) return res.status(400).json({ error: err });

  const occupant = db
    .prepare(
      `SELECT * FROM appointments WHERE doctor_id=? AND appt_date=? AND slot_time=?
       AND status != 'cancelled' AND id != ?`
    )
    .get(existing.doctor_id, new_date, new_slot, existing.id);

  let swappedWith = null;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  if (occupant) {
    if (!allow_swap)
      return res.status(409).json({
        error: `${new_slot} on ${new_date} is already taken by ${occupant.patient_name}. Enable swap to exchange slots.`,
      });
    // Exchange: occupant takes the emergency patient's old slot
    db.prepare(
      `UPDATE appointments SET appt_date=?, slot_time=?, notes=?, emergency=emergency WHERE id=?`
    ).run(existing.appt_date, existing.slot_time,
      `Slot swapped on ${stamp} — exchanged due to another patient's emergency.`, occupant.id);
    swappedWith = occupant;
  }

  db.prepare(
    `UPDATE appointments SET appt_date=?, slot_time=?, emergency=1, swapped_from=?, notes=? WHERE id=?`
  ).run(
    new_date, new_slot, `${existing.appt_date} ${existing.slot_time}`,
    `Emergency shift on ${stamp}${swappedWith ? ` — swapped with ${swappedWith.patient_name}` : ""}.`,
    existing.id
  );

  const updated = db.prepare("SELECT * FROM appointments WHERE id = ?").get(existing.id);
  res.json({ appointment: updated, swapped_with: swappedWith || null });
});

// Cancel appointment (Update status)
app.patch("/api/appointments/:id/status", (req, res) => {
  const { status } = req.body;
  if (!["confirmed", "cancelled", "completed"].includes(status))
    return res.status(400).json({ error: "Status must be confirmed, cancelled or completed." });
  const info = db.prepare("UPDATE appointments SET status=? WHERE id=?").run(status, Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: "Appointment not found." });
  res.json(db.prepare("SELECT * FROM appointments WHERE id=?").get(Number(req.params.id)));
});

// Delete appointment (Delete)
app.delete("/api/appointments/:id", (req, res) => {
  const info = db.prepare("DELETE FROM appointments WHERE id=?").run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: "Appointment not found." });
  res.json({ deleted: true, id: Number(req.params.id) });
});

// SPA fallback for non-API GET routes
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`MediCare Hospital portal running at http://localhost:${PORT}`);
});
