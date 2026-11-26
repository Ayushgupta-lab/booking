/* ================= MediCare Hospital — frontend logic (vanilla JS) ============= */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  doctors: [],
  allDoctors: [],
  selectedDoctor: null,
  selectedDate: null,
  selectedSlot: null,
  editingId: null,
  shiftingId: null,
  myPhone: "",
  lookupToken: sessionStorage.getItem("medicare_lookup_token") || "",
  user: null,
  checkout: null,
};

/* ---------------------------------- API -------------------------------------- */
async function api(path, options = {}, _retry = true) {
  const token = localStorage.getItem("medicare_token");
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (state.lookupToken) headers["X-Lookup-Token"] = state.lookupToken;

  const res = await fetch(path, {
    credentials: "include",
    ...options,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Sign-in wall: open the login modal, then automatically resume the same
    // request once the patient is authenticated.
    if (res.status === 401 && data.code === "auth_required" && _retry) {
      const signedIn = await showAuth(data.error || "Please sign in to continue.", { tone: "info" });
      if (signedIn) return api(path, options, false);
    }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code || null;
    throw err;
  }
  return data;
}

/* --------------------------------- Utils ------------------------------------- */
function toast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = "toast"), 3400);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

const isoOf = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const AVATAR_COLORS = ["#0d9488", "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0891b2", "#4f46e5", "#059669"];
function initials(name) {
  return name.replace(/^Dr\.?\s*/i, "").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function statusChip(status) {
  const map = { confirmed: "chip-ok", completed: "chip-info", cancelled: "chip-off" };
  return `<span class="chip ${map[status] || "chip-off"}">${esc(status)}</span>`;
}

/* ------------------------------- Navigation ----------------------------------- */
/* ----------------------------- Auth / account -------------------------------- */
async function refreshUser() {
  try {
    const { user } = await api("/api/auth/me");
    state.user = user || null;
  } catch { state.user = null; }
  renderUser();
  return state.user;
}

function renderUser() {
  const u = state.user;
  $("#navAuth").hidden = !!u;
  $("#userChip").hidden = !u;

  const isAdmin = u && u.role === "admin";
  const isDoctor = u && u.role === "doctor";
  const navAdmin = $("#navAdminLink");
  if (navAdmin) {
    navAdmin.hidden = !(isAdmin || isDoctor);
    navAdmin.textContent = isDoctor ? "Doctor Panel" : "Admin Panel";
  }

  const roleEl = $("#userRoleBadge");
  if (roleEl) {
    if (isAdmin) {
      roleEl.textContent = "Admin";
      roleEl.className = "role-badge admin";
      roleEl.hidden = false;
    } else if (isDoctor) {
      roleEl.textContent = "Doctor";
      roleEl.className = "role-badge doctor";
      roleEl.hidden = false;
    } else {
      roleEl.hidden = true; // DO NOT show role badge for patient
    }
  }

  if (!u) return;
  $("#userName").textContent = u.name;
  $("#userAva").textContent = (u.name.replace(/^Dr\.?\s*/i, "").match(/\b\w/g) || ["P"]).slice(0, 2).join("").toUpperCase();
}

let authMode = "patient"; // "patient" | "admin"
let authTab = "login";      // "login" | "register"
let forgotMode = false;
let fpChannel = "email";    // "email" | "sms"
let fpOtpSent = false;
let fpSentTarget = "";
let rgRole = "patient";     // "patient" | "doctor"
const otpTimers = {};

function startOtpCountdown(timerEl, btnEl, seconds = 25, key = "default") {
  clearInterval(otpTimers[key]);
  let left = seconds;
  if (btnEl) btnEl.disabled = true;
  const tick = () => {
    if (timerEl) timerEl.textContent = left > 0 ? `Resend in ${left}s` : "OTP expires in 5m";
    if (left <= 0) {
      clearInterval(otpTimers[key]);
      if (btnEl) btnEl.disabled = false;
    }
    left -= 1;
  };
  tick();
  otpTimers[key] = setInterval(tick, 1000);
}

function renderSandboxBanner(el, delivery) {
  if (!el) return;
  const msgs = [];
  if (delivery?.email?.mode === "sandbox" && delivery.email.sandboxOtp) {
    msgs.push(`Email OTP (Sandbox mode — configure GMAIL_USER for live email): <strong>${esc(delivery.email.sandboxOtp)}</strong>`);
  }
  if (delivery?.sms?.mode === "sandbox" && delivery.sms.sandboxOtp) {
    msgs.push(`SMS OTP (Sandbox mode — configure FAST2SMS_API_KEY / TWILIO for live SMS): <strong>${esc(delivery.sms.sandboxOtp)}</strong>`);
  }
  if (msgs.length) {
    el.innerHTML = msgs.join("<br />");
    el.hidden = false;
  } else {
    el.hidden = true;
    el.innerHTML = "";
  }
}

function authTitleText() {
  if (forgotMode) return "Reset password";
  return authMode === "admin" ? "🔐 Staff & Doctor sign-in"
    : authTab === "register" ? "Create account" : "Welcome back";
}
function applyAuthHeaders() {
  $("#authTitle").textContent = authTitleText();
  const sub = $("#authSub");
  if (sub) {
    if (forgotMode) sub.textContent = "Verify your identity via Email or SMS OTP to create a new password.";
    else if (authMode === "admin") sub.textContent = "Doctors & hospital staff — sign in to manage bookings and schedules.";
    else if (authTab === "register") {
      sub.textContent = rgRole === "doctor"
        ? "Create your Doctor account with a password to view patient bookings & manage your schedule."
        : "Create your patient account with a password to book appointments and manage visits.";
    } else sub.textContent = "Sign in to book appointments, pay online and track your visits.";
  }
}

function setFpChannel(ch) {
  fpChannel = ch;
  $$("[data-fpchannel]").forEach((b) => b.classList.toggle("active", b.dataset.fpchannel === ch));
  fpOtpSent = false;
  fpSentTarget = "";
  $("#fpOtpEntryWrap").hidden = true;
  $("#fpNewPassFields").hidden = true;
  $("#fpOtpCode").value = "";
  $("#fpNewPass").value = "";
  $("#fpConfirmPass").value = "";
  $("#fpOtpSandbox").hidden = true;
  $("#fpSendOtpBtn").hidden = false;
}

function setForgotMode(on) {
  forgotMode = Boolean(on);
  const tabs = $("#authTabs");
  authNote("");
  if (forgotMode) {
    if (tabs) tabs.hidden = true;
    $("#loginForm").hidden = true;
    $("#registerForm").hidden = true;
    $("#forgotForm").hidden = false;
    setFpChannel("email");
    const prefill = $("#liEmail").value.trim();
    if (prefill) $("#fpIdentifier").value = prefill;
    applyAuthHeaders();
    setTimeout(() => ($("#fpIdentifier").value ? $("#fpSendOtpBtn") : $("#fpIdentifier")).focus(), 60);
    return;
  }
  setAuthMode(authMode);
}

function setRgRole(role) {
  rgRole = role === "doctor" ? "doctor" : "patient";
  $$("[data-rgrole]").forEach((b) => b.classList.toggle("active", b.dataset.rgrole === rgRole));
  const isDoc = rgRole === "doctor";
  $("#rgDoctorFields").hidden = !isDoc;
  $("#rgName").placeholder = isDoc ? "e.g. Dr. Neha Verma" : "e.g. Aarav Patel";
  $("#rgSubmitBtn").textContent = isDoc ? "Create doctor account" : "Create account";
  if (authTab === "register") applyAuthHeaders();
}

function setAuthMode(mode) {
  authMode = mode;
  forgotMode = false;
  const isAdm = mode === "admin";
  const tabs = $("#authTabs");
  const pHint = $("#patientAuthHint");
  const aHint = $("#adminAuthHint");
  const sw = $("#authSwitch");
  authNote("");

  $("#forgotForm").hidden = true;
  if (isAdm) {
    if (tabs) tabs.hidden = true;
    $("#loginForm").hidden = false;
    $("#registerForm").hidden = true;
    if (pHint) pHint.hidden = true;
    if (aHint) aHint.hidden = false;
    if (sw) sw.hidden = true;
    $("#liEmail").placeholder = "Doctor or Admin email / phone";
    $("#liEmail").autofocus = true;
  } else {
    if (tabs) tabs.hidden = false;
    if (sw) sw.hidden = false;
    setAuthTab("login");
    if (pHint) pHint.hidden = false;
    if (aHint) aHint.hidden = true;
    $("#liEmail").placeholder = "you@gmail.com or +91 9876543210";
  }
  applyAuthHeaders();
}

let authResolver = null;
let authCloseTimer = null;
function showAuth(message = "", { force = false, mode = "patient", tone = "info" } = {}) {
  if (state.user && !force) return Promise.resolve(true);
  clearTimeout(authCloseTimer);
  const modal = $("#authModal");
  modal.classList.remove("closing");
  setRgRole("patient");
  setFpChannel("email");
  setAuthMode(mode);
  if (message) authNote(message, tone);
  else authNote("");
  if (!modal.open) modal.showModal();
  return new Promise((resolve) => { authResolver = resolve; });
}
function closeAuthDrawer() {
  const m = $("#authModal");
  if (!m.open || m.classList.contains("closing")) return;
  m.classList.add("closing");
  clearTimeout(authCloseTimer);
  authCloseTimer = setTimeout(() => { m.classList.remove("closing"); m.close(); }, 280);
}
function finishAuth(ok) {
  closeAuthDrawer();
  const r = authResolver; authResolver = null;
  r?.(ok);
}
$("#authModal").addEventListener("close", () => {
  $("#authModal").classList.remove("closing");
  const r = authResolver; authResolver = null;
  r?.(!!state.user);
});
$("#authModal").addEventListener("cancel", (e) => { e.preventDefault(); closeAuthDrawer(); });
$("#authClose").addEventListener("click", closeAuthDrawer);
$("#authModal").addEventListener("click", (e) => { if (e.target === $("#authModal")) closeAuthDrawer(); });
$("#authBtn").addEventListener("click", () => showAuth("", { mode: "patient" }));

$("#toAdminLogin")?.addEventListener("click", () => setAuthMode("admin"));
$("#toPatientLogin")?.addEventListener("click", () => setAuthMode("patient"));
$("#toDoctorCreate")?.addEventListener("click", () => {
  setAuthMode("patient");
  setAuthTab("register");
  setRgRole("doctor");
});
$("#toDoctorCreateFromStaff")?.addEventListener("click", () => {
  setAuthMode("patient");
  setAuthTab("register");
  setRgRole("doctor");
});
$("#toForgotPass")?.addEventListener("click", () => setForgotMode(true));
$("#backToLoginFromForgot")?.addEventListener("click", () => setForgotMode(false));
$$("[data-fpchannel]").forEach((b) => b.addEventListener("click", () => setFpChannel(b.dataset.fpchannel)));
$$("[data-rgrole]").forEach((b) => b.addEventListener("click", () => setRgRole(b.dataset.rgrole)));

function setAuthTab(tab) {
  authTab = tab;
  forgotMode = false;
  $("#forgotForm").hidden = true;
  $$("[data-authtab]").forEach((t) => t.classList.toggle("active", t.dataset.authtab === tab));
  const tabs = $("#authTabs");
  if (tabs) tabs.dataset.active = tab;
  const showForm = tab === "login" ? $("#loginForm") : $("#registerForm");
  const hideForm = tab === "login" ? $("#registerForm") : $("#loginForm");
  hideForm.hidden = true;
  showForm.hidden = false;
  showForm.classList.remove("enter");
  void showForm.offsetWidth;
  showForm.classList.add("enter");
  authNote("");
  applyAuthHeaders();
  const first = $(tab === "login" ? "#liEmail" : "#rgName");
  setTimeout(() => first?.focus(), 60);
}
$$("[data-authtab]").forEach((t) => t.addEventListener("click", () => { if (authMode !== "admin") setAuthTab(t.dataset.authtab); }));

function authNote(text, tone = "error") {
  const m = $("#authMsg");
  if (!m) return;
  if (!text) {
    m.hidden = true;
    m.className = "auth-msg";
    return;
  }
  const resolved = tone === true ? "ok" : tone === false ? "error" : tone;
  m.hidden = false;
  m.textContent = text;
  m.className = "auth-msg" + (resolved === "ok" ? " ok" : resolved === "info" ? " info" : "");
}

$$("[data-eye]").forEach((btn) => btn.addEventListener("click", () => {
  const input = document.getElementById(btn.dataset.eye);
  if (!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  btn.textContent = show ? "Hide" : "Show";
  btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  input.focus();
}));

["#loginForm", "#registerForm", "#forgotForm"].forEach((sel) =>
  document.addEventListener("input", (e) => {
    if (e.target.closest(sel)) {
      const m = $("#authMsg");
      if (m && !m.classList.contains("ok") && !m.classList.contains("info")) m.hidden = true;
    }
  }));

$("#fpIdentifier")?.addEventListener("input", () => {
  if (fpOtpSent && fpSentTarget !== $("#fpIdentifier").value.trim()) {
    fpOtpSent = false;
    $("#fpOtpEntryWrap").hidden = true;
    $("#fpNewPassFields").hidden = true;
    $("#fpOtpSandbox").hidden = true;
    $("#fpSendOtpBtn").hidden = false;
  }
});

const _authModal = $("#authModal");
new MutationObserver(() => {
  if (!_authModal.open) return;
  const target = forgotMode ? $("#fpIdentifier")
    : $(authMode === "admin" || authTab === "login" ? "#liEmail" : "#rgName");
  setTimeout(() => target?.focus(), 60);
}).observe($("#authModal"), { attributes: true, attributeFilter: ["open"] });

function refreshMyView() {
  if (state.myPhone) loadMyBookings();
  else if (state.user) showAllMine();
  else $("#myList").innerHTML = `<p class="muted">Search with your phone number to see your appointments.</p>`;
}

async function afterAuth() {
  renderUser();
  if (state.user) {
    if (!$("#pName").value) $("#pName").value = state.user.name;
    if (!$("#pPhone").value && state.user.phone) $("#pPhone").value = state.user.phone;
    if ($("#pEmail") && !$("#pEmail").value && state.user.email) $("#pEmail").value = state.user.email;
    if (state.user.phone && !$("#phoneLookup").value) $("#phoneLookup").value = state.user.phone;
  }
  if ($("#view-admin").classList.contains("active")) loadAdmin();
  if ($("#view-my").classList.contains("active")) refreshMyView();
  if (!$("#alexPanel").hidden && state.user)
    alexAdd(`Signed in as <b>${esc(state.user.name)}</b> — bookings I make now stay linked to your account.`);
  refreshStats();
}

async function sendForgotOtp() {
  const identifier = $("#fpIdentifier").value.trim();
  if (!identifier) { authNote("Enter your registered email or phone number first."); return false; }
  const btn = $("#fpSendOtpBtn");
  const resendBtn = $("#fpResendOtpBtn");
  btn.disabled = true;
  if (resendBtn) resendBtn.disabled = true;
  btn.textContent = "Sending OTP…";
  try {
    const res = await api("/api/auth/send-otp", {
      method: "POST",
      body: JSON.stringify({ purpose: "reset", channel: fpChannel, identifier }),
    });
    fpOtpSent = true;
    fpSentTarget = identifier;
    $("#fpOtpEntryWrap").hidden = false;
    $("#fpNewPassFields").hidden = false;
    btn.hidden = true;
    renderSandboxBanner($("#fpOtpSandbox"), res.delivery);
    startOtpCountdown($("#fpOtpTimer"), resendBtn, 25, "reset");
    const dest = res.delivery?.email?.target || res.delivery?.sms?.target || identifier;
    const isLive = res.delivery?.email?.delivered || res.delivery?.sms?.delivered;
    authNote(
      isLive ? `Reset OTP sent to ${dest}. Enter the code and choose a new password.`
             : `Reset OTP ready for ${dest}. Enter the code below and choose a new password.`,
      true
    );
    setTimeout(() => $("#fpOtpCode").focus(), 60);
    return true;
  } catch (err) {
    authNote(err.message);
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Reset OTP";
  }
}

$("#fpSendOtpBtn")?.addEventListener("click", sendForgotOtp);
$("#fpResendOtpBtn")?.addEventListener("click", sendForgotOtp);

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const identifier = $("#liEmail").value.trim();
  const password = $("#liPass").value;
  if (!identifier) { authNote("Enter your registered email or phone number."); return; }
  if (!password) { authNote("Enter your password to sign in."); return; }

  const btn = $("#authSubmitBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Signing in…";

  try {
    const res = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier, password }),
    });
    if (res.token) localStorage.setItem("medicare_token", res.token);
    state.user = res.user;
    authNote(`Welcome back, ${res.user.name}!`, true);
    await afterAuth();
    toast(`👋 Signed in as ${res.user.name} (${res.user.role})`, "success");
    setTimeout(() => finishAuth(true), 300);
  } catch (err) {
    authNote(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$("#forgotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!fpOtpSent) {
    await sendForgotOtp();
    return;
  }
  const identifier = $("#fpIdentifier").value.trim();
  const code = $("#fpOtpCode").value.trim();
  const newPass = $("#fpNewPass").value;
  const confirmPass = $("#fpConfirmPass").value;

  if (!/^\d{6}$/.test(code)) { authNote("Enter the 6-digit reset OTP."); return; }
  if (!newPass || newPass.length < 6) { authNote("New password must be at least 6 characters."); return; }
  if (newPass !== confirmPass) { authNote("Passwords do not match. Re-enter both fields."); return; }

  const btn = $("#fpSubmitBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Resetting password…";
  try {
    const res = await api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ channel: fpChannel, identifier, otp: code, new_password: newPass }),
    });
    setForgotMode(false);
    $("#liEmail").value = res.email || identifier;
    $("#liPass").value = "";
    authNote("Password updated! Sign in with your new password.", true);
    toast("✅ Password updated! Sign in now.", "success");
    setTimeout(() => $("#liPass").focus(), 80);
  } catch (err) {
    authNote(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$("#registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#rgName").value.trim();
  const email = $("#rgEmail").value.trim();
  const phone = $("#rgPhone").value.trim();
  const password = $("#rgPass").value;
  if (!name || name.length < 2) { authNote("Please enter your full name."); return; }
  if (!email) { authNote("Please enter a valid email address."); return; }
  if (!phone) { authNote("Please enter a valid 10-digit phone number."); return; }
  if (!password || password.length < 6) { authNote("Password must be at least 6 characters."); return; }

  const btn = $("#rgSubmitBtn");
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Creating account…";
  try {
    const payload = {
      name,
      email,
      phone,
      password,
      role: rgRole,
    };
    if (rgRole === "doctor") {
      payload.specialty = $("#rgSpecialty").value || "General Medicine";
      payload.fee = Number($("#rgFee").value || 500);
    }
    const res = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (res.token) localStorage.setItem("medicare_token", res.token);
    state.user = res.user;
    if (rgRole === "doctor") {
      await loadDoctors(true).catch(() => {});
      populateSpecialtyFilter();
      populateEmgSpecialties();
      renderHomeDoctors(state.allDoctors);
    }
    authNote(`Account created — welcome, ${res.user.name}!`, true);
    await afterAuth();
    toast(`✅ ${res.user.role === "doctor" ? "Doctor" : "Patient"} account created for ${res.user.name}`, "success");
    setTimeout(() => finishAuth(true), 300);
  } catch (err) {
    authNote(err.message);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* already signed out */ }
  localStorage.removeItem("medicare_token");
  sessionStorage.removeItem("medicare_lookup_token");
  state.user = null;
  state.myPhone = "";
  state.lookupToken = "";
  $("#phoneLookup").value = "";
  renderUser();
  toast("Signed out successfully.");
  if ($("#view-admin").classList.contains("active")) loadAdmin();
  if ($("#view-my").classList.contains("active"))
    $("#myList").innerHTML = `<p class="muted">Search with your phone number to see your appointments.</p>`;
});

document.addEventListener("click", (e) => {
  const swap = e.target.closest("[data-authtab].link-btn");
  if (swap && authMode !== "admin") { setAuthTab(swap.dataset.authtab); e.preventDefault(); }
});

function navigate(view) {
  $$(".view").forEach((v) => v.classList.remove("active"));
  $(`#view-${view}`)?.classList.add("active");
  $$(".nav-link").forEach((l) => l.classList.toggle("active", l.dataset.nav === view));
  $("#navLinks").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("#emergencyBtn").classList.toggle("active", view === "emergency");
  if (view === "home") {
    initCounters();
    initTimeline();
  }
  if (view === "my") {
    if (state.user) showAllMine();          // signed in → account bookings
    else if (state.myPhone) loadMyBookings(); // guest → phone search
  }
  if (view === "admin") loadAdmin();
  if (view === "emergency") renderEmergency();
  scheduleReveal();
}

document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) { e.preventDefault(); navigate(nav.dataset.nav); }
});

/* ================================== HOME ====================================== */
const DEPTS = [
  ["Cardiology", "❤️"], ["Dermatology", "🧴"], ["Pediatrics", "🧸"], ["Orthopedics", "🦴"],
  ["Neurology", "🧠"], ["Gynecology", "🌸"], ["ENT", "👂"], ["General Medicine", "🩺"],
];

async function refreshStats() {
  try {
    const s = await api("/api/stats");
    const docEl = $("#statDoctors");
    if (docEl && Number(s.doctors) > 0) docEl.dataset.target = String(s.doctors);
    const bkEl = $("#statBookings");
    if (bkEl && Number(s.total) > 0) bkEl.dataset.target = String(s.total);
  } catch { /* keep static fallback */ }
}

async function loadHome(skipFetch = false) {
  $("#deptGrid").innerHTML = DEPTS.map(([name, emoji]) =>
    `<button class="dept-card tilt" data-nav="book" data-specialty="${esc(name)}">
       <span class="dept-emoji">${emoji}</span>${esc(name)}
     </button>`).join("");
  if (skipFetch && state.allDoctors.length) {
    renderHomeDoctors(state.allDoctors);
  } else {
    await Promise.all([loadHomeDoctors(), refreshStats()]);
  }
  initCounters();
  initTimeline();
  initSandbox();
  scanReveals();
  initTilt();
}

function renderHomeDoctors(list) {
  const grid = $("#homeDoctorGrid");
  if (!grid) return;
  const today = isoOf(0);
  const currentDay = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(today + "T12:00:00").getDay()];
  grid.innerHTML = list.slice(0, 4).map((d, i) => {
    const worksToday = d.days?.includes(currentDay);
    return `
    <article class="home-doc-card tilt" data-reveal="fade-up" style="--i:${i}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div class="hd-ava" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${initials(d.name)}</div>
        <span class="chip ${worksToday ? 'chip-ok' : 'chip-info'}">${worksToday ? '● Available Today' : '● Next: Tomorrow'}</span>
      </div>
      <div class="hd-body" style="margin-top:0.6rem">
        <strong>${esc(d.name)}</strong>
        <span>${esc(d.specialty)} · ${esc(d.department || 'Senior Consultant')}</span>
        <div class="hd-meta" style="margin-top:0.4rem">
          <span class="hd-rating">★ ${d.rating || 4.9} (${d.experience || 8}+ yrs)</span>
          <span class="hd-fee">₹${d.fee}</span>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" type="button" data-book-doc="${d.id}" style="margin-top:0.8rem">Book Consultation →</button>
    </article>`;
  }).join("");
  initTilt();
  scanReveals();
}

async function loadHomeDoctors() {
  const grid = $("#homeDoctorGrid");
  if (!grid) return;
  try {
    const list = state.allDoctors.length ? state.allDoctors : await api("/api/doctors");
    if (!state.allDoctors.length) state.allDoctors = list;
    renderHomeDoctors(list);
  } catch { grid.innerHTML = ""; }
}

document.addEventListener("click", (e) => {
  const pick = e.target.closest("[data-book-doc], [data-home-doc]");
  if (!pick) return;
  const id = pick.dataset.bookDoc || pick.dataset.homeDoc;
  navigate("book");
  setTimeout(() => document.querySelector(`#doctorGrid [data-doctor="${id}"]`)?.click(), 80);
});

/* ================================== BOOK ====================================== */
async function loadDoctors(forceRefresh = false) {
  const q = $("#docSearch").value.trim().toLowerCase();
  const spec = $("#specialtyFilter").value;
  if (forceRefresh === true || !state.allDoctors.length) {
    state.allDoctors = await api("/api/doctors");
  }
  let list = state.allDoctors;
  if (spec) list = list.filter((d) => d.specialty === spec);
  if (q) list = list.filter((d) => (d.name + d.specialty + d.department).toLowerCase().includes(q));
  state.doctors = list;

  const grid = $("#doctorGrid");
  if (!list.length) { grid.innerHTML = `<p class="muted">No doctors match your search.</p>`; return; }
  grid.innerHTML = list.map((d, i) => {
    const today = isoOf(0);
    const works = d.days.includes(["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(today + "T12:00:00").getDay()]);
    return `
    <article class="doctor-card ${state.selectedDoctor?.id === d.id ? "selected" : ""}" data-doctor="${d.id}">
      <div class="doctor-top">
        <div class="avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${initials(d.name)}</div>
        <div>
          <h3>${esc(d.name)}</h3>
          <span class="spec">${esc(d.specialty)}</span>
        </div>
      </div>
      <div class="doctor-meta">
        <span class="fee">₹${d.fee}</span>
        <span>★ ${d.rating}</span>
        <span>${d.experience} yrs exp.</span>
        <span class="chip ${works ? "chip-ok" : "chip-off"}">${works ? "Available today" : "Off today"}</span>
      </div>
    </article>`;
  }).join("");
}

function populateSpecialtyFilter() {
  const specs = [...new Set(state.doctors.map((d) => d.specialty))].sort();
  $("#specialtyFilter").innerHTML =
    `<option value="">All specialties</option>` + specs.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#adminDoctor").innerHTML =
    `<option value="">All doctors</option>` + state.doctors.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
}

$("#doctorGrid").addEventListener("click", (e) => {
  const card = e.target.closest("[data-doctor]");
  if (!card) return;
  state.selectedDoctor = state.doctors.find((d) => d.id === Number(card.dataset.doctor));
  state.selectedSlot = null;
  $("#slotStep").hidden = false;
  $("#formStep").hidden = false;
  if (!$("#apptDate").value) $("#apptDate").value = isoOf(1);
  state.selectedDate = $("#apptDate").value;
  renderQuickDates();
  renderDocDaysHint();
  loadSlots();
  updateSummary();
  $("#slotStep").scrollIntoView({ behavior: "smooth", block: "start" });
});

function renderQuickDates() {
  const opts = [
    ["Today", 0], ["Tomorrow", 1], ["In 2 days", 2], ["In 3 days", 3], ["In 4 days", 4],
  ];
  $("#quickDates").innerHTML = opts.map(([label, off]) =>
    `<button type="button" class="quick-date ${$("#apptDate").value === isoOf(off) ? "active" : ""}" data-date="${isoOf(off)}">${label}</button>`
  ).join("");
}

function renderDocDaysHint() {
  const d = state.selectedDoctor;
  if (!d) return;
  $("#docDaysHint").textContent = `${d.name} sees patients on: ${d.days.join(", ")}. Fee ₹${d.fee}.`;
}

$("#quickDates").addEventListener("click", (e) => {
  const b = e.target.closest("[data-date]");
  if (!b) return;
  $("#apptDate").value = b.dataset.date;
  state.selectedDate = b.dataset.date;
  state.selectedSlot = null;
  renderQuickDates();
  loadSlots();
  updateSummary();
});

$("#apptDate").addEventListener("change", () => {
  state.selectedDate = $("#apptDate").value;
  state.selectedSlot = null;
  renderQuickDates();
  loadSlots();
  updateSummary();
});

async function loadSlots() {
  if (!state.selectedDoctor || !state.selectedDate) return;
  const grid = $("#slotGrid");
  grid.innerHTML = `<p class="muted">Loading slots…</p>`;
  try {
    const data = await api(`/api/slots?doctorId=${state.selectedDoctor.id}&date=${state.selectedDate}`);
    if (!data.working) {
      grid.innerHTML = `<p class="muted">${esc(data.doctor)} is off duty on ${esc(fmtDate(state.selectedDate))}. Please pick another date.</p>`;
      return;
    }
    grid.innerHTML = data.slots.map((s) =>
      `<button type="button" class="slot ${state.selectedSlot === s.time ? "selected" : ""}"
        data-slot="${s.time}" ${s.available ? "" : "disabled"}
        title="${s.available ? "Available" : "Booked"}">
        ${s.time}${s.available ? "" : `<small>booked</small>`}
      </button>`).join("");
    if (!data.slots.some((s) => s.available))
      grid.innerHTML += `<p class="hint">All slots are booked for this day — try another date.</p>`;
  } catch (err) {
    grid.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

$("#slotGrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-slot]");
  if (!b || b.disabled) return;
  state.selectedSlot = b.dataset.slot;
  $$(".slot", $("#slotGrid")).forEach((s) => s.classList.toggle("selected", s.dataset.slot === state.selectedSlot));
  updateSummary();
});

function updateSummary() {
  const d = state.selectedDoctor;
  const box = $("#bookSummary");
  if (!d || !state.selectedDate) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <span>📅 <strong>${esc(fmtDate(state.selectedDate))}</strong></span>
    ${state.selectedSlot ? `<span>⏰ <strong>${esc(state.selectedSlot)}</strong></span>` : `<span class="muted">Pick a time slot above</span>`}
    <span>🩺 <strong>${esc(d.name)}</strong> · ${esc(d.specialty)}</span>
    <span>💰 Fee <strong>₹${d.fee}</strong></span>`;
}

$("#bookForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.selectedDoctor || !state.selectedDate || !state.selectedSlot) {
    return toast("Please choose a doctor, date and time slot first.", "error");
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const created = await api("/api/appointments", {
      method: "POST",
      body: JSON.stringify({
        patient_name: $("#pName").value,
        phone: $("#pPhone").value,
        email: $("#pEmail").value || null,
        reason: $("#pReason").value || null,
        doctor_id: state.selectedDoctor.id,
        appt_date: state.selectedDate,
        slot_time: state.selectedSlot,
      }),
    });
    toast(`✅ Booking confirmed! Appointment #${created.id} — ${fmtDate(created.appt_date)} at ${created.slot_time}`, "success");
    e.target.reset();
    if (state.user) {
      $("#pName").value = state.user.name || "";
      if (state.user.phone) $("#pPhone").value = state.user.phone;
      if (state.user.email) $("#pEmail").value = state.user.email;
    }
    state.selectedSlot = null;
    loadSlots();
    updateSummary();
    refreshStats();
    if (state.myPhone) loadMyBookings();
    setTimeout(() => openCheckout(created), 350); // payment step after booking
  } catch (err) {
    toast(err.message, "error");
    loadSlots(); // refresh availability
  } finally {
    btn.disabled = false;
  }
});

/* ================================ PAYMENTS ==================================== */
function openCheckout(appt) {
  state.checkout = appt;
  const fee = appt.fee ?? 0;
  $("#payFormArea").hidden = false;
  $("#payReceipt").hidden = true;
  $("#payMsg").hidden = true;
  $("#paySummary").innerHTML = `
    <span>🩺 <b>${esc(appt.doctor_name)}</b> · ${esc(appt.specialty)}</span>
    <span>📅 <b>${esc(fmtDate(appt.appt_date))}</b> · <b>${esc(appt.slot_time)}</b> · booking #${appt.id}</span>
    <span>👤 ${esc(appt.patient_name)}</span>
    <span class="pay-amount">₹${fee}</span>`;
  $("#payBtn").textContent = `Pay ₹${fee}`;
  $("#payBtn").disabled = false;
  $("#pyNumber").value = "";
  $("#pyName").value = state.user?.name || appt.patient_name || "";
  $("#pyExpiry").value = "";
  $("#pyCvv").value = "";
  if (!$("#payModal").open) $("#payModal").showModal();
}

async function startPayment(id) {
  try {
    const appt = await api(`/api/appointments/${id}`);
    if (appt.payment_status === "paid") return showReceiptFor(appt);
    openCheckout(appt);
  } catch (err) { toast(err.message, "error"); }
}

$("#payClose").addEventListener("click", () => $("#payModal").close());
$("#payLater").addEventListener("click", () => {
  $("#payModal").close();
  toast(`You can pay ₹${state.checkout?.fee ?? "the fee"} at reception when you arrive.`);
});

$("#pyNumber").addEventListener("input", (e) => {
  const v = e.target.value.replace(/\D/g, "").slice(0, 19);
  e.target.value = v.replace(/(.{4})/g, "$1 ").trim();
});
$("#pyExpiry").addEventListener("input", (e) => {
  let v = e.target.value.replace(/\D/g, "").slice(0, 4);
  if (v.length >= 3) v = v.slice(0, 2) + "/" + v.slice(2);
  e.target.value = v;
});
$("#pyCvv").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4);
});

$("#payForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const appt = state.checkout;
  if (!appt) return;
  const btn = $("#payBtn");
  const label = btn.textContent;
  const msg = $("#payMsg");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Processing…`;
  msg.hidden = true;
  try {
    const { payment } = await api("/api/payments", {
      method: "POST",
      body: JSON.stringify({
        appointment_id: appt.id,
        card_number: $("#pyNumber").value,
        card_name: $("#pyName").value,
        expiry: $("#pyExpiry").value,
        cvv: $("#pyCvv").value,
      }),
    });
    toast(`💳 Payment of ₹${payment.amount} successful — ${payment.txn_id}`, "success");
    showReceipt({ ...appt, payment_status: "paid" }, payment);
    refreshAll();
    if ($("#view-my").classList.contains("active")) refreshMyView();
  } catch (err) {
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

function showReceipt(appt, payment) {
  $("#payFormArea").hidden = true;
  const box = $("#payReceipt");
  box.hidden = false;
  box.innerHTML = `
    <div class="rec-icon">✅</div>
    <h4>Payment received</h4>
    <div class="rec-amount">₹${payment.amount}</div>
    <div class="rec-rows">
      <span>Appointment <b>#${appt.id} · ${esc(fmtDate(appt.appt_date))} ${esc(appt.slot_time)}</b></span>
      <span>Doctor <b>${esc(appt.doctor_name)}</b></span>
      <span>Paid with <b>${esc(payment.card_brand)} ••${esc(payment.card_last4)}</b></span>
      <span>Transaction <b>${esc(payment.txn_id)}</b></span>
      <span>Date <b>${esc(payment.created_at)}</b></span>
      <span>Status <b style="color:var(--ok)">PAID</b></span>
    </div>
    <div class="pay-buttons">
      <button class="btn btn-primary" id="recDone">Done</button>
      <button class="btn btn-ghost" id="recView">View my bookings</button>
    </div>`;
  $("#recDone").onclick = () => $("#payModal").close();
  $("#recView").onclick = () => {
    $("#payModal").close();
    state.myPhone = appt.phone || state.myPhone;
    if ($("#phoneLookup")) $("#phoneLookup").value = state.myPhone || "";
    navigate("my");
    refreshMyView();
  };
}

// Receipt-only view (already paid)
async function showReceiptFor(appt) {
  try {
    const rows = await api(`/api/appointments/${appt.id}`);
    const payment = {
      amount: rows.fee,
      card_brand: rows.paid_brand || "Card",
      card_last4: rows.paid_last4 || "••••",
      txn_id: rows.paid_txn || "—",
      created_at: rows.paid_at || "",
    };
    $("#payFormArea").hidden = true;
    showReceipt(rows, payment);
    if (!$("#payModal").open) $("#payModal").showModal();
  } catch (err) { toast(err.message, "error"); }
}

/* ============================== MY BOOKINGS ==================================== */
async function triggerLookupOtp(phone) {
  const box = $("#myLookupOtpBox");
  const note = $("#myLookupOtpNote");
  const sb = $("#myLookupSandbox");
  box.hidden = false;
  note.textContent = "Sending SMS verification OTP…";
  sb.hidden = true;
  try {
    const res = await api("/api/auth/send-otp", {
      method: "POST",
      body: JSON.stringify({ purpose: "lookup", channel: "sms", phone }),
    });
    note.textContent = res.delivery?.sms?.delivered
      ? `SMS OTP sent to ${res.delivery.sms.target}. Enter it below to view your bookings.`
      : `Enter the 6-digit SMS OTP for ${res.delivery?.sms?.target || phone} to view your bookings.`;
    renderSandboxBanner(sb, res.delivery);
    startOtpCountdown($("#myLookupTimer"), $("#myLookupResendBtn"), 25, "lookup");
    setTimeout(() => $("#myLookupOtpInput").focus(), 60);
  } catch (err) {
    note.textContent = err.message;
    toast(err.message, "error");
  }
}

$("#myLookupVerifyBtn")?.addEventListener("click", async () => {
  const phone = state.myPhone || $("#phoneLookup").value.trim();
  const code = $("#myLookupOtpInput").value.trim();
  if (!phone) return toast("Enter your phone number first.", "error");
  if (!/^\d{6}$/.test(code)) return toast("Enter the 6-digit SMS OTP.", "error");
  try {
    const res = await api("/api/auth/verify-lookup-otp", {
      method: "POST",
      body: JSON.stringify({ phone, otp: code }),
    });
    state.lookupToken = res.lookupToken;
    sessionStorage.setItem("medicare_lookup_token", res.lookupToken);
    $("#myLookupOtpBox").hidden = true;
    $("#myLookupOtpInput").value = "";
    toast("📱 Phone verified!", "success");
    loadMyBookings();
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#myLookupResendBtn")?.addEventListener("click", () => {
  const phone = state.myPhone || $("#phoneLookup").value.trim();
  if (phone) triggerLookupOtp(phone);
});

async function loadMyBookings() {
  const phone = state.myPhone;
  const list = $("#myList");
  if (!phone) {
    $("#myLookupOtpBox").hidden = true;
    list.innerHTML = `<p class="muted">Search with your phone number to see your appointments.</p>`;
    return;
  }
  list.innerHTML = `<p class="muted">Searching…</p>`;
  try {
    const rows = await api(`/api/appointments?phone=${encodeURIComponent(phone)}&sort=upcoming`);
    $("#myLookupOtpBox").hidden = true;
    if (!rows.length) { list.innerHTML = `<p class="muted">No bookings found for “${esc(phone)}”. <button class="btn btn-ghost btn-sm" data-nav="book">Book one now</button></p>`; return; }
    list.innerHTML = rows.map(apptCard).join("");
  } catch (err) {
    if (err.code === "lookup_otp_required") {
      list.innerHTML = `<p class="muted">Please verify your phone number via SMS OTP above to view your bookings.</p>`;
      triggerLookupOtp(phone);
      return;
    }
    list.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

function apptCard(a) {
  const past = a.status !== "confirmed";
  return `
  <article class="appt-card ${a.emergency ? "is-emergency" : ""}">
    <div class="appt-card-head">
      <div>
        <h3>${esc(a.doctor_name)}</h3>
        <span class="spec">${esc(a.specialty)} · ₹${a.fee}</span>
      </div>
      <div style="display:flex;gap:0.35rem;flex-wrap:wrap;justify-content:flex-end">
        ${a.emergency ? `<span class="chip chip-danger">⚡ emergency shift</span>` : ""}
        ${a.payment_status === "paid" ? `<span class="chip chip-ok">💳 paid</span>`
          : a.status !== "cancelled" ? `<span class="chip chip-warn">unpaid</span>` : ""}
        ${statusChip(a.status)}
      </div>
    </div>
    <div class="appt-when">
      <span class="when-pill">📅 ${esc(fmtDate(a.appt_date))}</span>
      <span class="when-pill">⏰ ${esc(a.slot_time)}</span>
      <span class="when-pill">#${a.id}</span>
    </div>
    <p class="appt-meta"><b>${esc(a.patient_name)}</b> · ${esc(a.phone)}${a.reason ? ` · ${esc(a.reason)}` : ""}</p>
    ${a.swapped_from ? `<p class="appt-note">Moved from ${esc(a.swapped_from)}</p>` : ""}
    ${a.notes ? `<p class="appt-note">${esc(a.notes)}</p>` : ""}
    ${a.payment_status === "paid" && a.paid_txn ? `<p class="appt-note appt-paid">💳 ${esc(a.paid_brand || "Card")} ••${esc(a.paid_last4 || "")} · Txn ${esc(a.paid_txn)}</p>` : ""}
    <div class="appt-actions">
      <button class="btn btn-ghost btn-sm" data-edit="${a.id}">✎ Edit</button>
      ${a.payment_status !== "paid" && a.status !== "cancelled" ? `<button class="btn btn-primary btn-sm" data-pay="${a.id}">💳 Pay ₹${a.fee}</button>` : ""}
      ${past === false || a.status === "confirmed" ? `<button class="btn btn-shift btn-sm" data-shift="${a.id}">🚨 Emergency shift</button>` : ""}
      ${a.status === "confirmed" ? `<button class="btn btn-ghost btn-sm" data-status="completed" data-id="${a.id}">✓ Mark done</button>
        <button class="btn btn-ghost btn-sm" data-status="cancelled" data-id="${a.id}">Cancel</button>` : ""}
      ${a.status === "cancelled" ? `<button class="btn btn-ghost btn-sm" data-status="confirmed" data-id="${a.id}">Restore</button>` : ""}
      <button class="btn btn-ghost btn-sm" data-delete="${a.id}">🗑 Delete</button>
    </div>
  </article>`;
}

$("#lookupBtn").addEventListener("click", () => {
  const v = $("#phoneLookup").value.trim();
  if (!v) return toast("Enter a phone number to look up bookings.", "error");
  state.myPhone = v;
  loadMyBookings();
});
$("#phoneLookup").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#lookupBtn").click(); });
$("#showAllBtn").addEventListener("click", () => { state.myPhone = ""; $("#myList").innerHTML = ""; loadMyBookings(); $("#phoneLookup").value = ""; showAllMine(); });

async function showAllMine() {
  const list = $("#myList");
  if (!state.user) {
    list.innerHTML = `<div class="lookup-empty"><p class="muted">Sign in to see every appointment on your account — or search with your phone number above.</p>
      <button class="btn btn-primary" data-signin>Sign in</button></div>`;
    return;
  }
  list.innerHTML = `<p class="muted">Loading your bookings…</p>`;
  try {
    const rows = await api("/api/appointments?mine=1&sort=upcoming");
    list.innerHTML = rows.length
      ? rows.map(apptCard).join("")
      : `<p class="muted">No bookings on your account yet. <button class="btn btn-ghost btn-sm" data-nav="book">Book one now</button></p>`;
  } catch (err) { list.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-signin]")) showAuth("", { mode: "patient" });
});

/* ---------------------------- shared card actions ----------------------------- */
document.addEventListener("click", async (e) => {
  const editId = e.target.closest("[data-edit]")?.dataset.edit;
  const shiftId = e.target.closest("[data-shift]")?.dataset.shift;
  const delId = e.target.closest("[data-delete]")?.dataset.delete;
  const statusBtn = e.target.closest("[data-status][data-id]");
  const payId = e.target.closest("[data-pay]")?.dataset.pay;

  if (editId) return openEdit(Number(editId));
  if (shiftId) return openShift(Number(shiftId));
  if (payId) return startPayment(Number(payId));
  if (delId) {
    if (!confirm(`Delete appointment #${delId} permanently? This cannot be undone.`)) return;
    try { await api(`/api/appointments/${delId}`, { method: "DELETE" }); toast(`🗑 Appointment #${delId} deleted.`, "success"); refreshAll(); }
    catch (err) { toast(err.message, "error"); }
    return;
  }
  if (statusBtn) {
    try {
      await api(`/api/appointments/${statusBtn.dataset.id}/status`, { method: "PATCH", body: JSON.stringify({ status: statusBtn.dataset.status }) });
      toast(`Appointment #${statusBtn.dataset.id} → ${statusBtn.dataset.status}.`, "success");
      refreshAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

/* --------------------------------- Edit modal ---------------------------------- */
async function openEdit(id) {
  let a;
  try { a = await api(`/api/appointments/${id}`); }
  catch (err) { return toast(err.message, "error"); }
  if (!a) return toast("Appointment not found.", "error");
  state.editingId = id;
  $("#editApptId").textContent = `#${id}`;
  $("#eName").value = a.patient_name;
  $("#ePhone").value = a.phone;
  $("#eEmail").value = a.email || "";
  $("#eReason").value = a.reason || "";
  $("#eDate").value = a.appt_date;
  $("#eStatus").value = a.status;
  $("#eSlot").innerHTML = slotOptions(a.slot_time);
  $("#editModal").showModal();
}

const ALL_SLOTS = ["09:00","09:30","10:00","10:30","11:00","11:30","12:00","12:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30"];
function slotOptions(selected) {
  return ALL_SLOTS.map((t) => `<option ${t === selected ? "selected" : ""}>${t}</option>`).join("");
}

$("#editSave").addEventListener("click", async (e) => {
  e.preventDefault();
  const payload = {
    patient_name: $("#eName").value,
    phone: $("#ePhone").value,
    email: $("#eEmail").value || null,
    reason: $("#eReason").value || null,
    appt_date: $("#eDate").value,
    slot_time: $("#eSlot").value,
    status: $("#eStatus").value,
  };
  try {
    const updated = await api(`/api/appointments/${state.editingId}`, { method: "PUT", body: JSON.stringify(payload) });
    $("#editModal").close();
    toast(updated.slot_moved ? `✏️ Updated & slot moved to ${fmtDate(updated.appt_date)} ${updated.slot_time}.` : "✏️ Appointment updated.", "success");
    refreshAll();
  } catch (err) { toast(err.message, "error"); }
});

/* ------------------------------ Emergency shift modal ---------------------------- */
async function openShift(id) {
  let a;
  try { a = await api(`/api/appointments/${id}`); }
  catch (err) { return toast(err.message, "error"); }
  if (!a) return toast("Appointment not found.", "error");
  state.shiftingId = id;
  $("#shiftFor").innerHTML = `Shifting <strong>#${a.id} · ${esc(a.patient_name)}</strong> with ${esc(a.doctor_name)} — currently <strong>${esc(fmtDate(a.appt_date))} at ${esc(a.slot_time)}</strong>.`;
  $("#sDate").value = isoOf(1);
  $("#sSwap").checked = false;
  $("#shiftHint").textContent = "";
  await loadShiftSlots(id, $("#sDate").value);
  $("#shiftModal").showModal();
}

$("#sDate").addEventListener("change", () => loadShiftSlots(state.shiftingId, $("#sDate").value));

async function loadShiftSlots(apptId, date) {
  let a;
  try { a = await api(`/api/appointments/${apptId}`); }
  catch { return; }
  if (!a) return;
  const data = await api(`/api/slots?doctorId=${a.doctor_id}&date=${date}`);
  const sel = $("#sSlot");
  if (!data.working) { sel.innerHTML = `<option value="">Off duty that day</option>`; return; }
  sel.innerHTML = data.slots.map((s) =>
    `<option value="${s.time}" ${s.available ? "" : "data-taken"}>${s.time}${s.available ? " — free" : ` — taken by ${s.booked_by}`}${s.time === a.slot_time && date === a.appt_date ? " (current)" : ""}</option>`
  ).join("");
  const free = data.slots.find((s) => s.available);
  if (free) sel.value = free.time;
  $("#shiftHint").textContent = data.slots.some((s) => !s.available)
    ? "Taken slots can still be selected — enable swap below to exchange with the patient holding it."
    : "All slots on this day are free.";
}

$("#shiftSave").addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    const result = await api(`/api/appointments/${state.shiftingId}/emergency-shift`, {
      method: "POST",
      body: JSON.stringify({
        new_date: $("#sDate").value,
        new_slot: $("#sSlot").value,
        allow_swap: $("#sSwap").checked,
      }),
    });
    $("#shiftModal").close();
    const swapNote = result.swapped_with ? ` Swapped with ${result.swapped_with.patient_name}.` : "";
    toast(`⚡ Shifted to ${fmtDate(result.appointment.appt_date)} at ${result.appointment.slot_time}.${swapNote}`, "success");
    refreshAll();
  } catch (err) { toast(err.message, "error"); }
});

/* ================================== ADMIN ====================================== */
async function loadStats() {
  const url = state.user?.role === "doctor" ? "/api/stats?scope=doctor" : "/api/stats";
  const s = await api(url);
  $("#aTotal").textContent = s.total;
  $("#aConfirmed").textContent = s.confirmed;
  $("#aCompleted").textContent = s.completed;
  $("#aCancelled").textContent = s.cancelled;
  $("#aEmergency").textContent = s.emergency;
}

function showAdminGate(message) {
  $("#view-admin").classList.add("gated");
  $("#adminGate").hidden = false;
  if (message) $("#adminGateMsg").textContent = message;
}
function hideAdminGate() {
  $("#view-admin").classList.remove("gated");
  $("#adminGate").hidden = true;
}
$("#adminSignin").addEventListener("click", async () => {
  const note = state.user ? `You're signed in as ${state.user.name}. Sign in with a Doctor or Admin account below.` : "";
  const ok = await showAuth(note, { force: true, mode: "admin", tone: "info" });
  if (ok && state.user?.role !== "admin" && state.user?.role !== "doctor")
    showAdminGate("That account is a patient account. Sign in with a Doctor or Admin account.");
  else loadAdmin();
});

async function loadAdmin() {
  if (!state.user) {
    showAdminGate("The Staff / Doctor panel requires a Doctor or Admin account.");
    return;
  }
  const isDoctor = state.user.role === "doctor";
  const isAdmin = state.user.role === "admin";
  if (!isAdmin && !isDoctor) {
    showAdminGate(`You're signed in as ${state.user.name} (patient). Doctor or Admin access is required for this panel.`);
    return;
  }
  if ($("#adminPanelTitle")) $("#adminPanelTitle").textContent = isDoctor ? "Doctor panel" : "Admin panel";
  if ($("#adminPanelSub")) {
    $("#adminPanelSub").textContent = isDoctor
      ? "View and manage patient appointments booked with you, and update your clinic profile."
      : "Every booking in one place — create, read, update and delete.";
  }
  if ($("#docMgmtTitle")) $("#docMgmtTitle").textContent = isDoctor ? "My doctor profile" : "Manage doctors";
  if ($("#adminDoctor")) $("#adminDoctor").hidden = isDoctor;
  if ($("#addDoctorBtn")) $("#addDoctorBtn").hidden = isDoctor;

  hideAdminGate();
  await loadStats();
  loadDoctorMgmt();
  const params = new URLSearchParams({ sort: "upcoming" });
  const q = $("#adminSearch").value.trim();
  const st = $("#adminStatus").value;
  const doc = $("#adminDoctor").value;
  if (q) params.set("search", q);
  if (st && st !== "all") params.set("status", st);
  if (!isDoctor && doc) params.set("doctorId", doc);

  const tbody = $("#adminRows");
  tbody.innerHTML = `<tr><td colspan="7" class="muted center">Loading…</td></tr>`;
  try {
    const rows = await api(`/api/appointments?${params}`);
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" class="muted center">No appointments match the current filters.</td></tr>`; return; }
    tbody.innerHTML = rows.map((a) => `
      <tr>
        <td>#${a.id}${a.emergency ? `<div class="cell-sub" style="color:var(--danger)">⚡ shift</div>` : ""}</td>
        <td><strong>${esc(a.patient_name)}</strong><div class="cell-sub">${esc(a.phone)}</div>${a.email ? `<div class="cell-sub">${esc(a.email)}</div>` : ""}</td>
        <td>${esc(a.doctor_name)}<div class="cell-sub">${esc(a.specialty)} · ₹${a.fee}</div></td>
        <td>${esc(fmtDate(a.appt_date))}<div class="cell-sub">${esc(a.slot_time)}</div></td>
        <td>${esc(a.reason || "—")}${a.notes ? `<div class="cell-sub">${esc(a.notes)}</div>` : ""}</td>
        <td>${statusChip(a.status)}
          <div class="cell-sub">${a.payment_status === "paid" ? `💳 paid · ${esc(a.paid_txn || "")}`
            : a.payment_status === "refunded" ? "↩ refunded" : "⏳ unpaid"}</div></td>
        <td class="td-actions">
          <button class="btn btn-ghost btn-sm" data-edit="${a.id}" title="Edit">✎</button>
          <button class="btn btn-shift btn-sm" data-shift="${a.id}" title="Emergency shift">⚡</button>
          ${a.status === "confirmed" ? `
            <button class="btn btn-ghost btn-sm" data-status="completed" data-id="${a.id}" title="Mark done">✓</button>
            <button class="btn btn-ghost btn-sm" data-status="cancelled" data-id="${a.id}" title="Cancel">✕</button>` : `
            <button class="btn btn-ghost btn-sm" data-status="confirmed" data-id="${a.id}" title="Restore">↺</button>`}
          <button class="btn btn-ghost btn-sm" data-delete="${a.id}" title="Delete">🗑</button>
        </td>
      </tr>`).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted center">${esc(err.message)}</td></tr>`;
  }
}

$("#adminSearch").addEventListener("input", debounce(loadAdmin, 250));
$("#adminStatus").addEventListener("change", loadAdmin);
$("#adminDoctor").addEventListener("change", loadAdmin);
$("#adminRefresh").addEventListener("click", () => { loadAdmin(); toast("↻ Refreshed"); });
$("#adminNew").addEventListener("click", () => navigate("book"));

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ------------------------------- global wiring ---------------------------------- */
function refreshAll() {
  refreshStats();
  if (state.selectedDoctor) loadSlots();
  if (state.myPhone) loadMyBookings();
  if ($("#view-my").classList.contains("active") && !state.myPhone) showAllMine();
  if ($("#view-admin").classList.contains("active")) loadAdmin();
}

$("#docSearch").addEventListener("input", debounce(loadDoctors, 200));
$("#specialtyFilter").addEventListener("change", loadDoctors);
$("#navLinks").addEventListener("click", (e) => {
  const sp = e.target.closest("[data-specialty]");
  if (sp) { $("#specialtyFilter").value = sp.dataset.specialty; loadDoctors(); }
});
$("#navBurger").addEventListener("click", () => $("#navLinks").classList.toggle("open"));

/* ==================== EMERGENCY AUTO-ASSIGN BOOKING VIEW ==================== */
function populateEmgSpecialties() {
  const specs = [...new Set((state.allDoctors || state.doctors).map((d) => d.specialty))].sort();
  $("#emgSpecialty").innerHTML =
    `<option value="">Any / fastest available</option>` + specs.map((s) => `<option>${esc(s)}</option>`).join("");
}

function renderEmergency() {
  populateEmgSpecialties();
}

$("#emergencyBtn").addEventListener("click", () => navigate("emergency"));

$("#emgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "Scanning for the earliest slot…";
  try {
    const created = await api("/api/appointments/emergency", {
      method: "POST",
      body: JSON.stringify({
        patient_name: $("#emgName").value,
        phone: $("#emgPhone").value,
        specialty: $("#emgSpecialty").value || null,
        reason: $("#emgReason").value || null,
      }),
    });
    renderEmergencyResult(created);
    toast(`⚡ Emergency slot assigned — #${created.id}, ${created.slot_time}`, "success");
    e.target.reset();
    populateEmgSpecialties();
    refreshAll();
  } catch (err) {
    const box = $("#emgResult");
    box.hidden = false;
    box.innerHTML = `<h3>⚠️ Couldn't auto-assign</h3><p class="muted" style="font-size:0.88rem">${esc(err.message)}</p>
      <div class="appt-actions"><button class="btn btn-shift btn-sm" data-nav="book">Choose a slot manually</button></div>`;
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Find earliest slot now";
  }
});

function renderEmergencyResult(a) {
  if (a.lookupToken) {
    state.lookupToken = a.lookupToken;
    sessionStorage.setItem("medicare_lookup_token", a.lookupToken);
  }
  const box = $("#emgResult");
  box.hidden = false;
  box.innerHTML = `
    <h3>✅ You're booked, ${esc(a.patient_name)}</h3>
    <p class="muted" style="font-size:0.85rem">Earliest available slot found and reserved for you.</p>
    <div class="emg-big">${esc(fmtDate(a.appt_date))} · ${esc(a.slot_time)}</div>
    <div class="emg-rows">
      <span>🩺 <b>${esc(a.doctor_name)}</b> — ${esc(a.specialty)}</span>
      <span>💰 Fee <b>₹${a.fee}</b> · booking <b>#${a.id}</b></span>
      <span>⚡ Flagged as emergency — staff will prioritise this visit.</span>
    </div>
    <div class="appt-actions">
      <button class="btn btn-primary btn-sm" id="emgView">View my booking</button>
      <button class="btn btn-ghost btn-sm" data-edit="${a.id}">✎ Edit details</button>
    </div>`;
  $("#emgView").onclick = () => {
    state.myPhone = a.phone;
    $("#phoneLookup").value = a.phone;
    navigate("my");
    loadMyBookings();
  };
}

/* ============================ MANAGE DOCTORS ============================== */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekdayOf = (date) => DAY_NAMES[new Date(date + "T12:00:00").getDay()];
let editingDoctorId = null;

async function loadDoctorMgmt() {
  const grid = $("#docMgmtGrid");
  if (!grid) return;
  try {
    state.allDoctors = await api("/api/doctors");
  } catch (err) {
    grid.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    return;
  }
  const isDoctor = state.user?.role === "doctor";
  const visible = isDoctor
    ? state.allDoctors.filter((d) => Number(d.id) === Number(state.user.doctor_id))
    : state.allDoctors;
  if (!visible.length) {
    grid.innerHTML = `<p class="muted">${isDoctor ? "No linked doctor profile found yet." : "No doctors yet — add your first specialist."}</p>`;
    return;
  }
  grid.innerHTML = visible.map((d, i) => `
    <article class="doc-mgmt-card">
      <div class="doc-mgmt-top">
        <div class="avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${initials(d.name)}</div>
        <div>
          <h3>${esc(d.name)}</h3>
          <span class="spec">${esc(d.specialty)} · ${esc(d.department || "General")}</span>
        </div>
      </div>
      <div class="doc-mgmt-meta">
        <span>₹${d.fee}</span><span>★ ${d.rating}</span><span>${d.experience} yrs</span>
        <span>${esc(d.days.join(" "))}</span>
      </div>
      ${d.bio ? `<p class="doc-mgmt-bio">${esc(d.bio)}</p>` : ""}
      <div class="doc-mgmt-actions">
        <button class="btn btn-ghost btn-sm" data-doc-edit="${d.id}">✎ Edit</button>
        ${isDoctor ? "" : `<button class="btn btn-ghost btn-sm" data-doc-del="${d.id}">🗑 Delete</button>`}
      </div>
    </article>`).join("");
}

function renderDayToggles(days) {
  $("#dDays").innerHTML = DAY_NAMES.slice(1).concat("Sun").map((d) =>
    `<button type="button" class="day-toggle ${days.includes(d) ? "on" : ""}" data-day="${d}">${d}</button>`
  ).join("");
}

$("#dDays").addEventListener("click", (e) => {
  const b = e.target.closest("[data-day]");
  if (b) b.classList.toggle("on");
});

function openDoctorModal(doctor = null) {
  editingDoctorId = doctor?.id || null;
  $("#doctorModalTitle").textContent = doctor ? `Edit ${doctor.name}` : "Add new doctor";
  $("#dName").value = doctor?.name || "";
  $("#dSpecialty").value = doctor?.specialty || "";
  $("#dDepartment").value = doctor?.department || "";
  $("#dFee").value = doctor?.fee ?? "";
  $("#dRating").value = doctor?.rating ?? "";
  $("#dExperience").value = doctor?.experience ?? "";
  $("#dBio").value = doctor?.bio || "";
  renderDayToggles(doctor?.days || ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  $("#doctorModal").showModal();
}

$("#addDoctorBtn").addEventListener("click", () => openDoctorModal());

document.addEventListener("click", (e) => {
  const edit = e.target.closest("[data-doc-edit]");
  const del = e.target.closest("[data-doc-del]");
  if (edit) {
    const doc = (state.allDoctors || []).find((d) => d.id === Number(edit.dataset.docEdit));
    if (doc) openDoctorModal(doc);
  }
  if (del) {
    const id = Number(del.dataset.docDel);
    const doc = (state.allDoctors || []).find((d) => d.id === id);
    if (!doc) return;
    if (!confirm(`Delete ${doc.name} permanently?`)) return;
    api(`/api/doctors/${id}`, { method: "DELETE" })
      .then(() => { toast(`🗑 ${doc.name} removed.`, "success"); refreshDoctorsEverywhere(); })
      .catch((err) => toast(err.message, "error"));
  }
});

$("#doctorSave").addEventListener("click", async (e) => {
  e.preventDefault();
  const days = $$("#dDays .day-toggle.on").map((b) => b.dataset.day);
  if (!days.length) return toast("Pick at least one working day.", "error");
  const payload = {
    name: $("#dName").value.trim(),
    specialty: $("#dSpecialty").value.trim(),
    department: $("#dDepartment").value.trim() || $("#dSpecialty").value.trim(),
    fee: Number($("#dFee").value || 0),
    rating: Number($("#dRating").value || 4.5),
    experience: Number($("#dExperience").value || 1),
    bio: $("#dBio").value.trim() || null,
    days,
  };
  if (!payload.name || !payload.specialty) return toast("Name and specialty are required.", "error");
  try {
    if (editingDoctorId) {
      await api(`/api/doctors/${editingDoctorId}`, { method: "PUT", body: JSON.stringify(payload) });
      toast(`✏️ ${payload.name} updated.`, "success");
    } else {
      await api("/api/doctors", { method: "POST", body: JSON.stringify(payload) });
      toast(`✅ ${payload.name} added to the team.`, "success");
    }
    $("#doctorModal").close();
    editingDoctorId = null;
    refreshDoctorsEverywhere();
  } catch (err) {
    toast(err.message, "error");
  }
});

async function refreshDoctorsEverywhere() {
  await loadDoctors(true);
  populateSpecialtyFilter();
  populateEmgSpecialties();
  await loadDoctorMgmt();
  renderHomeDoctors(state.allDoctors);
  if (!state.selectedDoctor) { $("#slotStep").hidden = true; $("#formStep").hidden = true; }
}

/* ========================= ALEX — BOOKING ASSISTANT ======================= */
const alex = { voiceOn: true, step: null, draft: {}, slotOptions: [], greeted: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripTags = (html) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent || "";
};

function alexAdd(html, who = "bot") {
  const chat = $("#alexChat");
  const el = document.createElement("div");
  el.className = `alex-msg ${who}`;
  el.innerHTML = html;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function alexChips(list = []) {
  const wrap = $("#alexChips");
  wrap.innerHTML = list
    .map(([label, value]) => `<button type="button" class="chip-btn" data-chip="${esc(value ?? label)}">${esc(label)}</button>`)
    .join("");
}

function alexTyping() {
  const chat = $("#alexChat");
  const el = document.createElement("div");
  el.className = "alex-typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

async function alexReply(html, { chips = [], say = null } = {}) {
  const typing = alexTyping();
  await sleep(380 + Math.random() * 300);
  typing.remove();
  alexAdd(html);
  alexChips(chips);
  speak(say || stripTags(html));
}

function speak(text) {
  if (!alex.voiceOn || !("speechSynthesis" in window) || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 240));
    u.rate = 1.03;
    u.pitch = 1.05;
    const voice = speechSynthesis.getVoices().find((v) => /^en-IN|^en-GB|^en-US/i.test(v.lang));
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  } catch { /* speech is best-effort */ }
}

function openAlex() {
  $("#alexPanel").hidden = false;
  if (!alex.greeted) {
    alex.greeted = true;
    alexAdd("Hi, I'm <b>Alex</b> 🤖 your booking assistant. I can find a doctor, book or reschedule a slot, or auto-assign an emergency appointment.");
    alexChips([
      ["Book an appointment", "book an appointment"],
      ["Emergency booking ⚡", "emergency booking"],
      ["My bookings", "my bookings"],
      ["Which doctors?", "show doctors"],
    ]);
    speak("Hi, I'm Alex, your booking assistant. How can I help?");
  }
  setTimeout(() => $("#alexText").focus(), 120);
}

$("#alexToggle").addEventListener("click", () => {
  if ($("#alexPanel").hidden) openAlex();
  else $("#alexPanel").hidden = true;
});
$("#alexClose").addEventListener("click", () => { $("#alexPanel").hidden = true; speechSynthesis?.cancel?.(); });

$("#alexVoice").addEventListener("click", () => {
  alex.voiceOn = !alex.voiceOn;
  $("#alexVoice").textContent = alex.voiceOn ? "🔊" : "🔇";
  $("#alexVoice").title = alex.voiceOn ? "Voice replies on" : "Voice replies off";
  if (!alex.voiceOn) speechSynthesis?.cancel?.();
  else speak("Voice replies on.");
});

$("#alexForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("#alexText").value.trim();
  $("#alexText").value = "";
  alexHandle(value);
});

$("#alexChips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-chip]");
  if (chip) alexHandle(chip.dataset.chip);
});

/* --- speech input --- */
(function initMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("#alexMic");
  if (!SR) {
    mic.title = "Voice input isn't supported in this browser";
    mic.style.opacity = "0.45";
    mic.addEventListener("click", () => toast("Voice input isn't supported in this browser — type instead.", "error"));
    return;
  }
  const rec = new SR();
  rec.lang = "en-IN";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (ev) => {
    const text = ev.results[0][0].transcript;
    alexAdd(esc(text), "user");
    alexHandle(text, true);
  };
  rec.onend = () => mic.classList.remove("listening");
  rec.onerror = (ev) => {
    mic.classList.remove("listening");
    if (ev.error === "not-allowed") toast("Microphone permission was blocked.", "error");
  };
  mic.addEventListener("click", () => {
    if (mic.classList.contains("listening")) return rec.stop();
    mic.classList.add("listening");
    try { rec.start(); } catch { mic.classList.remove("listening"); }
  });
})();

/* --- helpers --- */
const ALL_SPECIALTIES = () => [...new Set((state.allDoctors || state.doctors).map((d) => d.specialty))].sort();
const shortName = (name) => "Dr. " + name.replace(/^Dr\.?\s*/i, "").split(" ").pop();

function parseDateText(text) {
  const t = text.toLowerCase();
  if (/\btoday\b|\baaj\b/.test(t)) return isoOf(0);
  if (/\btomorrow\b|\bkal\b/.test(t)) return isoOf(1);
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const full = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  for (let i = 0; i < 7; i++) {
    if (t.includes(full[i]) || new RegExp(`\\b${DAY_NAMES[i].toLowerCase()}\\b`).test(t)) {
      const delta = (i - new Date().getDay() + 7) % 7;
      return isoOf(delta === 0 ? 7 : delta);
    }
  }
  return null;
}

function parseTimeText(text) {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 7) h += 12;
  const t = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  return ALL_SLOTS.includes(t) ? t : null;
}

function matchSpecialty(text) {
  const t = text.toLowerCase();
  const specs = ALL_SPECIALTIES();
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = specs.find((s) => new RegExp(`\\b${escRe(s.toLowerCase())}\\b`).test(t));
  if (exact) return exact;
  // Loose stem match so "cardiologist" finds Cardiology — long names only,
  // so short ones like ENT can't match inside "appointment".
  return specs.find((s) => {
    if (s.length < 6) return false;
    const stem = s.toLowerCase().slice(0, 5);
    return t.includes(stem);
  }) || null;
}

/* --- flow steps --- */
async function alexStartBooking(pre = {}) {
  alex.draft = { specialty: pre.specialty || null, date: pre.date || null, slot: pre.slot || null, reason: pre.reason || null };
  alex.step = "name";
  alexChips([]);
  await alexReply("Let's get you booked. What's the <b>patient's full name</b>?", { say: "What is the patient's name?" });
}

async function alexAskSpecialty() {
  alex.step = "specialty";
  const chips = ALL_SPECIALTIES().slice(0, 8).map((s) => [s, s]);
  chips.push(["Emergency ⚡", "emergency"]);
  await alexReply("Which department should we look at?", { chips, say: "Which department?" });
}

async function alexAskDate() {
  alex.step = "date";
  await alexReply(
    `Noted — ${esc(alex.draft.specialty || "any department")}. Which day works?`,
    { chips: [["Today", isoOf(0)], ["Tomorrow", isoOf(1)], ["In 2 days", isoOf(2)], ["In 3 days", isoOf(3)]], say: "Which day works for you?" }
  );
}

async function alexSlotOptionsFor(date, specialty) {
  let docs = (state.allDoctors || state.doctors).filter((d) => !specialty || d.specialty.toLowerCase() === specialty.toLowerCase());
  if (!docs.length) docs = state.allDoctors || state.doctors;
  const out = [];
  for (const doc of docs.slice(0, 6)) {
    if (!doc.days.includes(weekdayOf(date))) continue;
    try {
      const data = await api(`/api/slots?doctorId=${doc.id}&date=${date}`);
      if (!data.working) continue;
      data.slots.filter((s) => s.available).forEach((s) => out.push({ doctor: doc, time: s.time }));
    } catch { /* skip this doctor */ }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time)).slice(0, 9);
}

async function alexAskSlot() {
  alex.step = "slot";
  const opts = await alexSlotOptionsFor(alex.draft.date, alex.draft.specialty);
  alex.slotOptions = opts;
  if (!opts.length) {
    alex.step = "date";
    return alexReply(`No free slots on ${esc(fmtDate(alex.draft.date))}. Pick another day?`, {
      chips: [["Tomorrow", isoOf(1)], ["In 2 days", isoOf(2)], ["In 3 days", isoOf(3)]],
    });
  }
  // If the patient already named a time earlier, skip ahead when it's free
  if (alex.draft.slot) {
    const hit = opts.find((o) => o.time === alex.draft.slot);
    if (hit) {
      alex.draft.doctorId = hit.doctor.id;
      return alexConfirmDraft();
    }
  }
  await alexReply(`On ${esc(fmtDate(alex.draft.date))} these are open — tap one:`, {
    chips: opts.map((o) => [`${o.time} · ${shortName(o.doctor.name)}`, `${o.time}|${o.doctor.id}`]),
    say: "These slots are open. Tap one to select it.",
  });
}

async function alexConfirmDraft() {
  const d = alex.draft;
  const doc = (state.allDoctors || state.doctors).find((x) => x.id === d.doctorId);
  d.doctorName = doc ? doc.name : "";
  alex.step = "confirm";
  await alexReply(
    `Please confirm:\n🩺 <b>${esc(doc ? doc.name : "doctor")}</b> · ${esc(doc ? doc.specialty : "")}\n📅 <b>${esc(fmtDate(d.date))}</b> at <b>${esc(d.slot)}</b>\n👤 ${esc(d.name)} · ${esc(d.phone)}`,
    { chips: [["✅ Confirm booking", "confirm"], ["✏️ Pick another slot", "change slot"], ["❌ Cancel", "reset"]], say: "Shall I confirm this booking?" }
  );
}

async function alexBook() {
  const d = alex.draft;
  const doc = (state.allDoctors || state.doctors).find((x) => x.id === d.doctorId);
  if (!doc) return alexHandle("book an appointment");
  try {
    const created = await api("/api/appointments", {
      method: "POST",
      body: JSON.stringify({
        patient_name: d.name, phone: d.phone, doctor_id: doc.id,
        appt_date: d.date, slot_time: d.slot, reason: d.reason || "Booked with Alex",
      }),
    });
    alex.step = null;
    alex.draft = {};
    state.myPhone = created.phone;
    $("#phoneLookup").value = created.phone;
    toast(`✅ Booked with Alex — #${created.id}`, "success");
    refreshAll();
    if ($("#view-my").classList.contains("active")) loadMyBookings();
    await alexReply(
      `🎉 All set! Appointment <b>#${created.id}</b> with <b>${esc(created.doctor_name)}</b> on <b>${esc(fmtDate(created.appt_date))}</b> at <b>${esc(created.slot_time)}</b>.\nYour confirmation is in <b>My Bookings</b>.`,
      { chips: [["View my bookings", "my bookings"], ["Book another", "book an appointment"], ["Reschedule", "shift my appointment"]], say: "All set. Your appointment is confirmed." }
    );
  } catch (err) {
    alex.step = "slot";
    await alexReply(`That slot just went — ${esc(err.message)} Let's pick another.`, { chips: [["Show slots again", "change slot"]] });
  }
}

async function alexStartEmergency(pre = {}) {
  const prev = alex.draft || {};
  alex.draft = {
    emergency: true,
    specialty: pre.specialty || prev.specialty || null,
    name: prev.name || null,
    phone: prev.phone || null,
  };
  alexChips([]);
  if (!alex.draft.name) {
    alex.step = "emgName";
    return alexReply("🚨 Emergency bookings skip the queue — I'll grab the earliest open slot. Who is the patient?", {
      say: "Emergency booking. Who is the patient?",
    });
  }
  if (!alex.draft.phone) {
    alex.step = "emgPhone";
    return alexReply("Got it — and a <b>phone number</b> so the hospital can reach you?");
  }
  alex.step = null;
  return alexEmergencyBook();
}

async function alexEmergencyBook() {
  const d = alex.draft;
  try {
    const created = await api("/api/appointments/emergency", {
      method: "POST",
      body: JSON.stringify({ patient_name: d.name, phone: d.phone, specialty: d.specialty || null, reason: d.reason || "Emergency booking via Alex" }),
    });
    alex.step = null;
    alex.draft = {};
    state.myPhone = created.phone;
    $("#phoneLookup").value = created.phone;
    toast(`⚡ Emergency slot assigned — #${created.id}`, "success");
    refreshAll();
    await alexReply(
      `⚡ <b>Booked and prioritised.</b>\n🩺 ${esc(created.doctor_name)} · ${esc(created.specialty)}\n📅 <b>${esc(fmtDate(created.appt_date))}</b> at <b>${esc(created.slot_time)}</b>\nBooking #${created.id}. If this is life-threatening, call 1800-100-200 now.`,
      { chips: [["View my booking", "my bookings"], ["Talk about symptoms", "what can you do"]], say: "Booked and prioritised. Please call the helpline if this is life threatening." }
    );
  } catch (err) {
    alex.step = null;
    await alexReply(`I couldn't find a free emergency slot: ${esc(err.message)}`, { chips: [["Book manually", "book an appointment"], ["Show doctors", "show doctors"]] });
  }
}

async function alexStepAnswer(text) {
  const d = alex.draft;
  const t = text.trim();
  if (/^(cancel|reset|stop|start over|restart)$/i.test(t)) {
    alex.step = null;
    alex.draft = {};
    return alexReply("No problem — I've cleared that. What would you like to do?", {
      chips: [["Book an appointment", "book an appointment"], ["Emergency ⚡", "emergency booking"], ["My bookings", "my bookings"]],
      say: "No problem. What would you like to do?",
    });
  }

  switch (alex.step) {
    case "name":
      if (t.length < 2) return alexReply("I need a name to book — what should I put down?");
      d.name = t;
      alex.step = "phone";
      return alexReply(`Thanks ${esc(d.name.split(" ")[0])}. What's the best <b>phone number</b> for updates?`);

    case "phone": {
      if ((t.match(/\d/g) || []).length < 7) return alexReply("That doesn't look like a phone number — could you share 7+ digits?");
      d.phone = t;
      if (d.emergency) return alexEmergencyBook();
      if (d.specialty) {
        if (d.date) return alexAskSlot();
        return alexAskDate();
      }
      return alexAskSpecialty();
    }

    case "specialty": {
      if (t === "emergency") { alex.draft.emergency = true; return alexStartEmergency({ specialty: null }); }
      const spec = matchSpecialty(t);
      if (!spec) {
        return alexReply(`I don't have a match for “${esc(t)}”. Pick a department:`, {
          chips: ALL_SPECIALTIES().slice(0, 8).map((s) => [s, s]),
        });
      }
      d.specialty = spec;
      if (d.date) return alexAskSlot();
      return alexAskDate();
    }

    case "date": {
      const date = parseDateText(t);
      if (!date) return alexReply("I couldn't read that date — try “today”, “tomorrow” or a YYYY-MM-DD.");
      d.date = date;
      return alexAskSlot();
    }

    case "slot": {
      if (t === "change slot") return alexAskSlot();
      const [time, id] = t.split("|");
      if (!time) return alexReply("Tap one of the slot buttons above so I don't book the wrong time.");
      d.slot = time;
      d.doctorId = Number(id);
      return alexConfirmDraft();
    }

    case "confirm":
      if (/confirm|yes|haan|ok|book/i.test(t)) return alexBook();
      if (/slot|change|another/i.test(t)) return alexAskSlot();
      return alexReply("Should I confirm the booking, pick another slot, or cancel?", {
        chips: [["✅ Confirm", "confirm"], ["✏️ Change slot", "change slot"], ["❌ Cancel", "reset"]],
      });

    case "emgName":
      if (t.length < 2) return alexReply("Who should I book the emergency appointment for?");
      d.name = t;
      alex.step = "emgPhone";
      return alexReply("And a <b>phone number</b> so the hospital can reach you?");

    case "emgPhone":
      if ((t.match(/\d/g) || []).length < 7) return alexReply("Please share a valid phone number (7+ digits).");
      d.phone = t;
      return alexEmergencyBook();

    case "lookupPhone":
      return alexLookup(t);

    default:
      alex.step = null;
      return alexHandle(t);
  }
}

async function alexLookup(phone) {
  alex.step = null;
  try {
    const rows = await api(`/api/appointments?phone=${encodeURIComponent(phone)}&sort=upcoming`);
    state.myPhone = phone;
    $("#phoneLookup").value = phone;
    if (!rows.length) {
      return alexReply(`I couldn't find any bookings for <b>${esc(phone)}</b>. Want to create one?`, {
        chips: [["Book an appointment", "book an appointment"], ["Emergency ⚡", "emergency booking"]],
      });
    }
    const lines = rows.slice(0, 4).map((a) =>
      `#${a.id} · ${esc(a.doctor_name)} · ${esc(fmtDate(a.appt_date))} ${esc(a.slot_time)} · ${esc(a.status)}`
    ).join("\n");
    await alexReply(`Here's what I found for <b>${esc(phone)}</b>:\n${lines}`, {
      chips: [["Open My Bookings", "open my bookings"], ["Reschedule one", "shift my appointment"]],
      say: `I found ${rows.length} booking${rows.length > 1 ? "s" : ""}. Opening them for you.`,
    });
    if ($("#view-my").classList.contains("active")) loadMyBookings();
  } catch (err) {
    alexReply(`Something went wrong: ${esc(err.message)}`);
  }
}

/* --- the trained brain ------------------------------------------------------ */
// Alex scores what the patient says against a learned corpus served by the API.
// Confident matches are posted back as feedback, so the phrases people actually
// use get reinforced (higher hits = higher rank) and new phrasings are learned.
let ALEX_MODEL = [];
async function loadAlexModel() {
  if (ALEX_MODEL.length) return ALEX_MODEL;
  try { ALEX_MODEL = await api("/api/alex/model"); } catch { ALEX_MODEL = []; }
  return ALEX_MODEL;
}
const normText = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const ALEX_STOP = new Set(
  "i me my the a an to please want need for is are of can you do does and in on at ka ki ke hai hun karna kar mera meri mujhe chahiye kya ho woh abhi now please"
    .split(" ")
);
const tokensOf = (s) => normText(s).split(" ").filter((t) => t.length > 1 && !ALEX_STOP.has(t));

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function alexClassify(text) {
  const n = normText(text);
  const toks = new Set(tokensOf(n));
  let best = { intent: null, score: 0, phrase: null };
  for (const ex of ALEX_MODEL) {
    const en = normText(ex.text);
    if (!en) continue;
    let score;
    if (en === n) score = 1;
    else {
      if (Math.abs(en.length - n.length) > 60) continue;
      const etSet = new Set(tokensOf(en));
      const inter = [...toks].filter((t) => etSet.has(t)).length;
      const uni = new Set([...toks, ...etSet]).size || 1;
      const jac = inter / uni;
      const lev = 1 - levenshtein(n, en) / Math.max(n.length, en.length, 1);
      score = Math.max(jac * 0.65 + lev * 0.35, lev >= 0.85 ? lev : 0);
    }
    score = Math.min(1, score * (1 + Math.min(ex.hits || 0, 25) * 0.008)); // learned phrases rank higher
    if (score > best.score) best = { intent: ex.intent, score, phrase: ex.text };
  }
  return best;
}

function alexTrain(text, intent) {
  const n = normText(text);
  if (!n || !intent) return;
  if (!ALEX_MODEL.some((e) => e.text === n)) ALEX_MODEL.push({ text: n, intent, hits: 1 });
  api("/api/alex/feedback", { method: "POST", body: JSON.stringify({ text: n, intent }) }).catch(() => {});
}

// Rule fallback when nothing in the corpus scores confidently
function alexKeywordIntent(msg) {
  const t = normText(msg);
  const has = (...w) => w.some((x) => t.includes(x));
  if (/^(hi|hello|hey|namaste|namaskar)\b/.test(t) || has("good morning", "good evening")) return "greet";
  if (has("thank", "shukriya", "dhanyavaad")) return "thanks";
  if (/^(bye|goodbye|see you|alvida)\b/.test(t)) return "bye";
  if (has("emergency", "urgent", "asap", "jaldi", "turant")) return "emergency";
  if (has("resched", "shift my", "change my", "move my", "postpone", "slot badal")) return "shift_help";
  if (has("refund", "money back", "paisa wapas")) return "policy_refund";
  if (has("my booking", "meri booking", "show my", "check my", "appointment status", "look up")) return "my_bookings";
  if (has("cheapest", "sasta", "lowest fee")) return "cheapest";
  if (has("fee", "cost", "charge", "price", "kitna", "rate")) return "fees";
  if (has("timing", "timings", "office time", "open", "hours", "closing")) return "timings";
  if (has("address", "location", "where are", "kahan", "direction", "metro")) return "location";
  if (has("insurance", "cashless", "claim")) return "insurance";
  if (has("report", "lab result", "test result")) return "reports";
  if (has("prescription", "medicine list", "rx")) return "prescription";
  if (has("payment", "pay by", "card se", "upi", "checkout", "billing")) return "payment_help";
  if (has("cancellation policy", "policy", "rules", "terms")) return "policy_cancel";
  if (has("helpline", "ambulance", "contact number", "1800")) return "helpline";
  if (has("earliest", "first free", "next free", "pehla slot")) return "earliest";
  if (has("doctor", "specialist", "department", "specialty")) return "doctors_list";
  if (has("book", "appointment", "slot", "consultation", "visit")) return "book";
  if (has("help", "kya kar", "how to", "what can")) return "help";
  return null;
}

const alexDocs = () => (state.allDoctors?.length ? state.allDoctors : state.doctors || []);
const ALEX_SHORTCUTS = [
  ["Book an appointment", "book an appointment"],
  ["Emergency ⚡", "emergency booking"],
  ["My bookings", "my bookings"],
];

// Each handler returns {text, chips, say} — or undefined when a flow already replied.
async function alexAnswer(intent, msg) {
  const docs = alexDocs();
  switch (intent) {
    case "greet":
      return { text: "Hello! 👋 I'm Alex — I can book a visit, find fees or timings, check your bookings, or grab an emergency slot. What do you need?",
        chips: ALEX_SHORTCUTS, say: "Hello. What do you need?" };
    case "help":
      return { text: "I can:\n• 🩺 <b>Book</b> an appointment step by step\n• 🚨 <b>Auto-assign</b> the earliest emergency slot\n• 📋 <b>Look up</b> your bookings\n• 🔁 <b>Reschedule</b> or cancel\n• 💰 <b>Fees, timings, reports</b> and payment help",
        chips: ALEX_SHORTCUTS.concat([["What are the fees?", "what is the consultation fee"]]), say: "I can book, reschedule, look up bookings and answer fee and timing questions." };
    case "thanks":
      return { text: "Anytime! 😊 Anything else I can line up for you?", chips: ALEX_SHORTCUTS };
    case "bye":
      return { text: "Take care! 🌿 I'm here 24×7 if you need another slot.", chips: [["Book an appointment", "book an appointment"]] };
    case "book": case "book_prefill": {
      const spec = matchSpecialty(msg);
      const date = parseDateText(msg);
      const slot = parseTimeText(msg);
      if (spec || date) {
        alex.draft = { specialty: spec, date, slot: slot || null, reason: null };
        alex.step = "name";
        const bits = [spec ? esc(spec) : null, date ? esc(fmtDate(date)) : null, slot ? `at ${esc(slot)}` : null].filter(Boolean).join(" · ");
        return { text: `Great — ${bits}. What's the <b>patient's full name</b>?`, say: "Great. What is the patient's name?" };
      }
      await alexStartBooking();
      return undefined;
    }
    case "emergency":
      await alexStartEmergency({ specialty: matchSpecialty(msg) });
      return undefined;
    case "my_bookings":
      if (state.myPhone) { await alexLookup(state.myPhone); return undefined; }
      if (state.user) { await alexLookup(state.user.phone || state.myPhone); return undefined; }
      alex.step = "lookupPhone";
      return { text: "Sure — what's the <b>phone number</b> on the booking?", say: "What is the phone number?" };
    case "shift_help":
      return { text: "You can move any confirmed booking two ways:\n• <b>My Bookings → ✎ Edit</b> for a normal change\n• <b>🚨 Emergency shift</b> to jump to the next free slot — or swap with another patient",
        chips: [["Open My Bookings", "open my bookings"], ["Book fresh instead", "book an appointment"]], say: "Open My Bookings and use emergency shift to move it." };
    case "cancel_help":
      return { text: "To cancel: open <b>My Bookings</b> → the booking → <b>Cancel</b>. It frees the slot instantly, and prepaid bookings are refunded per the refund policy.",
        chips: [["Open My Bookings", "open my bookings"], ["Refund policy", "refund if i cancel"]] };
    case "doctors_list":
      return { text: `We have <b>${docs.length} specialists</b> across ${ALL_SPECIALTIES().length} departments.\n${ALL_SPECIALTIES().map((s) => `• ${esc(s)}`).join("\n")}`,
        chips: ALL_SPECIALTIES().slice(0, 6).map((s) => [s, `book ${s}`]), say: "We have specialists across several departments. Which one do you need?" };
    case "fees": {
      if (!docs.length) return { text: "I'm pulling up the fee list — one moment." };
      const fees = docs.map((d) => d.fee);
      return { text: `Consultation fees run <b>₹${Math.min(...fees)}–₹${Math.max(...fees)}</b>.\n${docs.slice(0, 6).map((d) => `• ${esc(d.name)} — ${esc(d.specialty)} · ₹${d.fee}`).join("\n")}\nPay online at checkout or at reception.`,
        chips: [["Book an appointment", "book an appointment"], ["Payment options", "how do i pay"]] };
    }
    case "cheapest": {
      if (!docs.length) return { text: "Let me check the fee list." };
      const cheap = [...docs].sort((a, b) => a.fee - b.fee)[0];
      return { text: `The lowest consultation fee is <b>₹${cheap.fee}</b> with <b>${esc(cheap.name)}</b> (${esc(cheap.specialty)}, ★ ${cheap.rating}).`,
        chips: [[`Book ${cheap.specialty}`, `book ${cheap.specialty}`], ["Compare all fees", "what is the consultation fee"]] };
    }
    case "earliest": {
      for (let off = 0; off < 7; off++) {
        const date = isoOf(off);
        const opts = await alexSlotOptionsFor(date, matchSpecialty(msg));
        if (opts.length) {
          const o = opts[0];
          alex.draft = { specialty: o.doctor.specialty, date, slot: o.time, doctorId: o.doctor.id, reason: null };
          alex.step = "name";
          return { text: `Earliest opening: <b>${esc(fmtDate(date))} at ${esc(o.time)}</b> with <b>${esc(o.doctor.name)}</b> (₹${o.doctor.fee}).\nI can hold it — what's the <b>patient's full name</b>?`,
            say: `Earliest slot is ${fmtDate(date)} at ${o.time}. What is the patient name?`, chips: [] };
        }
      }
      return { text: "No free slots in the next 7 days. Try an emergency booking or call 1800-100-200.",
        chips: [["Emergency ⚡", "emergency booking"]] };
    }
    case "timings":
      return { text: "🕒 <b>OPD hours</b>: 09:00–17:30, break 13:00–14:00, Mon–Sat.\nDr. Kenji Tanaka also sees patients on <b>Sunday</b>.\n🚨 <b>Emergency: 24×7</b> — call 1800-100-200.",
        chips: [["Earliest available slot", "earliest available slot"], ["Where are you?", "where is the hospital"]] };
    case "location":
      return { text: "📍 <b>MediCare Hospital</b>, 12 Wellness Avenue.\nHelpline <b>1800-100-200</b> · Ambulance <b>108</b>.\nParking in the basement; nearest metro is a 5-minute walk.",
        chips: [["Book an appointment", "book an appointment"], ["Emergency number", "what is the emergency number"]] };
    case "helpline":
      return { text: "📞 Helpline <b>1800-100-200</b> (24×7) · Ambulance <b>108</b>.\nIf it's life-threatening, call first and come in — we'll prepare the slot.",
        chips: [["Emergency booking ⚡", "emergency booking"]] };
    case "policy_cancel":
      return { text: "📋 <b>Cancellation policy</b>:\n• Free cancellation up to <b>2 hours</b> before the slot\n• No-show twice blocks online booking for 7 days\n• Reschedules are always free via <b>Emergency shift</b>",
        chips: [["Refund policy", "refund if i cancel"], ["Open My Bookings", "open my bookings"]] };
    case "policy_refund":
      return { text: "↩️ <b>Refunds</b>:\n• Paid online → refunded to the same card in <b>5–7 working days</b>\n• Cancel <b>≥24h</b> before the visit → full refund\n• Inside 2 hours → no refund, but you can shift the slot instead",
        chips: [["Shift my appointment", "shift my appointment"], ["Payment options", "how do i pay"]] };
    case "insurance":
      return { text: "🏥 <b>Cashless claims</b> are supported with most major insurers — bring your card and ID and our desk files the pre-authorization. For planned procedures, carry the policy number and a recent prescription.",
        chips: [["What are the fees?", "what is the consultation fee"]] };
    case "reports":
      return { text: "🧪 Lab reports are emailed within <b>24–48 hours</b> and available at reception from the next working day. Bring your booking ID when collecting hard copies.",
        chips: [["My bookings", "my bookings"]] };
    case "prescription":
      return { text: "💊 Your doctor e-prescribes at the end of the visit — a copy is emailed to you and printed at reception. I can't issue prescriptions myself; that needs a consultation.",
        chips: [["Book an appointment", "book an appointment"]] };
    case "payment_help":
      return { text: "💳 After booking, a <b>secure checkout</b> opens automatically — pay by card (Visa, Mastercard, RuPay, Amex). You can also choose <b>Pay later</b> and settle at reception.\nRefunds follow the refund policy.",
        chips: [["Refund policy", "refund if i cancel"], ["Book an appointment", "book an appointment"]], say: "Pay by card at checkout after booking, or at reception." };
    default:
      return null;
  }
}

async function alexHandle(text, alreadyEchoed = false) {
  const msg = (text || "").trim();
  if (!msg) return;
  if (!alreadyEchoed) alexAdd(esc(msg), "user");

  if (alex.step) return alexStepAnswer(msg);
  await loadAlexModel();

  const bare = normText(msg);
  if (["reset", "start over", "restart", "clear"].includes(bare)) {
    return alexReply("Cleared. What would you like to do?", { chips: ALEX_SHORTCUTS });
  }

  const guess = alexClassify(msg);
  const intent = guess.score >= 0.5 ? guess.intent : alexKeywordIntent(msg);
  if (intent && guess.score >= 0.5) alexTrain(msg, intent);

  if (intent) {
    const reply = await alexAnswer(intent, msg);
    if (reply === undefined) return;          // a flow already replied
    if (reply) return alexReply(reply.text, { chips: reply.chips || [], say: reply.say });
  }

  return alexReply(
    "I can help with bookings, emergencies, fees, timings and payments. Try “book a cardiologist tomorrow” or tap a shortcut:",
    { chips: ALEX_SHORTCUTS.concat([["What are the fees?", "what is the consultation fee"]]) }
  );
}

/* ============================ MOTION / MICRO-INTERACTIONS ==================== */
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let revealQueued = false;

let revealObserver = null;

function revealInView() {
  if (reduceMotion) {
    $$("[data-reveal]").forEach((el) => el.classList.add("in"));
    return;
  }
  if ("IntersectionObserver" in window) {
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("in");
              revealObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.08, rootMargin: "0px 0px -30px 0px" }
      );
    }
    $$("[data-reveal]:not(.in)").forEach((el) => revealObserver.observe(el));
  } else {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    $$("[data-reveal]:not(.in)").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height === 0) return;
      if (r.top < vh * 0.94 && r.bottom > 0) el.classList.add("in");
    });
  }
}

function scheduleReveal() {
  if (reduceMotion || revealQueued) return;
  revealQueued = true;
  requestAnimationFrame(() => { revealQueued = false; revealInView(); });
}

function scanReveals() {
  if (reduceMotion) return;
  document.documentElement.classList.add("fx");
  $$(".section-title, .feature-card, .dept-card, .page-head, .slot-panel, .hero-copy, .hero-art, .appt-card, .doctor-card, .emg-card, .pm-card")
    .forEach((el) => {
      if (el.dataset.revealReady) return;
      el.dataset.revealReady = "1";
      el.dataset.reveal = "";
      const sibs = el.parentElement ? Array.from(el.parentElement.children) : [];
      el.style.setProperty("--i", String(Math.min(Math.max(sibs.indexOf(el), 0), 5)));
    });
  revealInView();
}

function initTilt() {
  if (reduceMotion || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  const selector = ".feature-card, .dept-card, .testi-card, .home-doc-card, .bento-card, .doctor-card, .sandbox-card, .stat-box";
  $$(selector).forEach((card) => {
    if (card.dataset.tiltReady) return;
    card.dataset.tiltReady = "1";
    card.classList.add("tilt");
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      card.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
      card.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);

      // Amplified 3D perspective pitch and yaw with dynamic Z-elevation
      const maxTilt = card.classList.contains("bento-card") ? 11 : 14;
      const rx = ((0.5 - py) * maxTilt).toFixed(2);
      const ry = ((px - 0.5) * maxTilt).toFixed(2);
      card.style.transform = `perspective(1100px) rotateX(${rx}deg) rotateY(${ry}deg) translate3d(0, -6px, 24px)`;
    });
    card.addEventListener("pointerleave", () => {
      card.style.transform = "";
      card.style.removeProperty("--mx");
      card.style.removeProperty("--my");
    });
  });
}

function animateCount(el, to) {
  if (!el) return;
  const target = Number(to);
  if (!Number.isFinite(target)) { el.textContent = String(to); return; }
  const from = Number(String(el.textContent).replace(/[^\d.]/g, "")) || 0;
  if (reduceMotion || from === target) { el.textContent = target.toLocaleString("en-IN"); return; }
  el.classList.add("counting");
  const dur = 900;
  const t0 = performance.now();
  const done = () => { el.textContent = target.toLocaleString("en-IN"); el.classList.remove("counting"); };
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (target - from) * eased).toLocaleString("en-IN");
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(done, dur + 200);   // guarantees the final number even if frames are throttled
}

function initHeroParallax() {
  const hero = document.querySelector(".hero");
  const art = document.querySelector(".hero-art");
  const deck = document.querySelector("#heroDeckMockup");
  if (!hero || !art || reduceMotion || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  const floaters = $$(".parallax-card, .parallax-elem", hero).map((el) => ({
    el,
    speed: Number(el.dataset.speed || 0.1),
    isCard1: el.classList.contains("hero-card-1"),
    isCard2: el.classList.contains("hero-card-2")
  }));

  hero.addEventListener("pointermove", (e) => {
    const r = hero.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;

    // 3D camera pan & multi-axis pitch on hero art stage
    art.style.transform = `perspective(1400px) rotateY(${(x * 16).toFixed(2)}deg) rotateX(${(-y * 14).toFixed(2)}deg)`;

    // Independent 3D roll and depth pop on terminal deck mockup
    if (deck) {
      const deckRotY = (-7 + x * 18).toFixed(2);
      const deckRotX = (5 - y * 16).toFixed(2);
      const deckZ = (24 + Math.abs(x) * 20).toFixed(1);
      deck.style.transform = `perspective(1200px) rotateY(${deckRotY}deg) rotateX(${deckRotX}deg) translateZ(${deckZ}px)`;
    }

    // 3D diverging flight on satellite cards and elements
    floaters.forEach(({ el, speed, isCard1, isCard2 }) => {
      const dx = (x * speed * 320).toFixed(1);
      const dy = (y * speed * 220).toFixed(1);
      const zBase = isCard1 ? 55 : (isCard2 ? 65 : -30);
      const dz = (zBase + (speed > 0 ? 1 : -1) * (x * 40)).toFixed(1);
      const rotY = (x * 22).toFixed(1);
      const rotX = (-y * 18).toFixed(1);
      el.style.transform = `translate3d(${dx}px, ${dy}px, ${dz}px) rotateY(${rotY}deg) rotateX(${rotX}deg)`;
    });
  }, { passive: true });

  hero.addEventListener("pointerleave", () => {
    art.style.transform = "";
    if (deck) deck.style.transform = "";
    floaters.forEach(({ el }) => { el.style.transform = ""; });
  });
}

function animateNumber(el, target, decimals = 0) {
  const done = () => {
    el.textContent = decimals ? target.toFixed(decimals) : Math.round(target).toLocaleString("en-IN");
  };
  if (reduceMotion) { done(); return; }
  const dur = 1500;
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = target * eased;
    el.textContent = decimals ? v.toFixed(decimals) : Math.round(v).toLocaleString("en-IN");
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(done, dur + 250);   // guarantees the final number if frames are throttled
}

function initCounters() {
  const els = $$(".counter-num");
  if (!els.length) return;
  const run = (el) => {
    if (el.dataset.counted) return;
    el.dataset.counted = "1";
    animateNumber(el, Number(el.dataset.target || 0), Number(el.dataset.decimals || 0));
  };
  if ("IntersectionObserver" in window) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          run(entry.target);
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    els.forEach((el) => {
      if (!el.dataset.counted) obs.observe(el);
    });
  } else {
    const check = () => {
      const vh = window.innerHeight;
      els.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top < vh * 0.92 && r.bottom > 0) run(el);
      });
    };
    window.addEventListener("scroll", check, { passive: true });
    check();
  }
}

function initTimeline() {
  const section = document.querySelector(".timeline-section");
  const fill = $("#timelineProgress");
  if (!section || !fill) return;
  const items = $$(".timeline-item");
  const update = () => {
    const r = section.getBoundingClientRect();
    const span = r.height * 0.78 || 1;
    const pct = Math.min(1, Math.max(0, ((window.innerHeight * 0.75) - r.top) / span));
    fill.style.height = `${(pct * 100).toFixed(1)}%`;

    // Highlight active timeline items as scroll passes them
    items.forEach((item) => {
      const ir = item.getBoundingClientRect();
      item.classList.toggle("active", ir.top < window.innerHeight * 0.75);
    });
  };
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}

function initFaq() {
  $$(".faq-question").forEach((btn) => {
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", () => {
      const item = btn.closest(".faq-item");
      const willOpen = !item.classList.contains("open");
      $$(".faq-item.open").forEach((o) => {
        o.classList.remove("open");
        o.querySelector(".faq-question")?.setAttribute("aria-expanded", "false");
      });
      item.classList.toggle("open", willOpen);
      btn.setAttribute("aria-expanded", String(willOpen));
    });
  });
}

function initScrollProgress() {
  const bar = $("#scrollProgress");
  const ring = $("#progressRingBar");
  const topBtn = $("#backToTopBtn");
  const nav = $(".navbar");
  const scrollBtn = $("#heroScrollBtn");
  const heroDeck = $("#heroDeckMockup");

  if (scrollBtn) {
    scrollBtn.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelector("#stats-section")?.scrollIntoView({ behavior: "smooth" });
    });
  }

  if (topBtn) {
    topBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  const update = () => {
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? Math.min(100, Math.max(0, (scrollY / max) * 100)) : 0;

    if (bar) bar.style.width = `${pct}%`;

    // Circular progress ring on back to top button
    if (ring) {
      const circ = 119.38;
      const offset = circ - (circ * pct) / 100;
      ring.style.strokeDashoffset = String(offset);
    }

    // Toggle Back to Top button
    if (topBtn) {
      topBtn.classList.toggle("visible", scrollY > 280);
    }

    // Navbar scrolled morphing state
    if (nav) {
      nav.classList.toggle("is-scrolled", scrollY > 20);
    }

    // High-level 3D perspective pitch and multi-axis roll on hero deck terminal on scroll
    if (heroDeck && !reduceMotion && scrollY < 1000) {
      const pitch = Math.min(24, scrollY * 0.038).toFixed(2);
      const yaw = (-7 + Math.sin(scrollY * 0.003) * 4).toFixed(2);
      const roll = (Math.cos(scrollY * 0.004) * 2).toFixed(2);
      const moveY = (scrollY * 0.12).toFixed(1);
      const depthZ = (-scrollY * 0.18).toFixed(1);
      const scale = Math.max(0.88, 1 - scrollY * 0.00018).toFixed(3);
      heroDeck.style.transform = `perspective(1200px) rotateX(${pitch}deg) rotateY(${yaw}deg) rotateZ(${roll}deg) translate3d(0, ${moveY}px, ${depthZ}px) scale(${scale})`;
    }

    // 3D Diverging multi-axis flight on satellite cards and ambient orbs on scroll
    if (!reduceMotion && scrollY < 1000) {
      const c1 = $(".hero-card-1");
      const c2 = $(".hero-card-2");
      if (c1) {
        c1.style.transform = `translate3d(${(-scrollY * 0.12).toFixed(1)}px, ${(scrollY * 0.18).toFixed(1)}px, 55px) rotateY(${(-8 - scrollY * 0.02).toFixed(2)}deg) rotateX(${(4 + scrollY * 0.015).toFixed(2)}deg)`;
      }
      if (c2) {
        c2.style.transform = `translate3d(${(scrollY * 0.14).toFixed(1)}px, ${(scrollY * 0.25).toFixed(1)}px, 65px) rotateY(${(8 + scrollY * 0.025).toFixed(2)}deg) rotateX(${(-5 - scrollY * 0.02).toFixed(2)}deg)`;
      }
      const orb1 = $(".orb-1");
      const orb2 = $(".orb-2");
      if (orb1) orb1.style.transform = `translate3d(0, ${(-scrollY * 0.14).toFixed(1)}px, 0)`;
      if (orb2) orb2.style.transform = `translate3d(0, ${(scrollY * 0.12).toFixed(1)}px, 0)`;
    }
  };

  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}

function initCursorSpotlight() {
  if (reduceMotion || !window.matchMedia("(pointer: fine)").matches) return;
  const spotlight = $("#cursorSpotlight");
  if (!spotlight) return;
  window.addEventListener("pointermove", (e) => {
    document.documentElement.style.setProperty("--spot-x", `${e.clientX}px`);
    document.documentElement.style.setProperty("--spot-y", `${e.clientY}px`);
  }, { passive: true });
}

function initWordScrub() {
  const section = $("#kineticStatement");
  const words = $$(".scrub-word");
  if (!section || !words.length) return;

  const update = () => {
    const r = section.getBoundingClientRect();
    const vh = window.innerHeight;
    const startY = vh * 0.90;
    const endY = vh * 0.38;
    const progress = Math.min(1, Math.max(0, (startY - r.top) / (startY - endY)));

    const rawLit = progress * words.length;
    const litCount = Math.floor(rawLit);
    words.forEach((w, idx) => {
      const isLit = idx <= litCount;
      w.classList.toggle("lit", isLit);
      if (idx === litCount && !reduceMotion) {
        const frac = rawLit - litCount;
        const rx = ((1 - frac) * 24).toFixed(1);
        const tz = (frac * 14).toFixed(1);
        w.style.transform = `perspective(900px) translate3d(0, 0, ${tz}px) rotateX(${rx}deg)`;
      } else {
        w.style.transform = "";
      }
    });
  };

  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}

function initStackingCards() {
  const cards = $$(".stack-card");
  if (cards.length < 2) return;

  const update = () => {
    cards.forEach((card, idx) => {
      if (idx === cards.length - 1) return;
      const nextCard = cards[idx + 1];
      if (!nextCard) return;
      const nr = nextCard.getBoundingClientRect();
      const stickyAnchor = 82 + (idx + 1) * 24;
      const overlap = stickyAnchor + 54 - nr.top;

      if (overlap > 0) {
        const thirdCard = cards[idx + 2];
        let isDeep = false;
        if (thirdCard) {
          const tr = thirdCard.getBoundingClientRect();
          const thirdAnchor = 82 + (idx + 2) * 24;
          if (thirdAnchor + 54 - tr.top > 0) isDeep = true;
        }
        card.classList.toggle("is-deep-dimmed", isDeep);
        card.classList.toggle("is-dimmed", !isDeep);
      } else {
        card.classList.remove("is-dimmed", "is-deep-dimmed");
      }
    });
  };

  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}

function initSandbox() {
  const chips = $$(".sandbox-chip");
  const docInfo = $("#sandboxDocPreview");
  const slotGrid = $("#sandboxSlotGrid");
  const alexBtn = $("#openAlexFromStack");
  const bentoAlexBtn = $("#openAlexFromBento");

  const openAlexModal = () => {
    openAlex();
  };

  if (alexBtn && !alexBtn.dataset.bound) {
    alexBtn.dataset.bound = "1";
    alexBtn.addEventListener("click", openAlexModal);
  }
  if (bentoAlexBtn && !bentoAlexBtn.dataset.bound) {
    bentoAlexBtn.dataset.bound = "1";
    bentoAlexBtn.addEventListener("click", openAlexModal);
  }

  if (!chips.length || !docInfo || !slotGrid) return;

  const renderSandbox = async (spec) => {
    const doc = (state.allDoctors.length ? state.allDoctors : state.doctors)?.find((d) => d.specialty === spec) || state.doctors?.[0];
    if (!doc) return;

    docInfo.innerHTML = `
      <div style="display:flex; gap:0.9rem; align-items:center;">
        <div class="avatar" style="width:48px; height:48px; border-radius:12px; background:#0d9488; font-weight:700;">${initials(doc.name)}</div>
        <div>
          <strong style="font-size:1.02rem; color:var(--navy); display:block;">${esc(doc.name)}</strong>
          <span style="font-size:0.82rem; color:var(--teal-700); font-weight:600;">${esc(doc.specialty)}</span>
        </div>
      </div>
      <div style="font-size:0.82rem; color:var(--muted); line-height:1.55; margin-top:0.4rem;">
        ${esc(doc.bio || 'Senior Department Specialist with over ' + (doc.experience || 8) + ' years of clinical excellence.')}
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:auto; padding-top:0.8rem; border-top:1px solid var(--line);">
        <span style="font-weight:700; color:var(--navy);">Fee: ₹${doc.fee}</span>
        <span class="chip chip-ok">★ ${doc.rating || 4.9}</span>
      </div>
    `;

    slotGrid.innerHTML = `<span class="muted" style="font-size:0.82rem">Loading live slots…</span>`;
    try {
      const tomorrow = isoOf(1);
      const data = await api(`/api/slots?doctorId=${doc.id}&date=${tomorrow}`);
      const freeSlots = data.working ? data.slots.filter((s) => s.available).slice(0, 6) : [];
      if (!freeSlots.length) {
        slotGrid.innerHTML = `<span class="muted" style="font-size:0.82rem">${esc(doc.name)} is off tomorrow — click to view other dates.</span>`;
        return;
      }
      slotGrid.innerHTML = freeSlots.map((s) => `
        <button type="button" class="sandbox-slot-btn" data-sandbox-time="${esc(s.time)}" data-sandbox-date="${esc(tomorrow)}">
          <span>${esc(s.time)}</span>
        </button>
      `).join("");
    } catch {
      const fallback = ["09:00", "10:00", "11:30", "14:00", "15:30", "17:00"];
      slotGrid.innerHTML = fallback.map((time) => `
        <button type="button" class="sandbox-slot-btn" data-sandbox-time="${time}" data-sandbox-date="${isoOf(1)}">
          <span>${time}</span>
        </button>
      `).join("");
    }
  };

  chips.forEach((chip) => {
    if (chip.dataset.bound) return;
    chip.dataset.bound = "1";
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderSandbox(chip.dataset.spec);
    });
  });

  if (!slotGrid.dataset.bound) {
    slotGrid.dataset.bound = "1";
    slotGrid.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sandbox-time]");
      if (!btn) return;
      const activeChip = $(".sandbox-chip.active");
      const spec = activeChip?.dataset.spec || "Cardiology";
      const doc = state.doctors?.find((d) => d.specialty === spec) || state.doctors?.[0];
      if (doc) {
        navigate("book");
        setTimeout(() => {
          document.querySelector(`#doctorGrid [data-doctor="${doc.id}"]`)?.click();
        }, 90);
      }
    });
  }

  // Initial render when doctors are ready
  if (state.doctors?.length) {
    renderSandbox("Cardiology");
  }
}

(async function init() {
  initScrollProgress();
  initCursorSpotlight();
  initWordScrub();
  initStackingCards();
  initTimeline();
  initCounters();
  await Promise.all([refreshUser(), loadDoctors(true), refreshStats()]);
  populateSpecialtyFilter();
  await loadHome(true);
  if (state.user?.role === "admin") loadDoctorMgmt();
  if (state.user) {
    if (!$("#pName").value) $("#pName").value = state.user.name || "";
    if (!$("#pPhone").value && state.user.phone) $("#pPhone").value = state.user.phone;
    if ($("#pEmail") && !$("#pEmail").value && state.user.email) $("#pEmail").value = state.user.email;
    if (state.user.phone && !$("#phoneLookup").value) $("#phoneLookup").value = state.user.phone;
  }
  populateEmgSpecialties();
  initSandbox();
  $("#apptDate").value = isoOf(1);
  $("#apptDate").min = isoOf(0);
  renderQuickDates();
  scanReveals();
  initTilt();
  initHeroParallax();
  initFaq();
  window.addEventListener("scroll", scheduleReveal, { passive: true });
  window.addEventListener("resize", scheduleReveal);
})();
