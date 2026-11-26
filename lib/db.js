/**
 * MediCare Hospital — Unified Database Layer
 * Primary: MongoDB Atlas / Mongoose (persistent across local & Vercel serverless)
 * Fallback: SQLite (node:sqlite) only when MongoDB is unavailable
 */
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { phoneDigitsMatch, normalizePhoneNumber } = require("./otp");

const SLOT_TIMES = [
  "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
  "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function isoDateOffsetIST(offsetDays = 0) {
  const d = nowIST();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function todayIST() {
  return isoDateOffsetIST(0);
}

function formatStampIST() {
  return nowIST().toISOString().slice(0, 16).replace("T", " ") + " IST";
}

function weekdayOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return Number.isNaN(d.getTime()) ? null : DAY_NAMES[d.getUTCDay()];
}

function doctorWorksOn(doctor, dateStr) {
  const days = Array.isArray(doctor.days) ? doctor.days : JSON.parse(doctor.days || "[]");
  return days.includes(weekdayOf(dateStr));
}

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
  } catch {
    return false;
  }
}

/* ----------------------------- Seed Definitions ----------------------------- */
const SEED_DOCTORS = [
  { id: 1, name: "Dr. Aisha Sharma", specialty: "Cardiology", department: "Heart & Vascular", fee: 800, rating: 4.9, experience: 14, bio: "Interventional cardiologist specialising in preventive cardiology.", days: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
  { id: 2, name: "Dr. Rohan Mehta", specialty: "Dermatology", department: "Skin Care", fee: 550, rating: 4.7, experience: 9, bio: "Clinical dermatologist focused on acne, eczema and skin oncology.", days: ["Mon", "Wed", "Fri", "Sat"] },
  { id: 3, name: "Dr. Elena Rodriguez", specialty: "Pediatrics", department: "Child Health", fee: 600, rating: 4.8, experience: 11, bio: "Pediatrician with a gentle touch — newborns to adolescents.", days: ["Mon", "Tue", "Thu", "Fri", "Sat"] },
  { id: 4, name: "Dr. James Okafor", specialty: "Orthopedics", department: "Bone & Joint", fee: 750, rating: 4.6, experience: 16, bio: "Orthopedic surgeon for sports injuries and joint replacements.", days: ["Tue", "Wed", "Thu", "Fri", "Sat"] },
  { id: 5, name: "Dr. Priya Nair", specialty: "Neurology", department: "Brain & Spine", fee: 900, rating: 4.9, experience: 18, bio: "Neurologist treating migraine, epilepsy and movement disorders.", days: ["Mon", "Tue", "Thu", "Sat"] },
  { id: 6, name: "Dr. Kenji Tanaka", specialty: "General Medicine", department: "Family Care", fee: 400, rating: 4.5, experience: 7, bio: "First point of contact for check-ups, fever and routine care.", days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
  { id: 7, name: "Dr. Fatima Al-Hassan", specialty: "Gynecology", department: "Women's Health", fee: 700, rating: 4.8, experience: 13, bio: "Obstetrics and gynecology, high-risk pregnancies included.", days: ["Mon", "Wed", "Fri"] },
  { id: 8, name: "Dr. Lucas Bennett", specialty: "ENT", department: "Ear, Nose & Throat", fee: 500, rating: 4.6, experience: 10, bio: "ENT specialist for sinus, hearing and throat disorders.", days: ["Tue", "Thu", "Fri", "Sat"] },
];

function getSeedAppointments() {
  return [
    { id: 1, patient_name: "Aarav Patel", phone: "+919812345678", email: "aarav@example.com", doctor_id: 1, doctor_name: "Dr. Aisha Sharma", appt_date: isoDateOffsetIST(0), slot_time: "10:00", reason: "Annual heart check-up", status: "confirmed", emergency: 0, payment_status: "unpaid", user_id: null, notes: null },
    { id: 2, patient_name: "Meera Iyer", phone: "+919988766554", email: "meera@example.com", doctor_id: 3, doctor_name: "Dr. Elena Rodriguez", appt_date: isoDateOffsetIST(0), slot_time: "11:00", reason: "Child vaccination", status: "confirmed", emergency: 0, payment_status: "unpaid", user_id: null, notes: null },
    { id: 3, patient_name: "Daniel Kim", phone: "+919777712345", email: "daniel@example.com", doctor_id: 2, doctor_name: "Dr. Rohan Mehta", appt_date: isoDateOffsetIST(1), slot_time: "09:30", reason: "Persistent acne treatment", status: "confirmed", emergency: 0, payment_status: "unpaid", user_id: null, notes: null },
    { id: 4, patient_name: "Sofia Lopez", phone: "+919666643210", email: "sofia@example.com", doctor_id: 6, doctor_name: "Dr. Kenji Tanaka", appt_date: isoDateOffsetIST(1), slot_time: "15:00", reason: "Routine antenatal visit", status: "confirmed", emergency: 0, payment_status: "unpaid", user_id: null, notes: null },
    { id: 5, patient_name: "Arjun Singh", phone: "+919555587654", email: "arjun@example.com", doctor_id: 4, doctor_name: "Dr. James Okafor", appt_date: isoDateOffsetIST(2), slot_time: "16:00", reason: "Knee pain after running", status: "confirmed", emergency: 0, payment_status: "unpaid", user_id: null, notes: null },
  ];
}

const ALEX_SEED = [
  ["hi", "greet"], ["hello", "greet"], ["hey there", "greet"], ["good morning", "greet"],
  ["thanks", "thanks"], ["thank you so much", "thanks"], ["bye", "bye"], ["goodbye", "bye"],
  ["what can you do", "help"], ["help me", "help"], ["how does this work", "help"], ["options", "help"],
  ["book an appointment", "book"], ["i want to book a doctor", "book"], ["make an appointment", "book"],
  ["book a slot", "book"], ["i need a consultation", "book"],
  ["book me a cardiologist tomorrow", "book_prefill"],
  ["show me available slots", "book"], ["i want tomorrow 10 am", "book_prefill"],
  ["emergency booking", "emergency"], ["urgent appointment", "emergency"],
  ["need doctor immediately", "emergency"], ["i have an emergency", "emergency"], ["book emergency slot", "emergency"],
  ["my bookings", "my_bookings"], ["show my appointment", "my_bookings"], ["show my booking", "my_bookings"],
  ["check my appointment status", "my_bookings"], ["where is my booking", "my_bookings"], ["lookup my appointment", "my_bookings"],
  ["how do i reschedule", "shift_help"], ["i need to change my slot", "shift_help"], ["shift my appointment", "shift_help"],
  ["how to shift appointment", "shift_help"], ["can i move my appointment", "shift_help"], ["reschedule my visit", "shift_help"],
  ["how do i cancel", "cancel_help"], ["cancel my appointment", "cancel_help"], ["i want to cancel appointment", "cancel_help"],
  ["which doctors do you have", "doctors_list"], ["list of doctors", "doctors_list"], ["show specialists", "doctors_list"],
  ["who is the best cardiologist", "doctors_list"],
  ["what is the consultation fee", "fees"], ["how much does it cost", "fees"], ["what are the fees", "fees"],
  ["cardiology fee", "fees"], ["price of appointment", "fees"],
  ["cheapest doctor", "cheapest"], ["which doctor is cheapest", "cheapest"],
  ["what are the timings", "timings"], ["when are you open", "timings"], ["clinic hours", "timings"],
  ["what are the office hours", "timings"], ["how late are you open", "timings"], ["do you open on sunday", "timings"],
  ["where is the hospital", "location"], ["address please", "location"], ["where is it located", "location"],
  ["how do i reach you", "location"], ["nearest metro", "location"],
  ["cancellation policy", "policy_cancel"], ["can i cancel for free", "policy_cancel"],
  ["is there a cancellation charge", "policy_cancel"], ["refund if i cancel", "policy_refund"], ["money back policy", "policy_refund"],
  ["do you accept insurance", "insurance"], ["cashless claim available", "insurance"], ["do you accept insurance card", "insurance"],
  ["when do i get my reports", "reports"], ["when will lab report come", "reports"], ["test results", "reports"],
  ["do you give prescriptions", "prescription"], ["can i get a prescription online", "prescription"],
  ["how do i pay", "payment_help"], ["payment options", "payment_help"], ["can i pay with card", "payment_help"],
  ["can i pay online", "payment_help"], ["payment failed what to do", "payment_help"], ["upi accepted", "payment_help"],
  ["earliest available slot", "earliest"], ["first free slot today", "earliest"],
  ["what is the emergency number", "helpline"], ["ambulance number", "helpline"], ["emergency contact", "helpline"],
];

/* ------------------------------ Mongo Schemas ------------------------------- */
mongoose.set("bufferCommands", false);

const userSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, index: true },
  password_hash: { type: String, required: true },
  salt: { type: String, required: true },
  role: { type: String, default: "patient", enum: ["patient", "admin"] },
  email_verified: { type: Boolean, default: false },
  phone_verified: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
});

const doctorSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  name: { type: String, required: true },
  specialty: { type: String, required: true, index: true },
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
  phone: { type: String, required: true, index: true },
  email: String,
  doctor_id: { type: Number, index: true },
  doctor_name: String,
  appt_date: { type: String, index: true },
  slot_time: String,
  reason: String,
  status: { type: String, default: "confirmed", index: true },
  emergency: { type: Number, default: 0 },
  swapped_from: String,
  payment_status: { type: String, default: "unpaid" },
  user_id: { type: Number, index: true },
  notes: String,
  created_at: { type: Date, default: Date.now },
});
appointmentSchema.index({ doctor_id: 1, appt_date: 1, slot_time: 1 });

const paymentSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  appointment_id: { type: Number, index: true },
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
  user_id: { type: Number, index: true },
  expires_at: { type: Date, index: { expires: 0 } },
  created_at: { type: Date, default: Date.now },
});

const otpSchema = new mongoose.Schema({
  key: { type: String, index: true },
  purpose: { type: String, required: true },
  channel: { type: String, required: true },
  target: { type: String, required: true, index: true },
  code_hash: { type: String, required: true },
  salt: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  max_attempts: { type: Number, default: 5 },
  verified: { type: Boolean, default: false },
  expires_at: { type: Date, index: { expires: 0 } },
  created_at: { type: Date, default: Date.now },
});

const alexSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  text: { type: String, unique: true },
  intent: { type: String, required: true },
  hits: { type: Number, default: 0 },
});

const counterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
});

// Isolated collections for users, payments, sessions, otps, alex, counters prevent collision
// with existing collections (e.g. hostelhub.users / hostelhub.payments) while keeping
// doctors, appointments, and booking synced cleanly.
const MongoUser = mongoose.models.MedicareUser || mongoose.model("MedicareUser", userSchema, "medicare_users");
const MongoDoctor = mongoose.models.Doctor || mongoose.model("Doctor", doctorSchema, "doctors");
const MongoAppointment = mongoose.models.Appointment || mongoose.model("Appointment", appointmentSchema, "appointments");
const MongoBooking = mongoose.models.Booking || mongoose.model("Booking", appointmentSchema, "booking");
const MongoPayment = mongoose.models.MedicarePayment || mongoose.model("MedicarePayment", paymentSchema, "medicare_payments");
const MongoSession = mongoose.models.MedicareSession || mongoose.model("MedicareSession", sessionSchema, "medicare_sessions");
const MongoOtp = mongoose.models.MedicareOtp || mongoose.model("MedicareOtp", otpSchema, "medicare_otps");
const MongoAlex = mongoose.models.MedicareAlex || mongoose.model("MedicareAlex", alexSchema, "medicare_alex_examples");
const MongoCounter = mongoose.models.MedicareCounter || mongoose.model("MedicareCounter", counterSchema, "medicare_counters");

/* ------------------------------ State & Cache ------------------------------- */
let mongoReady = false;
let mongoError = null;
let mongoConnectTimeMs = null;
let initPromise = null;
let sqliteDb = null;

// Short 30s in-memory cache for doctors list (cleared on write)
let doctorsCache = null;
let doctorsCacheTime = 0;
const DOCTORS_CACHE_TTL_MS = 30 * 1000;

function invalidateDoctorsCache() {
  doctorsCache = null;
  doctorsCacheTime = 0;
}

function getMongoUri() {
  return (process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/patient_booking").trim();
}

function isMongoReady() {
  return mongoReady && mongoose.connection.readyState === 1;
}

function getDbStatus() {
  const uri = getMongoUri();
  return {
    primary: isMongoReady() ? "mongodb" : "sqlite",
    sqlite: { status: sqliteDb ? "active" : "standby", file: "hospital.db" },
    mongodb: {
      status: isMongoReady() ? "connected" : "disconnected",
      database: isMongoReady() ? mongoose.connection.name : null,
      uri: uri.replace(/:\/\/[^@]+@/, "://***@"),
      connectMs: mongoConnectTimeMs,
      error: isMongoReady() ? null : mongoError,
    },
  };
}

/* ----------------------------- SQLite Fallback ------------------------------ */
function getSqlite() {
  if (sqliteDb) return sqliteDb;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (err) {
    throw new Error(`MongoDB is unavailable and SQLite fallback failed (${err.message}). Configure MONGODB_URI.`);
  }
  let dbPath = process.env.DB_PATH;
  if (!dbPath) {
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      dbPath = path.join("/tmp", "hospital.db");
    } else {
      dbPath = path.join(__dirname, "..", "hospital.db");
    }
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      specialty TEXT NOT NULL,
      department TEXT NOT NULL,
      fee INTEGER NOT NULL,
      rating REAL NOT NULL DEFAULT 4.8,
      experience INTEGER NOT NULL DEFAULT 5,
      bio TEXT,
      days TEXT NOT NULL DEFAULT '["Mon","Tue","Wed","Thu","Fri","Sat"]'
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      appt_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled','completed')),
      emergency INTEGER NOT NULL DEFAULT 0,
      swapped_from TEXT,
      notes TEXT,
      user_id INTEGER,
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_appt_doctor_date ON appointments(doctor_id, appt_date, slot_time);
    CREATE INDEX IF NOT EXISTS idx_appt_phone ON appointments(phone);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'patient' CHECK (role IN ('patient','admin')),
      email_verified INTEGER NOT NULL DEFAULT 0,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      amount INTEGER NOT NULL,
      method TEXT NOT NULL DEFAULT 'card',
      card_brand TEXT,
      card_last4 TEXT,
      txn_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','refunded')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      purpose TEXT NOT NULL,
      channel TEXT NOT NULL,
      target TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      verified INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS alex_examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL UNIQUE,
      intent TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0
    );
  `);

  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes("email_verified")) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  if (!userCols.includes("phone_verified")) db.exec("ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0");

  // Seed SQLite only when empty
  if (db.prepare("SELECT COUNT(*) c FROM doctors").get().c === 0) {
    const ins = db.prepare("INSERT INTO doctors (id, name, specialty, department, fee, rating, experience, bio, days) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const d of SEED_DOCTORS) {
      ins.run(d.id, d.name, d.specialty, d.department, d.fee, d.rating, d.experience, d.bio, JSON.stringify(d.days));
    }
  }
  if (db.prepare("SELECT COUNT(*) c FROM appointments").get().c === 0) {
    const ins = db.prepare("INSERT INTO appointments (patient_name, phone, email, doctor_id, appt_date, slot_time, reason) VALUES (?,?,?,?,?,?,?)");
    for (const a of getSeedAppointments()) {
      ins.run(a.patient_name, a.phone, a.email, a.doctor_id, a.appt_date, a.slot_time, a.reason);
    }
  }
  if (!db.prepare("SELECT id FROM users WHERE email = ?").get("ayushgupta7440@gmail.com")) {
    const { salt, hash } = hashPassword("admin123");
    db.prepare("INSERT INTO users (name, email, phone, password_hash, salt, role, email_verified, phone_verified) VALUES (?,?,?,?,?,?,1,1)")
      .run("Ayush Gupta", "ayushgupta7440@gmail.com", "+917489154070", hash, salt, "admin");
  }
  db.prepare("DELETE FROM users WHERE email IN ('admin@medicare.local', 'demo@medicare.local')").run();
  if (db.prepare("SELECT COUNT(*) c FROM alex_examples").get().c === 0) {
    const ins = db.prepare("INSERT OR IGNORE INTO alex_examples (text, intent, hits) VALUES (?,?,0)");
    for (const [text, intent] of ALEX_SEED) ins.run(text, intent);
  }
  sqliteDb = db;
  return sqliteDb;
}

/* ----------------------------- Mongo Lifecycle ------------------------------ */
async function nextSeq(name, floor = 0) {
  if (floor > 0) {
    await MongoCounter.updateOne({ _id: name }, { $max: { seq: floor } }, { upsert: true });
  }
  const updated = await MongoCounter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return updated.seq;
}

async function initCounterFloor(name, Model) {
  const existing = await MongoCounter.findById(name).lean();
  if (existing) return;
  const maxDoc = await Model.findOne({}).sort({ id: -1 }).select("id").lean();
  const maxId = maxDoc && typeof maxDoc.id === "number" ? maxDoc.id : 0;
  await MongoCounter.updateOne({ _id: name }, { $setOnInsert: { seq: maxId } }, { upsert: true });
}

async function seedMongoIfNeeded() {
  const [docCount, apptCount, userCount, alexCount] = await Promise.all([
    MongoDoctor.estimatedDocumentCount(),
    MongoAppointment.estimatedDocumentCount(),
    MongoUser.estimatedDocumentCount(),
    MongoAlex.estimatedDocumentCount(),
  ]);

  const tasks = [];
  if (docCount === 0) {
    tasks.push(MongoDoctor.insertMany(SEED_DOCTORS, { ordered: false }).catch(() => {}));
  }
  if (apptCount === 0) {
    const seeds = getSeedAppointments();
    tasks.push(MongoAppointment.insertMany(seeds, { ordered: false }).catch(() => {}));
    tasks.push(MongoBooking.insertMany(seeds, { ordered: false }).catch(() => {}));
  }
  if (alexCount === 0) {
    const docs = ALEX_SEED.map(([text, intent], idx) => ({ id: idx + 1, text, intent, hits: 0 }));
    tasks.push(MongoAlex.insertMany(docs, { ordered: false }).catch(() => {}));
  }
  if (tasks.length) await Promise.all(tasks);

  // Seed admin user ONLY if missing in medicare_users
  const ayushEmail = "ayushgupta7440@gmail.com";
  const adminDoc = await MongoUser.findOne({ email: ayushEmail }).lean();
  if (!adminDoc) {
    // Check if an existing password hash was saved in legacy users collection
    let pwHash;
    let pwSalt;
    try {
      const legacy = await mongoose.connection.db.collection("users").findOne({ email: ayushEmail });
      if (legacy && legacy.password_hash && legacy.salt) {
        pwHash = legacy.password_hash;
        pwSalt = legacy.salt;
      }
    } catch {}
    if (!pwHash || !pwSalt) {
      const generated = hashPassword(process.env.ADMIN_DEFAULT_PASSWORD || "admin123");
      pwHash = generated.hash;
      pwSalt = generated.salt;
    }
    const adminId = await nextSeq("users", userCount);
    await MongoUser.updateOne(
      { email: ayushEmail },
      {
        $setOnInsert: {
          id: adminId,
          name: "Ayush Gupta",
          email: ayushEmail,
          phone: "+917489154070",
          password_hash: pwHash,
          salt: pwSalt,
          role: "admin",
          email_verified: true,
          phone_verified: true,
          created_at: new Date(),
        },
      },
      { upsert: true }
    );
    console.log(`[Auth] Admin verified in MongoDB: ${ayushEmail}`);
  }

  // Ensure atomic counters start above any existing IDs
  await Promise.all([
    initCounterFloor("doctors", MongoDoctor),
    initCounterFloor("appointments", MongoAppointment),
    initCounterFloor("users", MongoUser),
    initCounterFloor("payments", MongoPayment),
    initCounterFloor("alex", MongoAlex),
  ]);
}

async function connectMongoOnce() {
  const uri = getMongoUri();
  const opts = {
    serverSelectionTimeoutMS: 6000,
    socketTimeoutMS: 20000,
    maxPoolSize: 10,
    minPoolSize: 1,
    family: 4,
  };
  const t0 = Date.now();
  try {
    await mongoose.connect(uri, opts);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (uri.startsWith("mongodb+srv://") && /querySrv|EREFUSED|ENOTFOUND|ETIMEOUT|ESERVFAIL/i.test(msg)) {
      // Fallback to public DNS resolvers for environments where local DNS refuses SRV records
      try {
        dns.setDefaultResultOrder?.("ipv4first");
        dns.setServers(["8.8.8.8", "1.1.1.1"]);
      } catch {}
      await mongoose.connect(uri, opts);
    } else {
      throw err;
    }
  }
  mongoConnectTimeMs = Date.now() - t0;
  mongoReady = true;
  mongoError = null;
  console.log(`[MongoDB] Connected (${mongoose.connection.name}) in ${mongoConnectTimeMs}ms`);
  await seedMongoIfNeeded();
}

async function ensureReady() {
  if (isMongoReady()) return true;
  if (!initPromise) {
    initPromise = connectMongoOnce().catch((err) => {
      mongoReady = false;
      mongoError = err.message || "MongoDB connection failed";
      initPromise = null;
      console.warn(`[MongoDB] Unavailable (${mongoError}). Falling back to SQLite.`);
      getSqlite();
      return false;
    });
  }
  await initPromise;
  return isMongoReady();
}

/* ----------------------------- Repository API ------------------------------- */
function cleanUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone || null,
    role: u.email === "ayushgupta7440@gmail.com" ? "admin" : u.role || "patient",
    email_verified: Boolean(u.email_verified),
    phone_verified: Boolean(u.phone_verified),
  };
}

async function findUserByEmail(email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean) return null;
  if (isMongoReady()) return MongoUser.findOne({ email: clean }).lean();
  return getSqlite().prepare("SELECT * FROM users WHERE lower(email) = ?").get(clean) || null;
}

async function findUserByPhone(rawPhone) {
  const norm = normalizePhoneNumber(rawPhone);
  if (!norm.ok) return null;
  if (isMongoReady()) {
    const exact = await MongoUser.findOne({ phone: norm.phone }).lean();
    if (exact) return exact;
    const tailRegex = new RegExp(`${norm.digits10}$`);
    return MongoUser.findOne({ phone: tailRegex }).lean();
  }
  const rows = getSqlite().prepare("SELECT * FROM users WHERE phone IS NOT NULL").all();
  return rows.find((u) => phoneDigitsMatch(u.phone, norm.phone)) || null;
}

async function findUserByIdentifier(identifier) {
  const val = String(identifier || "").trim();
  if (!val) return null;
  if (val.includes("@")) return findUserByEmail(val);
  return findUserByPhone(val);
}

async function findUserById(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return null;
  if (isMongoReady()) return MongoUser.findOne({ id: numId }).lean();
  return getSqlite().prepare("SELECT * FROM users WHERE id = ?").get(numId) || null;
}

async function createUser({ name, email, phone, password, role = "patient", email_verified = false, phone_verified = false }) {
  const cleanEmail = String(email).trim().toLowerCase();
  const { salt, hash } = hashPassword(password);
  if (isMongoReady()) {
    const id = await nextSeq("users");
    const doc = await MongoUser.create({
      id,
      name: String(name).trim(),
      email: cleanEmail,
      phone: phone || null,
      password_hash: hash,
      salt,
      role,
      email_verified: Boolean(email_verified),
      phone_verified: Boolean(phone_verified),
      created_at: new Date(),
    });
    return cleanUser(doc.toObject());
  }
  const info = getSqlite()
    .prepare("INSERT INTO users (name, email, phone, password_hash, salt, role, email_verified, phone_verified) VALUES (?,?,?,?,?,?,?,?)")
    .run(String(name).trim(), cleanEmail, phone || null, hash, salt, role, email_verified ? 1 : 0, phone_verified ? 1 : 0);
  return cleanUser(getSqlite().prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid));
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttlMs = 7 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);
  if (isMongoReady()) {
    await MongoSession.create({ token, user_id: Number(userId), expires_at: expiresAt, created_at: new Date() });
    return { token, ttlMs };
  }
  getSqlite()
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)")
    .run(token, Number(userId), expiresAt.toISOString());
  return { token, ttlMs };
}

async function getSessionUser(token) {
  if (!token) return null;
  if (isMongoReady()) {
    const s = await MongoSession.findOne({ token }).lean();
    if (!s) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) {
      await MongoSession.deleteOne({ token }).catch(() => {});
      return null;
    }
    const u = await MongoUser.findOne({ id: s.user_id }).lean();
    if (!u) return null;
    return { ...cleanUser(u), token };
  }
  const row = getSqlite()
    .prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.email_verified, u.phone_verified, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    getSqlite().prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return { ...cleanUser(row), token };
}

async function deleteSession(token) {
  if (!token) return;
  if (isMongoReady()) {
    await MongoSession.deleteOne({ token }).catch(() => {});
    return;
  }
  getSqlite().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

async function updateUserPassword(userId, newPassword) {
  const numId = Number(userId);
  const { salt, hash } = hashPassword(newPassword);
  if (isMongoReady()) {
    await MongoUser.updateOne({ id: numId }, { $set: { password_hash: hash, salt } });
    return;
  }
  getSqlite().prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").run(hash, salt, numId);
}

async function deleteUserSessions(userId) {
  const numId = Number(userId);
  if (isMongoReady()) {
    await MongoSession.deleteMany({ user_id: numId }).catch(() => {});
    return;
  }
  getSqlite().prepare("DELETE FROM sessions WHERE user_id = ?").run(numId);
}

/* ------------------------------- OTP Storage -------------------------------- */
async function getLatestOtp(purpose, channel, target) {
  const key = `${purpose}:${channel}:${target}`;
  if (isMongoReady()) {
    return MongoOtp.findOne({ key }).sort({ created_at: -1 }).lean();
  }
  return getSqlite().prepare("SELECT * FROM otps WHERE key = ? ORDER BY id DESC LIMIT 1").get(key) || null;
}

async function storeOtpRecord({ purpose, channel, target, codeHash, salt, ttlMs = 5 * 60 * 1000 }) {
  const key = `${purpose}:${channel}:${target}`;
  const expiresAt = new Date(Date.now() + ttlMs);
  if (isMongoReady()) {
    await MongoOtp.deleteMany({ key, verified: false }).catch(() => {});
    return MongoOtp.create({
      key,
      purpose,
      channel,
      target,
      code_hash: codeHash,
      salt,
      attempts: 0,
      max_attempts: 5,
      verified: false,
      expires_at: expiresAt,
      created_at: new Date(),
    });
  }
  const db = getSqlite();
  db.prepare("DELETE FROM otps WHERE key = ? AND verified = 0").run(key);
  db.prepare("INSERT INTO otps (key, purpose, channel, target, code_hash, salt, expires_at) VALUES (?,?,?,?,?,?,?)")
    .run(key, purpose, channel, target, codeHash, salt, expiresAt.toISOString());
}

async function incrementOtpAttempts(otpDoc) {
  if (!otpDoc) return;
  if (isMongoReady()) {
    await MongoOtp.updateOne({ _id: otpDoc._id }, { $inc: { attempts: 1 } });
    return;
  }
  getSqlite().prepare("UPDATE otps SET attempts = attempts + 1 WHERE id = ?").run(otpDoc.id);
}

async function markOtpVerified(otpDoc) {
  if (!otpDoc) return;
  if (isMongoReady()) {
    await MongoOtp.updateOne({ _id: otpDoc._id }, { $set: { verified: true } });
    return;
  }
  getSqlite().prepare("UPDATE otps SET verified = 1 WHERE id = ?").run(otpDoc.id);
}

/* -------------------------------- Doctors ----------------------------------- */
function normalizeDoctorDoc(d) {
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    specialty: d.specialty,
    department: d.department,
    fee: d.fee,
    rating: d.rating,
    experience: d.experience,
    bio: d.bio || null,
    days: Array.isArray(d.days) ? d.days : JSON.parse(d.days || "[]"),
  };
}

async function listDoctors(specialty = null) {
  const now = Date.now();
  if (!doctorsCache || now - doctorsCacheTime > DOCTORS_CACHE_TTL_MS) {
    let rows;
    if (isMongoReady()) {
      rows = await MongoDoctor.find({}).sort({ name: 1 }).lean();
    } else {
      rows = getSqlite().prepare("SELECT * FROM doctors ORDER BY name").all();
    }
    doctorsCache = rows.map(normalizeDoctorDoc);
    doctorsCacheTime = now;
  }
  if (specialty) {
    return doctorsCache.filter((d) => d.specialty === specialty);
  }
  return doctorsCache;
}

async function getDoctor(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return null;
  const list = await listDoctors();
  return list.find((d) => d.id === numId) || null;
}

async function createDoctor({ name, specialty, department, fee, rating, experience, bio, days }) {
  invalidateDoctorsCache();
  if (isMongoReady()) {
    const id = await nextSeq("doctors");
    const created = await MongoDoctor.create({
      id,
      name: String(name).trim(),
      specialty: String(specialty).trim(),
      department: (department || specialty || "General").trim(),
      fee: Number(fee),
      rating: Number(rating) || 4.5,
      experience: Number(experience) || 1,
      bio: bio || null,
      days,
    });
    return normalizeDoctorDoc(created.toObject());
  }
  const info = getSqlite()
    .prepare("INSERT INTO doctors (name, specialty, department, fee, rating, experience, bio, days) VALUES (?,?,?,?,?,?,?,?)")
    .run(
      String(name).trim(), String(specialty).trim(), (department || specialty || "General").trim(),
      Number(fee), Number(rating) || 4.5, Number(experience) || 1, bio || null, JSON.stringify(days)
    );
  return normalizeDoctorDoc(getSqlite().prepare("SELECT * FROM doctors WHERE id = ?").get(info.lastInsertRowid));
}

async function updateDoctor(id, fields) {
  invalidateDoctorsCache();
  const numId = Number(id);
  if (isMongoReady()) {
    const updated = await MongoDoctor.findOneAndUpdate({ id: numId }, { $set: fields }, { returnDocument: "after" }).lean();
    return normalizeDoctorDoc(updated);
  }
  getSqlite()
    .prepare("UPDATE doctors SET name=?, specialty=?, department=?, fee=?, rating=?, experience=?, bio=?, days=? WHERE id=?")
    .run(
      fields.name, fields.specialty, fields.department, fields.fee,
      fields.rating, fields.experience, fields.bio || null, JSON.stringify(fields.days), numId
    );
  return normalizeDoctorDoc(getSqlite().prepare("SELECT * FROM doctors WHERE id = ?").get(numId));
}

async function deleteDoctor(id) {
  invalidateDoctorsCache();
  const numId = Number(id);
  if (isMongoReady()) {
    await MongoDoctor.deleteOne({ id: numId });
    return;
  }
  getSqlite().prepare("DELETE FROM doctors WHERE id = ?").run(numId);
}

async function countDoctorAppointments(doctorId) {
  const numId = Number(doctorId);
  if (isMongoReady()) return MongoAppointment.countDocuments({ doctor_id: numId });
  return getSqlite().prepare("SELECT COUNT(*) c FROM appointments WHERE doctor_id = ?").get(numId).c;
}

/* ------------------------------ Appointments -------------------------------- */
async function syncApptPayloadToCollections(doc) {
  if (!isMongoReady() || !doc) return;
  const payload = { ...doc };
  delete payload._id;
  delete payload.__v;
  await Promise.all([
    MongoAppointment.findOneAndUpdate({ id: doc.id }, payload, { upsert: true }),
    MongoBooking.findOneAndUpdate({ id: doc.id }, payload, { upsert: true }),
  ]);
}

async function bookedMap(doctorId, date) {
  const numDocId = Number(doctorId);
  let rows;
  if (isMongoReady()) {
    rows = await MongoAppointment.find({
      doctor_id: numDocId,
      appt_date: date,
      status: { $ne: "cancelled" },
    })
      .select("slot_time patient_name")
      .lean();
  } else {
    rows = getSqlite()
      .prepare("SELECT slot_time, patient_name FROM appointments WHERE doctor_id = ? AND appt_date = ? AND status != 'cancelled'")
      .all(numDocId, date);
  }
  const map = new Map();
  for (const r of rows) map.set(r.slot_time, r.patient_name);
  return map;
}

async function slotIsFree(doctorId, date, time, ignoreApptId = null) {
  const numDocId = Number(doctorId);
  if (isMongoReady()) {
    const query = {
      doctor_id: numDocId,
      appt_date: date,
      slot_time: time,
      status: { $ne: "cancelled" },
    };
    if (ignoreApptId != null) query.id = { $ne: Number(ignoreApptId) };
    const hit = await MongoAppointment.findOne(query).select("id").lean();
    return !hit;
  }
  const row = getSqlite()
    .prepare(
      `SELECT id FROM appointments
       WHERE doctor_id = ? AND appt_date = ? AND slot_time = ?
         AND status != 'cancelled' AND (? IS NULL OR id != ?)`
    )
    .get(numDocId, date, time, ignoreApptId, ignoreApptId);
  return !row;
}

async function findAppointmentRaw(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return null;
  if (isMongoReady()) return MongoAppointment.findOne({ id: numId }).lean();
  return getSqlite().prepare("SELECT * FROM appointments WHERE id = ?").get(numId) || null;
}

async function enrichAppointments(appts) {
  if (!appts.length) return [];
  const doctors = await listDoctors();
  const docMap = new Map(doctors.map((d) => [d.id, d]));

  let payMap = new Map();
  if (isMongoReady()) {
    const ids = appts.map((a) => a.id);
    const pays = await MongoPayment.find({ appointment_id: { $in: ids }, status: "paid" }).lean();
    for (const p of pays) payMap.set(p.appointment_id, p);
  } else {
    const ids = appts.map((a) => a.id);
    const placeholders = ids.map(() => "?").join(",");
    const pays = getSqlite()
      .prepare(`SELECT * FROM payments WHERE appointment_id IN (${placeholders}) AND status = 'paid'`)
      .all(...ids);
    for (const p of pays) payMap.set(p.appointment_id, p);
  }

  return appts.map((a) => {
    const doc = docMap.get(Number(a.doctor_id));
    const pay = payMap.get(a.id);
    return {
      ...a,
      _id: undefined,
      __v: undefined,
      doctor_name: doc?.name || a.doctor_name || "Doctor",
      specialty: doc?.specialty || a.specialty || "",
      fee: doc?.fee ?? a.fee ?? 0,
      paid_txn: pay?.txn_id || null,
      paid_brand: pay?.card_brand || null,
      paid_last4: pay?.card_last4 || null,
      paid_at: pay?.created_at || null,
    };
  });
}

async function getAppointmentById(id) {
  const raw = await findAppointmentRaw(id);
  if (!raw) return null;
  const [enriched] = await enrichAppointments([raw]);
  return enriched;
}

async function listAppointments({ user, mine, search, status, doctorId, phone, from, to, sort = "upcoming" }) {
  if (isMongoReady()) {
    const filter = {};
    if (mine && user) {
      if (user.phone) {
        const tail10 = String(user.phone).replace(/\D/g, "").slice(-10);
        filter.$or = [{ user_id: user.id }, { phone: new RegExp(`${tail10}$`) }];
      } else {
        filter.user_id = user.id;
      }
    }
    if (status && status !== "all") filter.status = status;
    if (doctorId) filter.doctor_id = Number(doctorId);
    if (from || to) {
      filter.appt_date = {};
      if (from) filter.appt_date.$gte = from;
      if (to) filter.appt_date.$lte = to;
    }
    if (phone) {
      const digits = String(phone).replace(/\D/g, "");
      if (digits.length >= 7) {
        filter.phone = new RegExp(`${digits.slice(-10)}$`);
      } else {
        filter.phone = new RegExp(phone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
    }
    if (search) {
      const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$and = filter.$and || [];
      filter.$and.push({ $or: [{ patient_name: re }, { phone: re }, { email: re }, { reason: re }] });
    }
    const sortObj = sort === "newest" ? { created_at: -1 } : { appt_date: 1, slot_time: 1 };
    const rows = await MongoAppointment.find(filter).sort(sortObj).lean();
    return enrichAppointments(rows);
  }

  // SQLite path
  let sql = "SELECT * FROM appointments WHERE 1=1";
  const params = [];
  if (mine && user) {
    sql += " AND user_id = ?";
    params.push(user.id);
  }
  if (search) {
    sql += " AND (patient_name LIKE ? OR phone LIKE ? OR email LIKE ? OR reason LIKE ?)";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status && status !== "all") {
    sql += " AND status = ?";
    params.push(status);
  }
  if (doctorId) {
    sql += " AND doctor_id = ?";
    params.push(Number(doctorId));
  }
  if (from) {
    sql += " AND appt_date >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND appt_date <= ?";
    params.push(to);
  }
  sql += sort === "newest" ? " ORDER BY created_at DESC" : " ORDER BY appt_date ASC, slot_time ASC";
  let rows = getSqlite().prepare(sql).all(...params);
  if (phone) rows = rows.filter((r) => phoneDigitsMatch(r.phone, phone) || String(r.phone).includes(phone));
  return enrichAppointments(rows);
}

async function createAppointment(fields) {
  const doc = await getDoctor(fields.doctor_id);
  if (isMongoReady()) {
    const id = await nextSeq("appointments");
    const payload = {
      id,
      patient_name: String(fields.patient_name).trim(),
      phone: String(fields.phone).trim(),
      email: fields.email || null,
      doctor_id: Number(fields.doctor_id),
      doctor_name: doc?.name || "",
      appt_date: fields.appt_date,
      slot_time: fields.slot_time,
      reason: fields.reason || null,
      status: "confirmed",
      emergency: fields.emergency ? 1 : 0,
      payment_status: "unpaid",
      user_id: fields.user_id ?? null,
      notes: fields.notes || null,
      created_at: new Date(),
    };
    await syncApptPayloadToCollections(payload);
    return getAppointmentById(id);
  }
  const info = getSqlite()
    .prepare(
      `INSERT INTO appointments (patient_name, phone, email, doctor_id, appt_date, slot_time, reason, emergency, notes, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      String(fields.patient_name).trim(),
      String(fields.phone).trim(),
      fields.email || null,
      Number(fields.doctor_id),
      fields.appt_date,
      fields.slot_time,
      fields.reason || null,
      fields.emergency ? 1 : 0,
      fields.notes || null,
      fields.user_id ?? null
    );
  return getAppointmentById(info.lastInsertRowid);
}

async function updateAppointment(id, fields) {
  const numId = Number(id);
  const doc = await getDoctor(fields.doctor_id);
  if (isMongoReady()) {
    const updated = await MongoAppointment.findOneAndUpdate(
      { id: numId },
      {
        $set: {
          patient_name: String(fields.patient_name).trim(),
          phone: String(fields.phone).trim(),
          email: fields.email || null,
          doctor_id: Number(fields.doctor_id),
          doctor_name: doc?.name || "",
          appt_date: fields.appt_date,
          slot_time: fields.slot_time,
          reason: fields.reason || null,
          status: fields.status,
          emergency: fields.emergency ? 1 : 0,
          swapped_from: fields.swapped_from || null,
          notes: fields.notes || null,
        },
      },
      { returnDocument: "after" }
    ).lean();
    if (updated) {
      const copy = { ...updated };
      delete copy._id;
      delete copy.__v;
      await MongoBooking.findOneAndUpdate({ id: numId }, { $set: copy }, { upsert: true });
    }
    return getAppointmentById(numId);
  }
  getSqlite()
    .prepare(
      `UPDATE appointments SET patient_name=?, phone=?, email=?, doctor_id=?, appt_date=?, slot_time=?,
         reason=?, status=?, emergency=?, swapped_from=?, notes=? WHERE id=?`
    )
    .run(
      String(fields.patient_name).trim(),
      String(fields.phone).trim(),
      fields.email || null,
      Number(fields.doctor_id),
      fields.appt_date,
      fields.slot_time,
      fields.reason || null,
      fields.status,
      fields.emergency ? 1 : 0,
      fields.swapped_from || null,
      fields.notes || null,
      numId
    );
  return getAppointmentById(numId);
}

async function findOccupant(doctorId, date, slot, ignoreId) {
  if (isMongoReady()) {
    return MongoAppointment.findOne({
      doctor_id: Number(doctorId),
      appt_date: date,
      slot_time: slot,
      status: { $ne: "cancelled" },
      id: { $ne: Number(ignoreId) },
    }).lean();
  }
  return (
    getSqlite()
      .prepare("SELECT * FROM appointments WHERE doctor_id=? AND appt_date=? AND slot_time=? AND status != 'cancelled' AND id != ?")
      .get(Number(doctorId), date, slot, Number(ignoreId)) || null
  );
}

async function patchAppointmentFields(id, updates) {
  const numId = Number(id);
  if (isMongoReady()) {
    const updated = await MongoAppointment.findOneAndUpdate({ id: numId }, { $set: updates }, { returnDocument: "after" }).lean();
    if (!updated) return null;
    const copy = { ...updated };
    delete copy._id;
    delete copy.__v;
    await MongoBooking.findOneAndUpdate({ id: numId }, copy, { upsert: true });
    return getAppointmentById(numId);
  }
  const keys = Object.keys(updates);
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const info = getSqlite()
    .prepare(`UPDATE appointments SET ${setClause} WHERE id = ?`)
    .run(...keys.map((k) => updates[k]), numId);
  if (!info.changes) return null;
  return getAppointmentById(numId);
}

async function deleteAppointment(id) {
  const numId = Number(id);
  if (isMongoReady()) {
    const [res] = await Promise.all([
      MongoAppointment.deleteOne({ id: numId }),
      MongoBooking.deleteOne({ id: numId }),
    ]);
    return res.deletedCount > 0;
  }
  const info = getSqlite().prepare("DELETE FROM appointments WHERE id = ?").run(numId);
  return info.changes > 0;
}

async function getStats() {
  if (isMongoReady()) {
    const [total, confirmed, completed, cancelled, emergency, doctors] = await Promise.all([
      MongoAppointment.countDocuments(),
      MongoAppointment.countDocuments({ status: "confirmed" }),
      MongoAppointment.countDocuments({ status: "completed" }),
      MongoAppointment.countDocuments({ status: "cancelled" }),
      MongoAppointment.countDocuments({ emergency: 1 }),
      MongoDoctor.countDocuments(),
    ]);
    return { total, confirmed, completed, cancelled, emergency, doctors };
  }
  const db = getSqlite();
  return {
    total: db.prepare("SELECT COUNT(*) c FROM appointments").get().c,
    confirmed: db.prepare("SELECT COUNT(*) c FROM appointments WHERE status='confirmed'").get().c,
    completed: db.prepare("SELECT COUNT(*) c FROM appointments WHERE status='completed'").get().c,
    cancelled: db.prepare("SELECT COUNT(*) c FROM appointments WHERE status='cancelled'").get().c,
    emergency: db.prepare("SELECT COUNT(*) c FROM appointments WHERE emergency=1").get().c,
    doctors: db.prepare("SELECT COUNT(*) c FROM doctors").get().c,
  };
}

/* -------------------------------- Payments ---------------------------------- */
async function createPayment({ appointment_id, user_id, amount, method, card_brand, card_last4, txn_id }) {
  if (isMongoReady()) {
    const id = await nextSeq("payments");
    const pay = await MongoPayment.create({
      id,
      appointment_id,
      user_id,
      amount,
      method,
      card_brand,
      card_last4,
      txn_id,
      status: "paid",
      created_at: new Date(),
    });
    await patchAppointmentFields(appointment_id, { payment_status: "paid" });
    const obj = pay.toObject();
    delete obj._id;
    delete obj.__v;
    return obj;
  }
  const db = getSqlite();
  const info = db
    .prepare("INSERT INTO payments (appointment_id, user_id, amount, method, card_brand, card_last4, txn_id) VALUES (?,?,?,?,?,?,?)")
    .run(appointment_id, user_id, amount, method, card_brand, card_last4, txn_id);
  db.prepare("UPDATE appointments SET payment_status = 'paid' WHERE id = ?").run(appointment_id);
  return db.prepare("SELECT * FROM payments WHERE id = ?").get(info.lastInsertRowid);
}

async function getPaymentById(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return null;
  if (isMongoReady()) return MongoPayment.findOne({ id: numId }).lean();
  return getSqlite().prepare("SELECT * FROM payments WHERE id = ?").get(numId) || null;
}

async function refundPayment(id) {
  const numId = Number(id);
  if (isMongoReady()) {
    const pay = await MongoPayment.findOneAndUpdate(
      { id: numId },
      { $set: { status: "refunded" } },
      { returnDocument: "after" }
    ).lean();
    if (pay) await patchAppointmentFields(pay.appointment_id, { payment_status: "refunded" });
    return pay;
  }
  const db = getSqlite();
  const pay = db.prepare("SELECT * FROM payments WHERE id = ?").get(numId);
  if (!pay) return null;
  db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(numId);
  db.prepare("UPDATE appointments SET payment_status = 'refunded' WHERE id = ?").run(pay.appointment_id);
  return db.prepare("SELECT * FROM payments WHERE id = ?").get(numId);
}

/* ---------------------------------- Alex ------------------------------------ */
async function listAlexExamples() {
  if (isMongoReady()) {
    return MongoAlex.find({}).sort({ id: 1 }).select("id text intent hits -_id").lean();
  }
  return getSqlite().prepare("SELECT id, text, intent, hits FROM alex_examples ORDER BY id").all();
}

async function recordAlexFeedback(text, intent) {
  if (isMongoReady()) {
    const existing = await MongoAlex.findOne({ text }).lean();
    if (existing) {
      await MongoAlex.updateOne({ _id: existing._id }, { $inc: { hits: 1 } });
    } else {
      const id = await nextSeq("alex");
      await MongoAlex.create({ id, text, intent, hits: 1 }).catch(() => {});
    }
    return;
  }
  const db = getSqlite();
  const existing = db.prepare("SELECT id FROM alex_examples WHERE text = ?").get(text);
  if (existing) db.prepare("UPDATE alex_examples SET hits = hits + 1 WHERE id = ?").run(existing.id);
  else db.prepare("INSERT OR IGNORE INTO alex_examples (text, intent, hits) VALUES (?,?,1)").run(text, intent);
}

module.exports = {
  SLOT_TIMES,
  DAY_NAMES,
  nowIST,
  todayIST,
  isoDateOffsetIST,
  formatStampIST,
  weekdayOf,
  doctorWorksOn,
  hashPassword,
  verifyPassword,
  ensureReady,
  isMongoReady,
  getDbStatus,
  cleanUser,
  findUserByEmail,
  findUserByPhone,
  findUserByIdentifier,
  findUserById,
  createUser,
  createSession,
  getSessionUser,
  deleteSession,
  updateUserPassword,
  deleteUserSessions,
  getLatestOtp,
  storeOtpRecord,
  incrementOtpAttempts,
  markOtpVerified,
  listDoctors,
  getDoctor,
  createDoctor,
  updateDoctor,
  deleteDoctor,
  countDoctorAppointments,
  bookedMap,
  slotIsFree,
  findAppointmentRaw,
  getAppointmentById,
  listAppointments,
  createAppointment,
  updateAppointment,
  findOccupant,
  patchAppointmentFields,
  deleteAppointment,
  getStats,
  createPayment,
  getPaymentById,
  refundPayment,
  listAlexExamples,
  recordAlexFeedback,
};
