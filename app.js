"use strict";

const API_URL = "https://script.google.com/macros/s/AKfycbxm7aWFLVk0XeTLV39LnaiTI5Z8c76YNlcPMYWyR17HGaU4QvzHJm32nWeCHsnaknVx/exec";
const APP_VERSION = "MSOT1.0";
const STORAGE_KEY = "morgan-ops-hub-v2";
const SYNC_META_KEY = `${STORAGE_KEY}-sync-meta`;
const LOCAL_BACKUP_PREFIX = `${STORAGE_KEY}-backup`;
const MAX_LOCAL_BACKUPS = 12;

const COURSE_CATALOG = {
  A60: { name: "A課程 60分", duration: 60, price: 1800, therapistCut: 1000 },
  C120: { name: "C課程 120分", duration: 120, price: 2800, therapistCut: 1600 },
  C90: { name: "C課程 90分", duration: 90, price: 2500, therapistCut: 1400 },
  D120: { name: "D課程 120分", duration: 120, price: 2400, therapistCut: 1400 },
  D90: { name: "D課程 90分", duration: 90, price: 2100, therapistCut: 1200 },
  OUT_DAY: { name: "外出 (22:00前)", duration: 120, price: 3200, therapistCut: 2000 },
  OUT_NIGHT: { name: "外出 (22:00後)", duration: 120, price: 3500, therapistCut: 2200 }
};

const ADMIN_NAV_ITEMS = [
  { tab: "overview", label: "總覽", title: "總覽", icon: "layout-dashboard" },
  { tab: "dispatch", label: "預約", title: "預約系統", icon: "calendar-days" },
  { tab: "customer", label: "顧客", title: "顧客", icon: "users" },
  { tab: "personnel", label: "人事", title: "人事", icon: "user-cog" },
  { tab: "report", label: "財務", title: "財務", icon: "circle-dollar-sign" },
  { tab: "system", label: "系統", title: "系統", icon: "settings" }
];

const THERAPIST_NAV_ITEMS = [
  { tab: "portal", label: "我的預約與班表", title: "個人中樞", icon: "calendar-check-2" }
];

let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let monthDates = [];
let monthWeeks = [];
let currentUser = null;
let activeTab = "overview";
let activeAppointmentView = "card";
let activeDispatchPanel = "query";
let dispatchQueryState = { date: "", time: "", service: "C120" };
let pendingDispatchFocus = "";
let appointmentRecordScope = "today";
let activePersonnelPanel = "schedule";
let activeReportPanel = "revenue";
let activeSystemPanel = "status";
let customerSortState = { key: "code", direction: "asc" };
let scheduleFilterStart = "";
let scheduleFilterEnd = "";
let reportFilterStart = "";
let reportFilterEnd = "";
let currentScheduleViewDates = [];
let editingAppointmentId = null;
let activeAppointmentId = null;
let pendingClientSelectionId = null;
let liveTimer = null;
let pendingBackupReason = "";
let suppressPersistBackup = false;

const $ = (id) => document.getElementById(id);
const esc = (value = "") => String(value).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const iconHtml = (name, className = "") => `<i data-lucide="${esc(name)}"${className ? ` class="${esc(className)}"` : ""}></i>`;
const refreshIcons = () => {
  if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { "aria-hidden": "true", "stroke-width": 2 } });
};
const todayKey = () => toDateKey(new Date());
const money = (n) => `$${(Number(n) || 0).toLocaleString()}`;
const courseName = (code) => COURSE_CATALOG[code]?.name || code || "自訂服務";
const therapistName = (id) => db.therapists[id]?.nickname || db.therapists[id]?.name || "未知";
const therapistWritePayload = (id, therapist = {}) => {
  const displayName = String(therapist.nickname || therapist.name || id || "").trim();
  return {
    ...therapist,
    id,
    nickname: displayName,
    name: displayName,
    pin: sheetText(therapist.pin || "")
  };
};
const isSystemCustomerKey = (key = "") => String(key).startsWith("SYS_");
const cleanPin = (value = "") => String(value ?? "").replace(/^'/, "").trim();
const sheetText = (value = "") => {
  const text = cleanPin(value);
  return /^0\d+/.test(text) ? `'${text}` : text;
};
const pinMatches = (stored, entered) => {
  const storedText = cleanPin(stored);
  const enteredText = cleanPin(entered);
  if (storedText === enteredText) return true;
  if (/^\d+$/.test(storedText) && /^\d+$/.test(enteredText)) {
    return storedText.replace(/^0+/, "") === enteredText.replace(/^0+/, "");
  }
  return false;
};
const timeToMinutes = (value = "00:00") => {
  const [h = 0, m = 0] = String(value).split(":").map(Number);
  return h * 60 + m;
};
const minsToTime = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

function normalizeDateField(value = "") {
  if (!value) return "";
  const text = String(value).trim();
  const direct = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (direct) return `${direct[1]}-${String(direct[2]).padStart(2, "0")}-${String(direct[3]).padStart(2, "0")}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : toDateKey(parsed);
}

function normalizeTimeField(value = "") {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && value >= 0 && value < 1) {
    return minsToTime(Math.round(value * 24 * 60));
  }
  const text = String(value).trim();
  const match = text.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
  if (match) return `${String(match[1]).padStart(2, "0")}:${match[2]}`;
  return text;
}

const THERAPIST_PROFILE_DEFAULTS = {
  nickname: "",
  name: "",
  contact: "",
  height: "",
  weight: "",
  age: "",
  specialties: "",
  notes: "",
  bio: "",
  photoUrl: ""
};

const therapistProfileKey = (id) => `SYS_THERAPIST_PROFILE_${id}`;
const APPROVAL_PREFIX = "SYS_APPROVAL_";
const CLIENT_SELECTION_PREFIX = "SYS_CLIENT_SELECTION_";
const APPOINTMENT_META_PREFIX = "SYS_APPT_META_";
const ADMIN_LOGIN_LOG_KEY = "SYS_ADMIN_LOGIN_LOG";
const FRONTDESK_LOGIN_LOG_KEY = "SYS_FRONTDESK_LOGIN_LOG";
const SYSTEM_NOTE_KEY = "SYS_SYSTEM_NOTE";
const CLOUD_SYNC_META_KEY = "SYS_SYNC_META";
const SYSTEM_NOTE_LOCAL_KEY = `${STORAGE_KEY}-system-note`;
const approvalKey = (id) => `${APPROVAL_PREFIX}${id}`;
const clientSelectionKey = (id) => `${CLIENT_SELECTION_PREFIX}${id}`;
const appointmentMetaKey = (id) => `${APPOINTMENT_META_PREFIX}${id}`;
const approvalTypeLabel = (type) => ({ profile: "人事資料", schedule: "班表", password: "密碼" }[type] || type);
const approvalStatusLabel = (status) => ({ pending: "待審核", approved: "已核可", rejected: "已退回" }[status] || status);
const BOOKING_STAGES = [
  { key: "inquiry", label: "詢問中" },
  { key: "candidate_sent", label: "已給客選" },
  { key: "therapist_match", label: "師傅媒合中" },
  { key: "customer_confirm", label: "待顧客確認" },
  { key: "confirmed", label: "已確認預約" },
  { key: "pre_notice", label: "行前通知完成" },
  { key: "completed", label: "服務完成" }
];
const bookingStageLabel = (stage) => BOOKING_STAGES.find((item) => item.key === stage)?.label || "已確認預約";
const bookingStageClass = (stage) => ({
  inquiry: "bg-slate-100 text-slate-600",
  candidate_sent: "bg-cyan-50 text-cyan-700",
  therapist_match: "bg-indigo-50 text-indigo-700",
  customer_confirm: "bg-amber-50 text-amber-700",
  confirmed: "bg-teal-50 text-teal-700",
  pre_notice: "bg-violet-50 text-violet-700",
  completed: "bg-slate-200 text-slate-700"
}[stage] || "bg-teal-50 text-teal-700");
const bookingStageOptions = (selected = "confirmed") => BOOKING_STAGES.map((item) => `<option value="${item.key}" ${item.key === selected ? "selected" : ""}>${item.label}</option>`).join("");
const isBookingConfirmed = (appt = {}) => ["confirmed", "pre_notice", "completed"].includes(appt.bookingStage) || String(appt.isCompleted) === "true";
const isBookingUnconfirmed = (appt = {}) => !isBookingConfirmed(appt);
const isKnownBookingStage = (stage = "") => BOOKING_STAGES.some((item) => item.key === stage);

function normalizeBookingStage(stage = "", appt = {}) {
  const value = String(stage || "").trim();
  if (isKnownBookingStage(value)) return value;
  return String(appt.isCompleted) === "true" || appt.isCompleted === true ? "completed" : "confirmed";
}

function appointmentMetaFromAppointment(appt = {}) {
  const id = appt.id || appt.appId;
  if (!id) return null;
  const bookingStage = normalizeBookingStage(appt.bookingStage, appt);
  return {
    id,
    bookingStage,
    isCompleted: bookingStage === "completed",
    collectedPrice: cleanPin(appt.collectedPrice || ""),
    remittanceDue: cleanPin(appt.remittanceDue || ""),
    remittancePaid: appt.remittancePaid === true || String(appt.remittancePaid) === "true",
    remittanceMethod: String(appt.remittanceMethod || "").trim(),
    selectionId: String(appt.selectionId || "").trim(),
    updatedAt: new Date().toISOString()
  };
}

function syncAppointmentMeta(appt = {}) {
  const meta = appointmentMetaFromAppointment(appt);
  if (!meta?.id) return null;
  db.appointmentMeta ||= {};
  db.appointmentMeta[meta.id] = meta;
  const key = appointmentMetaKey(meta.id);
  db.customers[key] = {
    name: `預約狀態-${meta.bookingStage}-${meta.id}`,
    notes: JSON.stringify(meta),
    records: []
  };
  return { action: "saveCustomer", data: { phone: key, ...db.customers[key] } };
}

function normalizeTherapistProfile(therapist = {}) {
  const normalized = { ...THERAPIST_PROFILE_DEFAULTS, ...therapist };
  normalized.pin = cleanPin(normalized.pin);
  Object.keys(THERAPIST_PROFILE_DEFAULTS).forEach((key) => {
    normalized[key] = String(normalized[key] || "").trim();
  });
  return normalized;
}

function therapistDisplayMeta(therapist = {}) {
  const body = [];
  if (therapist.contact) body.push(therapist.contact);
  const stats = [
    therapist.age ? `${therapist.age}歲` : "",
    therapist.height ? `${therapist.height}cm` : "",
    therapist.weight ? `${therapist.weight}kg` : ""
  ].filter(Boolean).join(" / ");
  if (stats) body.push(stats);
  return body.join(" · ");
}

let syncMeta = loadSyncMeta();
let loadedLocalDbFromStorage = false;
let db = seedDatabase();

function customerCode(phone = "") {
  return db.customers[phone]?.code || "";
}

function customerDisplay(phone = "", fallbackName = "") {
  const customer = db.customers[phone];
  const code = customer?.code || "未建檔";
  const name = String(customer?.name || fallbackName || "").trim();
  return name ? `${code} ${name}` : code;
}

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function seedDatabase() {
  const base = {
    therapists: {},
    admins: { admin: { name: "系統總管理員", pin: "admin123", email: "" } },
    schedules: {},
    appointments: {},
    customers: { SYS_DOOR_PWD: { name: "設定", notes: "", records: [] } }
  };
  return normalizeDb(base);
}

function normalizeDb(data) {
  data.therapists ||= {};
  data.schedules ||= {};
  data.admins = {
    admin: { name: "系統總管理員", pin: "admin123", email: "" },
    ...(data.admins || {})
  };
  data.appointments ||= {};
  data.customers ||= {};
  data.approvals ||= {};
  data.clientSelections ||= {};
  data.appointmentMeta ||= {};
  Object.values(data.appointments).forEach((appt) => {
    if (!appt.phone || isSystemCustomerKey(appt.phone)) return;
    data.customers[appt.phone] ||= { name: appt.customerName || "", notes: "", records: [] };
    if (!data.customers[appt.phone].name && appt.customerName) data.customers[appt.phone].name = appt.customerName;
  });
  Object.keys(data.customers).forEach((key) => {
    data.customers[key].records ||= [];
    data.customers[key].records.forEach((record) => {
      record.date = normalizeDateField(record.date);
      record.time = normalizeTimeField(record.time);
      record.collectedPrice = cleanPin(record.collectedPrice || "");
      record.remittanceDue = cleanPin(record.remittanceDue || "");
      record.remittancePaid = String(record.remittancePaid) === "true" || record.remittancePaid === true;
      record.remittanceMethod = String(record.remittanceMethod || "").trim();
    });
    if (!key.startsWith("SYS_ADMIN_")) return;
    const id = key.replace("SYS_ADMIN_", "");
    data.admins[id] = {
      name: data.customers[key].name || id,
      pin: cleanPin(data.customers[key].notes || ""),
      email: data.customers[key].records?.[0]?.email || ""
    };
  });
  Object.keys(data.customers).forEach((key) => {
    if (!key.startsWith("SYS_THERAPIST_PROFILE_")) return;
    const id = key.replace("SYS_THERAPIST_PROFILE_", "");
    let profile = {};
    try { profile = JSON.parse(data.customers[key].notes || "{}"); } catch {}
    data.therapists[id] = { ...(data.therapists[id] || {}), ...profile };
  });
  data.approvals = {};
  Object.keys(data.customers).forEach((key) => {
    if (!key.startsWith(APPROVAL_PREFIX)) return;
    try {
      const approval = JSON.parse(data.customers[key].notes || "{}");
      if (approval.id) data.approvals[approval.id] = approval;
    } catch {}
  });
  data.clientSelections = {};
  Object.keys(data.customers).forEach((key) => {
    if (!key.startsWith(CLIENT_SELECTION_PREFIX)) return;
    try {
      const selection = JSON.parse(data.customers[key].notes || "{}");
      if (selection.id) data.clientSelections[selection.id] = selection;
    } catch {}
  });
  data.appointmentMeta = {};
  Object.keys(data.customers).forEach((key) => {
    if (!key.startsWith(APPOINTMENT_META_PREFIX)) return;
    try {
      const meta = JSON.parse(data.customers[key].notes || "{}");
      const id = meta.id || key.replace(APPOINTMENT_META_PREFIX, "");
      if (id) data.appointmentMeta[id] = { ...meta, id };
    } catch {}
  });
  Object.keys(data.therapists).forEach((id) => {
    data.therapists[id] = normalizeTherapistProfile(data.therapists[id]);
  });
  Object.keys(data.admins).forEach((id) => {
    data.admins[id].pin = cleanPin(data.admins[id].pin);
  });
  Object.entries(data.appointments).forEach(([id, appt]) => {
    const meta = data.appointmentMeta[id] || data.appointmentMeta[appt.id] || {};
    const metaHas = (key) => Object.prototype.hasOwnProperty.call(meta, key);
    Object.assign(appt, {
      bookingStage: metaHas("bookingStage") ? meta.bookingStage : appt.bookingStage,
      isCompleted: metaHas("isCompleted") ? meta.isCompleted : appt.isCompleted,
      collectedPrice: metaHas("collectedPrice") ? meta.collectedPrice : appt.collectedPrice,
      remittanceDue: metaHas("remittanceDue") ? meta.remittanceDue : appt.remittanceDue,
      remittancePaid: metaHas("remittancePaid") ? meta.remittancePaid : appt.remittancePaid,
      remittanceMethod: metaHas("remittanceMethod") ? meta.remittanceMethod : appt.remittanceMethod,
      selectionId: metaHas("selectionId") ? meta.selectionId : appt.selectionId
    });
    appt.id = appt.id || id;
    appt.date = normalizeDateField(appt.date);
    appt.time = normalizeTimeField(appt.time);
    appt.duration = Number(appt.duration || 60);
    appt.price = Number(appt.price || 0);
    appt.collectedPrice = cleanPin(appt.collectedPrice || "");
    appt.remittanceDue = cleanPin(appt.remittanceDue || "");
    appt.remittancePaid = String(appt.remittancePaid) === "true" || appt.remittancePaid === true;
    appt.remittanceMethod = String(appt.remittanceMethod || "").trim();
    appt.customerName = String(appt.customerName || "").trim();
    appt.bookingStage = normalizeBookingStage(appt.bookingStage, appt);
    appt.isCompleted = appt.bookingStage === "completed";
  });
  Object.values(data.customers).forEach((customer) => {
    (customer.records || []).forEach((record) => {
      const appt = record.id ? data.appointments[record.id] : null;
      if (!appt) return;
      // Appointment metadata is authoritative. Customer records are only a
      // compatibility fallback for older rows that predate SYS_APPT_META_*.
      if (data.appointmentMeta[appt.id]) return;
      if (!appt.collectedPrice && record.collectedPrice) appt.collectedPrice = record.collectedPrice;
      if (!appt.remittanceDue && record.remittanceDue) appt.remittanceDue = record.remittanceDue;
      if (!appt.remittancePaid && record.remittancePaid) appt.remittancePaid = record.remittancePaid;
      if (!appt.remittanceMethod && record.remittanceMethod) appt.remittanceMethod = record.remittanceMethod;
    });
  });
  assignCustomerCodes(data);
  return data;
}

function assignCustomerCodes(data) {
  const realKeys = Object.keys(data.customers).filter((key) => !isSystemCustomerKey(key)).sort();
  let max = 0;
  realKeys.forEach((key) => {
    const match = String(data.customers[key].code || "").match(/^C(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  });
  realKeys.forEach((key) => {
    data.customers[key].name = String(data.customers[key].name || "").trim();
    data.customers[key].records ||= [];
    if (!data.customers[key].code) {
      max += 1;
      data.customers[key].code = `C${String(max).padStart(4, "0")}`;
    }
  });
}

function saveBackupSnapshot(reason, snapshotText) {
  try {
    if (!snapshotText) return;
    const snapshot = JSON.parse(snapshotText);
    const key = `${LOCAL_BACKUP_PREFIX}-${Date.now()}`;
    pruneLocalBackups(MAX_LOCAL_BACKUPS - 1);
    safeLocalStorageSet(key, JSON.stringify({
      reason: reason || "資料修改前",
      at: new Date().toISOString(),
      db: snapshot
    }), { isBackup: true, silent: true });
  } catch {}
}

function localBackupKeys() {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(`${LOCAL_BACKUP_PREFIX}-`))
      .sort();
  } catch {
    return [];
  }
}

function pruneLocalBackups(keep = MAX_LOCAL_BACKUPS) {
  const keys = localBackupKeys();
  const removeCount = Math.max(0, keys.length - keep);
  keys.slice(0, removeCount).forEach((key) => {
    try { localStorage.removeItem(key); } catch {}
  });
}

function isQuotaError(error) {
  return error?.name === "QuotaExceededError" || /quota/i.test(String(error?.message || error || ""));
}

function safeLocalStorageSet(key, value, options = {}) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    pruneLocalBackups(options.isBackup ? Math.max(0, Math.floor(MAX_LOCAL_BACKUPS / 2) - 1) : 0);
    try {
      localStorage.setItem(key, value);
      if (!options.silent) showSnackbar("本機暫存已清理，操作可繼續");
      return true;
    } catch (retryError) {
      if (!options.isBackup) throw retryError;
      return false;
    }
  }
}

function persist(reason = "") {
  const next = JSON.stringify(db);
  const previous = localStorage.getItem(STORAGE_KEY);
  if (!suppressPersistBackup && previous && previous !== next) {
    saveBackupSnapshot(reason || pendingBackupReason || "資料修改前", previous);
  }
  safeLocalStorageSet(STORAGE_KEY, next);
  pendingBackupReason = "";
}

function snapshotDatabase() {
  return JSON.parse(JSON.stringify(db));
}

function restoreDatabase(snapshot, reason = "雲端未確認，已還原畫面") {
  if (!snapshot) return;
  db = normalizeDb(snapshot);
  persist(reason);
  renderAll();
}

function loadSyncMeta() {
  try {
    return {
      pending: false,
      source: "local",
      lastSync: "",
      reason: "",
      ...JSON.parse(localStorage.getItem(SYNC_META_KEY) || "{}")
    };
  } catch {
    return { pending: false, source: "local", lastSync: "", reason: "" };
  }
}

function saveSyncMeta() {
  safeLocalStorageSet(SYNC_META_KEY, JSON.stringify(syncMeta), { silent: true });
}

function parseSyncMeta(value = "") {
  try {
    const meta = JSON.parse(String(value || "{}"));
    return meta && typeof meta === "object" ? meta : {};
  } catch {
    return {};
  }
}

function cloudSyncMetaStore() {
  return parseSyncMeta(db.customers?.[CLOUD_SYNC_META_KEY]?.notes || "");
}

function effectiveSyncMeta() {
  return {
    pending: Boolean(syncMeta.pending),
    source: syncMeta.source || "local",
    lastSync: String(syncMeta.lastSync || ""),
    reason: String(syncMeta.reason || ""),
    updatedAt: String(syncMeta.updatedAt || ""),
    device: String(syncMeta.device || ""),
    path: String(syncMeta.path || "")
  };
}

async function writeCloudSyncMeta(reason = "", extra = {}) {
  const savedAt = new Date().toISOString();
  const payload = {
    pending: false,
    source: "cloud",
    lastSync: savedAt,
    reason: String(reason || ""),
    updatedAt: savedAt,
    device: navigator.userAgent || "",
    path: location.pathname || "",
    ...extra
  };
  syncMeta = payload;
  saveSyncMeta();
  return payload;
}

function backupLocalDb(reason) {
  try {
    saveBackupSnapshot(reason, JSON.stringify(db));
  } catch {}
}

function markSyncPending(isPending, reason = "") {
  syncMeta.pending = isPending;
  syncMeta.reason = reason;
  syncMeta.source = isPending ? "local" : "cloud";
  syncMeta.lastSync = isPending ? syncMeta.lastSync : new Date().toISOString();
  saveSyncMeta();
}

async function tryCloudSync(options = {}) {
  const force = Boolean(options.force);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_URL}?t=${Date.now()}`, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cloudDb = normalizeCloudPayload(await res.json());
    backupLocalDb(force ? "before-force-cloud-sync" : "before-cloud-authoritative-sync");
    db = cloudDb;
    persist();
    markSyncPending(false);
    $("sysStatus").textContent = "已連線雲端資料";
    return true;
  } catch {
    $("sysStatus").textContent = "目前連線不穩，先暫停更新";
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCloudPayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("雲端回傳格式錯誤");
  if (payload.success === false) throw new Error(payload.error || "雲端拒絕存取");
  const required = ["therapists", "schedules", "appointments", "customers"];
  if (!required.every((key) => payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key]))) {
    throw new Error("雲端資料不完整");
  }
  return normalizeDb(payload);
}

async function postCloud(action, data) {
  persist();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      mode: "no-cors",
      body: JSON.stringify({ action, data }),
      signal: controller.signal,
      cache: "no-store"
    });
    const accepted = res.ok || res.type === "opaque" || res.status === 302 || res.type === "opaqueredirect" || (res.status >= 200 && res.status < 400);
    if (!accepted) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch {
    markSyncPending(true, "last-write-failed");
    showSnackbar("已先存於此瀏覽器；雲端寫入失敗，請檢查 Apps Script 權限");
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

let cloudBatchSupportPromise = null;

async function cloudSupportsBatch() {
  if (!cloudBatchSupportPromise) {
    cloudBatchSupportPromise = fetch(`${API_URL}?mode=capabilities&t=${Date.now()}`, { cache: "no-store" })
      .then((res) => res.ok ? res.json() : null)
      .then((payload) => payload?.capabilities?.batch === true)
      .catch(() => false);
  }
  return cloudBatchSupportPromise;
}

function comparableAppointment(appt = {}) {
  return {
    date: normalizeDateField(appt.date),
    time: normalizeTimeField(appt.time),
    therapistId: String(appt.therapistId || ""),
    customerName: String(appt.customerName || ""),
    phone: cleanPin(appt.phone || ""),
    service: String(appt.service || ""),
    duration: Number(appt.duration || 60),
    room: String(appt.room || "R"),
    price: String(appt.price ?? ""),
    collectedPrice: cleanPin(appt.collectedPrice || ""),
    isCompleted: String(appt.isCompleted) === "true" || appt.isCompleted === true,
    notes: String(appt.notes || ""),
    bookingStage: String(appt.bookingStage || ""),
    remittanceDue: cleanPin(appt.remittanceDue || ""),
    remittancePaid: String(appt.remittancePaid) === "true" || appt.remittancePaid === true,
    remittanceMethod: String(appt.remittanceMethod || "")
  };
}

function cloudActionVerified(item, cloudDb) {
  const data = item?.data || {};
  if (item.action === "addAppointment") {
    const id = data.appId || data.id;
    return Boolean(id && cloudDb.appointments?.[id] && canonicalJson(comparableAppointment(cloudDb.appointments[id])) === canonicalJson(comparableAppointment(data)));
  }
  if (item.action === "deleteAppointment") return !cloudDb.appointments?.[data.appId || data.id];
  if (item.action === "saveCustomer") {
    const actual = cloudDb.customers?.[data.phone];
    if (!actual) return false;
    return String(actual.name || "") === String(data.name || "")
      && String(actual.notes || "") === String(data.notes || "")
      && canonicalJson(actual.records || []) === canonicalJson(data.records || []);
  }
  if (item.action === "deleteCustomer") return !cloudDb.customers?.[data.phone];
  if (item.action === "saveSchedule") {
    const actual = cloudDb.schedules?.[data.id] || {};
    return Object.entries(data.schedule || {}).every(([date, value]) => String(actual[date] || "") === String(value || ""));
  }
  if (item.action === "addTherapist" || item.action === "updatePin") {
    const actual = cloudDb.therapists?.[data.id];
    if (!actual) return false;
    const expectedName = String(data.nickname || data.name || "");
    return (!expectedName || String(actual.name || actual.nickname || "") === expectedName)
      && (!data.pin || cleanPin(actual.pin) === cleanPin(data.pin));
  }
  if (item.action === "deleteTherapist") return !cloudDb.therapists?.[data.id] && !cloudDb.schedules?.[data.id];
  if (item.action === "submitClientSelection") return Boolean(cloudDb.clientSelections?.[data.id]);
  return ["sendEmailNotification", "repairTherapists"].includes(item.action);
}

async function readBackVerifiedCloud(actions, customVerifier) {
  const delays = [350, 700, 1200, 2000, 3000];
  let latest = null;
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      latest = await fetchCloudDbSnapshot();
      const actionsOk = actions.every((item) => cloudActionVerified(item, latest));
      const customOk = typeof customVerifier !== "function" || customVerifier(latest);
      if (actionsOk && customOk) return latest;
    } catch {}
  }
  return null;
}

async function saveCloudActions(actions, successMessage = "已儲存到雲端", options = {}) {
  actions = (actions || []).filter(Boolean);
  if (!actions.length) return true;
  showSnackbar("正在寫入雲端...");
  pendingBackupReason = successMessage;
  const results = [];
  if (actions.length > 1 && await cloudSupportsBatch()) {
    options.onProgress?.(1, 1, { action: "batch" });
    results.push(await postCloud("batch", { actions }));
  } else {
    for (const [index, item] of actions.entries()) {
      options.onProgress?.(index + 1, actions.length, item);
      results.push(await postCloud(item.action, item.data));
    }
  }
  const ok = results.every(Boolean);
  if (!ok) {
    markSyncPending(true, "cloud-write-failed");
    persist("雲端寫入尚未確認");
    showSnackbar("雲端寫入失敗；本頁保留修改，請稍後重試");
    return false;
  }
  const cloudDb = await readBackVerifiedCloud(actions, options.verifyCloud);
  if (!cloudDb) {
    markSyncPending(true, "cloud-awaiting-refresh");
    persist("雲端尚未確認寫入");
    showSnackbar("雲端尚未確認寫入；本頁保留修改，請稍後重試");
    return false;
  }
  db = cloudDb;
  persist();
  markSyncPending(false);
  await writeCloudSyncMeta(successMessage);
  persist(successMessage);
  showSnackbar(successMessage);
  return true;
}

function setFormBusy(form, busy, label = "寫入雲端...") {
  const button = form?.querySelector('button[type="submit"], button:not([type]), .btn-teal, .btn-primary');
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function generateMonthData() {
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  monthDates = [];
  for (const d = new Date(currentYear, currentMonth, 1); d.getMonth() === currentMonth; d.setDate(d.getDate() + 1)) {
    monthDates.push({
      key: toDateKey(d),
      displayShort: `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`,
      displayFull: `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} (${days[d.getDay()]})`,
      dayDisplay: String(d.getDate()).padStart(2, "0"),
      dayOfWeek: days[d.getDay()],
      rawDay: d.getDay(),
      isWeekend: d.getDay() === 0 || d.getDay() === 6
    });
  }
  monthWeeks = [];
  let week = [];
  monthDates.forEach((d) => {
    week.push(d);
    if (d.rawDay === 0 || d.key === monthDates.at(-1).key) {
      monthWeeks.push(week);
      week = [];
    }
  });
  $("currentDateRange").textContent = `${currentYear}年 ${String(currentMonth + 1).padStart(2, "0")}月`;
}

function showSnackbar(message) {
  const el = $("snackbar");
  el.textContent = message;
  el.classList.remove("opacity-0", "translate-y-4");
  el.classList.add("opacity-100", "translate-y-0");
  setTimeout(() => {
    el.classList.add("opacity-0", "translate-y-4");
    el.classList.remove("opacity-100", "translate-y-0");
  }, 2600);
}

function metric(title, value, color = "text-slate-800") {
  return `<div class="metric"><p class="mb-1 text-sm font-black text-slate-500">${title}</p><p class="text-3xl font-black ${color}">${value}</p></div>`;
}

function addDaysKey(baseKey, offset) {
  const date = new Date(`${baseKey}T00:00:00`);
  date.setDate(date.getDate() + offset);
  return toDateKey(date);
}

function compactApptLine(appt, tone = "slate") {
  const toneClass = {
    teal: "border-teal-200 bg-teal-50",
    amber: "border-amber-200 bg-amber-50",
    rose: "border-rose-200 bg-rose-50",
    slate: "border-slate-200 bg-white"
  }[tone] || "border-slate-200 bg-white";
  return `<button data-open-appt="${esc(appt.id)}" class="w-full rounded-xl border ${toneClass} p-3 text-left transition hover:border-teal-300 hover:bg-teal-50">
    <div class="flex items-center justify-between gap-3"><span class="font-mono text-sm font-black">${esc(appt.date)} ${esc(appt.time || "--:--")}</span>${roomBadge(appt.room)}</div>
    <div class="mt-2 font-black text-slate-900">${esc(customerDisplay(appt.phone, appt.customerName))}</div>
    <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-bold text-slate-500"><span>${esc(therapistName(appt.therapistId))}</span><span>${esc(courseName(appt.service))}</span><span>${money(appt.price)}</span></div>
  </button>`;
}

function therapistCutFor(appt) {
  return Number(COURSE_CATALOG[appt.service]?.therapistCut || 0);
}

function companyCutFor(appt) {
  return Math.max(0, Number(appt.price || 0) - therapistCutFor(appt));
}

function remittanceDueFor(appt) {
  const manual = String(appt.remittanceDue ?? "").trim();
  return manual ? Math.max(0, Number(manual) || 0) : companyCutFor(appt);
}

function isRemittancePaid(appt) {
  return String(appt.remittancePaid) === "true" || Number(appt.collectedPrice || 0) > 0;
}

function dbStats(data = db) {
  return {
    therapists: Object.keys(data.therapists || {}).length,
    appointments: Object.keys(data.appointments || {}).length,
    customers: Object.keys(data.customers || {}).filter((key) => !isSystemCustomerKey(key)).length,
    schedules: Object.keys(data.schedules || {}).length
  };
}

function systemRecordStats(data = db) {
  const keys = Object.keys(data.customers || {}).filter(isSystemCustomerKey);
  return {
    total: keys.length,
    admins: keys.filter((key) => key.startsWith("SYS_ADMIN_")).length,
    therapistProfiles: keys.filter((key) => key.startsWith("SYS_THERAPIST_PROFILE_")).length,
    approvals: keys.filter((key) => key.startsWith(APPROVAL_PREFIX)).length,
    clientSelections: keys.filter((key) => key.startsWith(CLIENT_SELECTION_PREFIX)).length,
    appointmentMeta: keys.filter((key) => key.startsWith(APPOINTMENT_META_PREFIX)).length,
    logs: keys.filter((key) => key === ADMIN_LOGIN_LOG_KEY || key === FRONTDESK_LOGIN_LOG_KEY || key === SYSTEM_NOTE_KEY || key === "SYS_DOOR_PWD").length
  };
}

function modelSummaryHtml(data = db) {
  const stats = dbStats(data);
  const system = systemRecordStats(data);
  return `<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    ${metric("正式按摩師", stats.therapists)}
    ${metric("正式預約", stats.appointments, "text-teal-700")}
    ${metric("正式顧客", stats.customers, "text-indigo-700")}
    ${metric("系統資料", system.total, "text-amber-700")}
  </div>
  <div class="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
    <div class="rounded-xl border bg-slate-50 p-3"><p class="text-xs font-black text-slate-500">管理員</p><p class="mt-1 text-xl font-black">${system.admins}</p></div>
    <div class="rounded-xl border bg-slate-50 p-3"><p class="text-xs font-black text-slate-500">師傅人事</p><p class="mt-1 text-xl font-black">${system.therapistProfiles}</p></div>
    <div class="rounded-xl border bg-slate-50 p-3"><p class="text-xs font-black text-slate-500">審核</p><p class="mt-1 text-xl font-black">${system.approvals}</p></div>
    <div class="rounded-xl border bg-slate-50 p-3"><p class="text-xs font-black text-slate-500">客選</p><p class="mt-1 text-xl font-black">${system.clientSelections}</p></div>
    <div class="rounded-xl border bg-slate-50 p-3"><p class="text-xs font-black text-slate-500">預約狀態</p><p class="mt-1 text-xl font-black">${system.appointmentMeta}</p></div>
    <div class="rounded-xl border bg-slate-50 p-3"><p class="text-xs font-black text-slate-500">紀錄設定</p><p class="mt-1 text-xl font-black">${system.logs}</p></div>
  </div>`;
}

function listLocalBackups() {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(`${LOCAL_BACKUP_PREFIX}-`))
      .map((key) => {
        try {
          const item = JSON.parse(localStorage.getItem(key) || "{}");
          return { key, ...item, stats: dbStats(item.db || {}) };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  } catch {
    return [];
  }
}

function backupLabelTime(value = "") {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-TW", { hour12: false });
}

function downloadJSON(payload, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function copyText(value, successMessage = "已複製") {
  const text = String(value || "");
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.left = "-9999px";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
  showSnackbar(successMessage);
  return true;
}

function downloadCurrentBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "morgan-ops-hub",
    version: APP_VERSION,
    syncMeta,
    db
  };
  downloadJSON(payload, `morgan-ops-backup-${todayKey()}-${Date.now()}.json`);
  showSnackbar("資料備份已下載");
}

function adminLoginLogStore() {
  db.customers[ADMIN_LOGIN_LOG_KEY] ||= { name: "後台管理登入紀錄", notes: "", records: [] };
  db.customers[ADMIN_LOGIN_LOG_KEY].records ||= [];
  return db.customers[ADMIN_LOGIN_LOG_KEY];
}

function normalizeAuditRecord(record) {
  let base = record;
  if (typeof base === "string") {
    try {
      base = JSON.parse(base);
    } catch {
      base = { value: base };
    }
  }
  if (!base || typeof base !== "object" || Array.isArray(base)) return {};
  const nested = [base.data, base.payload, base.record, base.meta]
    .filter((value) => value && typeof value === "object" && !Array.isArray(value));
  return Object.assign({}, ...nested, base);
}

function auditField(record, keys, fallback = "舊紀錄未記錄") {
  const item = normalizeAuditRecord(record);
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return fallback;
}

function auditTimestamp(record) {
  return auditField(record, ["at", "timestamp", "time", "createdAt", "updatedAt", "date"], "");
}

function adminLoginRecords(limit = 80) {
  return [...(db.customers[ADMIN_LOGIN_LOG_KEY]?.records || [])]
    .map(normalizeAuditRecord)
    .sort((a, b) => auditTimestamp(b).localeCompare(auditTimestamp(a)))
    .slice(0, limit);
}

function frontdeskLoginRecords(limit = 80) {
  return [...(db.customers[FRONTDESK_LOGIN_LOG_KEY]?.records || [])]
    .map(normalizeAuditRecord)
    .sort((a, b) => auditTimestamp(b).localeCompare(auditTimestamp(a)))
    .slice(0, limit);
}

function readLocalSystemNote() {
  try {
    return JSON.parse(localStorage.getItem(SYSTEM_NOTE_LOCAL_KEY) || "null") || null;
  } catch {
    return null;
  }
}

function latestSystemNoteTime(store = {}) {
  if (!store) return 0;
  const localSavedAt = store.savedAt || "";
  const recordTimes = Array.isArray(store.records) ? store.records.map((item) => item?.at || "").filter(Boolean) : [];
  const latestRecordAt = recordTimes.sort().at(-1) || "";
  return Math.max(Date.parse(localSavedAt) || 0, Date.parse(latestRecordAt) || 0);
}

function writeLocalSystemNote(store, savedAt = new Date().toISOString()) {
  try {
    safeLocalStorageSet(SYSTEM_NOTE_LOCAL_KEY, JSON.stringify({
      notes: String(store?.notes || ""),
      records: store?.records || [],
      savedAt
    }), { silent: true });
  } catch {}
}

function systemNoteStore() {
  db.customers[SYSTEM_NOTE_KEY] ||= { name: "系統備忘", notes: "", records: [] };
  db.customers[SYSTEM_NOTE_KEY].records ||= [];
  return db.customers[SYSTEM_NOTE_KEY];
}

async function saveSystemNote() {
  const textarea = $("systemNoteText");
  if (!textarea) return;
  const snapshot = snapshotDatabase();
  const note = textarea.value.trim();
  const store = systemNoteStore();
  const savedAt = new Date().toISOString();
  store.notes = note;
  store.savedAt = savedAt;
  store.records.push({
    id: `SYSNOTE-${Date.now().toString(36).toUpperCase()}`,
    at: savedAt,
    adminId: currentUser?.id || "",
    adminName: currentUser?.name || "",
    length: note.length
  });
  store.records = store.records.slice(-40);
  const saved = await saveCloudActions([{ action: "saveCustomer", data: { phone: SYSTEM_NOTE_KEY, ...store } }], "系統 Note 已儲存");
  if (!saved) {
    restoreDatabase(snapshot, "系統 Note 未獲雲端確認，已還原");
    return;
  }
  writeLocalSystemNote(store, savedAt);
  renderSystem();
}

async function recordAdminLogin(id) {
  const store = adminLoginLogStore();
  store.records.push({
    id: `LOGIN-${Date.now().toString(36).toUpperCase()}`,
    at: new Date().toISOString(),
    adminId: id,
    adminName: db.admins[id]?.name || id,
    source: location.hostname || "local",
    path: location.pathname || "",
    device: navigator.userAgent || "",
    width: window.innerWidth || 0
  });
  store.records = store.records.slice(-200);
  try {
    suppressPersistBackup = true;
    await postCloud("saveCustomer", { phone: ADMIN_LOGIN_LOG_KEY, ...store });
  } finally {
    suppressPersistBackup = false;
  }
  if ($("view-system") && !$("view-system").classList.contains("hidden")) renderSystem();
}

function downloadBackupEntry(key) {
  const entry = listLocalBackups().find((item) => item.key === key);
  if (!entry) return showSnackbar("找不到該筆修改紀錄");
  downloadJSON({ exportedAt: new Date().toISOString(), backup: entry }, `morgan-ops-change-${entry.at || Date.now()}.json`);
  showSnackbar("修改紀錄已下載");
}

function canonicalJson(value) {
  const clean = (item) => {
    if (Array.isArray(item)) return item.map(clean);
    if (!item || typeof item !== "object") return item ?? null;
    return Object.keys(item).sort().reduce((next, key) => {
      next[key] = clean(item[key]);
      return next;
    }, {});
  };
  return JSON.stringify(clean(value));
}

function dataChanged(next, current) {
  return canonicalJson(next) !== canonicalJson(current);
}

function restoreActionsFor(targetDb, currentDb) {
  const actions = [];
  Object.keys(currentDb.appointments || {}).forEach((id) => {
    if (!targetDb.appointments?.[id]) actions.push({ action: "deleteAppointment", data: { appId: id } });
  });
  Object.values(targetDb.appointments || {}).forEach((appt) => {
    if (dataChanged(appt, currentDb.appointments?.[appt.id])) actions.push({ action: "addAppointment", data: { ...appt, appId: appt.id } });
  });
  Object.keys(currentDb.customers || {}).forEach((phone) => {
    if (!targetDb.customers?.[phone]) actions.push({ action: "deleteCustomer", data: { phone } });
  });
  Object.entries(targetDb.customers || {}).forEach(([phone, customer]) => {
    if (dataChanged(customer, currentDb.customers?.[phone])) actions.push({ action: "saveCustomer", data: { phone, ...customer } });
  });
  Object.entries(targetDb.schedules || {}).forEach(([id, schedule]) => {
    if (dataChanged(schedule, currentDb.schedules?.[id])) actions.push({ action: "saveSchedule", data: { id, schedule } });
  });
  Object.entries(targetDb.therapists || {}).forEach(([id, therapist]) => {
    if (dataChanged(therapist, currentDb.therapists?.[id])) actions.push({ action: "addTherapist", data: therapistWritePayload(id, therapist) });
  });
  Object.entries(targetDb.admins || {}).forEach(([id, admin]) => {
    if (id === "admin") return;
    const adminCustomer = { name: admin.name || id, notes: sheetText(admin.pin || ""), records: [{ email: admin.email || "" }] };
    if (dataChanged(adminCustomer, currentDb.customers?.[`SYS_ADMIN_${id}`])) actions.push({ action: "saveCustomer", data: { phone: `SYS_ADMIN_${id}`, ...adminCustomer } });
  });
  return actions;
}

async function restoreBackup(key) {
  const entry = listLocalBackups().find((item) => item.key === key);
  if (!entry?.db) return showSnackbar("找不到可復原的資料");
  const currentDb = JSON.parse(JSON.stringify(db));
  const targetDb = normalizeDb(JSON.parse(JSON.stringify(entry.db)));
  backupLocalDb("restore-before-current-state");
  db = targetDb;
  suppressPersistBackup = true;
  persist("復原修改紀錄");
  suppressPersistBackup = false;
  const actions = restoreActionsFor(targetDb, currentDb);
  const saved = await saveCloudActions(actions, "已依修改紀錄復原並寫回雲端");
  if (!saved) {
    db = normalizeDb(currentDb);
    persist("復原未獲雲端確認，已保留目前資料");
    renderAll();
    return;
  }
  closeModal();
  renderAll();
}

async function fetchCloudDbSnapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_URL}?t=${Date.now()}`, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normalizeCloudPayload(await res.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function confirmPendingCloudSync() {
  const cloudDb = await fetchCloudDbSnapshot();
  db = cloudDb;
  persist("雲端同步已確認");
  markSyncPending(false);
  await writeCloudSyncMeta("雲端同步已確認");
  return true;
}

async function uploadLocalDbToCloud() {
  const button = $("systemUploadLocalBtn");
  if (button) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = "上傳中...";
  }
  try {
    const localDb = normalizeDb(JSON.parse(JSON.stringify(db)));
    let cloudDb = { therapists: {}, schedules: {}, admins: {}, appointments: {}, customers: {} };
    try {
      cloudDb = await fetchCloudDbSnapshot();
    } catch {
      showSnackbar("雲端資料讀取失敗，將以目前資料重新整理雲端內容");
    }
    const actions = restoreActionsFor(localDb, cloudDb);
    if (!actions.length) {
      markSyncPending(false);
      await writeCloudSyncMeta("雲端資料已確認同步");
      persist("雲端資料已確認同步");
      renderAll();
      showSnackbar("雲端資料已一致");
      return;
    }
    const ok = await saveCloudActions(actions, "雲端資料已更新", {
      onProgress(done, total) {
        if (button) button.textContent = `同步 ${done}/${total}`;
        if (done === 1 || done === total || done % 10 === 0) showSnackbar(`正在更新資料 ${done}/${total}`);
      }
    });
    if (ok) {
      markSyncPending(false);
      await writeCloudSyncMeta("雲端資料已上傳");
      persist("雲端資料已上傳");
      renderAll();
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.originalText || "更新資料";
    }
  }
}

async function openSyncDiagnosticsModal() {
  showModal(`<div class="modal max-w-3xl"><h3 class="mb-5 border-b pb-4 text-xl font-black">同步診斷</h3><div id="syncDiagnosticsBody" class="rounded-xl border bg-slate-50 p-5 text-sm font-bold text-slate-500">正在讀取雲端資料...</div><div class="mt-5 flex justify-end border-t pt-4"><button class="btn-light" data-close-modal>關閉</button></div></div>`);
  const body = $("syncDiagnosticsBody");
  try {
    const cloudDb = await fetchCloudDbSnapshot();
    const localStats = dbStats(db);
    const cloudStats = dbStats(cloudDb);
    const meta = effectiveSyncMeta();
    body.className = "space-y-5";
    body.innerHTML = `
      <div class="grid gap-4 md:grid-cols-2">
        <div class="rounded-xl border bg-white p-4">
          <p class="text-xs font-black text-slate-500">此裝置狀態</p>
          <p class="mt-2 text-xl font-black ${meta.pending ? "text-amber-700" : "text-teal-700"}">${meta.pending ? "還沒同步" : "已同步"}</p>
          <p class="mt-1 text-xs font-bold text-slate-500">${esc(meta.reason || "目前正常")} · ${esc(meta.lastSync ? backupLabelTime(meta.lastSync) : "還沒有")}</p>
        </div>
        <div class="rounded-xl border bg-white p-4">
          <p class="text-xs font-black text-slate-500">連線狀態</p>
          <p class="mt-2 text-xl font-black text-teal-700">可讀取</p>
          <p class="mt-1 text-xs font-bold text-slate-500">Google Apps Script 已回傳資料</p>
        </div>
      </div>
      <div class="rounded-xl border bg-white p-4">
        <h4 class="mb-3 font-black">目前摘要</h4>
        ${modelSummaryHtml(db)}
      </div>
      <div class="rounded-xl border bg-white p-4">
        <h4 class="mb-3 font-black">雲端摘要</h4>
        ${modelSummaryHtml(cloudDb)}
      </div>
      <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm font-bold text-slate-600">
        目前 / 雲端差異：按摩師 ${localStats.therapists - cloudStats.therapists}、預約 ${localStats.appointments - cloudStats.appointments}、顧客 ${localStats.customers - cloudStats.customers}、班表人員 ${localStats.schedules - cloudStats.schedules}
      </div>`;
    hydrateResponsiveTables(body);
  } catch {
    body.className = "rounded-xl border border-rose-200 bg-rose-50 p-5 font-bold text-rose-700";
    body.textContent = "雲端讀取失敗。請確認 Apps Script 權限或網路連線。";
  }
}

function openChangeHistoryModal() {
  const backups = listLocalBackups();
  const rows = backups.length ? backups.slice(0, 40).map((item) => `<tr>
    <td class="font-mono font-black">${esc(backupLabelTime(item.at))}</td>
    <td><div class="font-black">${esc(item.reason || "資料修改前")}</div><div class="mt-1 text-xs font-bold text-slate-400">${esc(item.key.replace(`${LOCAL_BACKUP_PREFIX}-`, ""))}</div></td>
    <td class="text-right font-black">${item.stats.appointments}</td>
    <td class="text-right font-black">${item.stats.customers}</td>
    <td class="text-right">
      <div class="flex justify-end gap-2">
        <button class="btn-light px-3 py-1 text-xs" data-download-backup="${esc(item.key)}">下載</button>
        <button class="rounded-lg bg-amber-50 px-3 py-1 text-xs font-black text-amber-700" data-restore-backup="${esc(item.key)}">復原</button>
      </div>
    </td>
  </tr>`).join("") : `<tr><td colspan="5" class="py-10 text-center font-bold text-slate-400">尚無修改紀錄；下一次儲存前會自動建立快照。</td></tr>`;
  showModal(`<div class="modal max-w-5xl">
    <div class="mb-5 flex flex-col justify-between gap-4 border-b pb-4 lg:flex-row lg:items-start">
      <div>
        <span class="badge bg-amber-50 text-amber-700">安全紀錄</span>
        <h3 class="mt-2 text-2xl font-black">修改紀錄查詢</h3>
        <p class="mt-1 text-sm font-bold text-slate-500">顯示此瀏覽器保存的寫入前快照；復原會把該份資料重新寫回雲端。</p>
      </div>
      <div class="flex gap-2"><button id="downloadCurrentBackupBtn" class="btn-teal">下載目前資料</button><button class="btn-light" data-close-modal>關閉</button></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>時間</th><th>來源</th><th class="text-right">預約</th><th class="text-right">顧客</th><th class="text-right">操作</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`);
  $("downloadCurrentBackupBtn").onclick = downloadCurrentBackup;
  $("modalRoot").querySelectorAll("[data-download-backup]").forEach((btn) => btn.onclick = () => downloadBackupEntry(btn.dataset.downloadBackup));
  $("modalRoot").querySelectorAll("[data-restore-backup]").forEach((btn) => btn.onclick = () => {
    const key = btn.dataset.restoreBackup;
    confirmAction("復原此筆修改紀錄？", "系統會先備份目前狀態，再把此筆快照重新寫回雲端。這可能會覆蓋目前預約、顧客與班表資料。", () => restoreBackup(key), "確認復原");
  });
}

function openDailyBusinessSummary(day = todayKey()) {
  const rows = Object.values(db.appointments).filter((appt) => appt.date === day).sort(sortByTime);
  const totalRevenue = rows.reduce((sum, appt) => sum + Number(appt.price || 0), 0);
  const totalCompany = rows.reduce((sum, appt) => sum + remittanceDueFor(appt), 0);
  const totalTherapist = rows.reduce((sum, appt) => sum + therapistCutFor(appt), 0);
  const paidCompany = rows.reduce((sum, appt) => sum + (isRemittancePaid(appt) ? remittanceDueFor(appt) : 0), 0);
  const unpaidCompany = Math.max(0, totalCompany - paidCompany);
  const completed = rows.filter((appt) => String(appt.isCompleted) === "true" || appt.bookingStage === "completed").length;
  const confirmed = rows.filter(isBookingConfirmed).length;
  const therapistRows = Object.keys(db.therapists).map((id) => {
    const mine = rows.filter((appt) => appt.therapistId === id);
    return {
      id,
      count: mine.length,
      revenue: mine.reduce((sum, appt) => sum + Number(appt.price || 0), 0),
      company: mine.reduce((sum, appt) => sum + remittanceDueFor(appt), 0),
      paid: mine.reduce((sum, appt) => sum + (isRemittancePaid(appt) ? remittanceDueFor(appt) : 0), 0)
    };
  }).filter((row) => row.count > 0).sort((a, b) => b.revenue - a.revenue);
  const therapistBody = therapistRows.length ? therapistRows.map((row) => `<tr>
    <td class="font-black text-teal-700">${esc(therapistName(row.id))}</td>
    <td class="text-right font-black">${row.count}</td>
    <td class="text-right font-black text-rose-700">${money(row.revenue)}</td>
    <td class="text-right font-black text-teal-700">${money(row.company)}</td>
    <td class="text-right font-black ${row.company - row.paid > 0 ? "text-amber-700" : "text-emerald-700"}">${money(Math.max(0, row.company - row.paid))}</td>
  </tr>`).join("") : `<tr><td colspan="5" class="py-8 text-center font-bold text-slate-400">今日尚無師傅營業資料</td></tr>`;
  const detailBody = rows.length ? rows.map((appt) => `<tr>
    <td><button data-open-appt="${esc(appt.id)}" class="font-mono font-black text-teal-700 hover:text-teal-900">${esc(appt.time || "--:--")}</button></td>
    <td><button data-open-appt="${esc(appt.id)}" class="text-left font-black hover:text-teal-700">${esc(customerDisplay(appt.phone, appt.customerName))}</button></td>
    <td>${esc(therapistName(appt.therapistId))}</td>
    <td>${esc(courseName(appt.service))}</td>
    <td><span class="badge ${bookingStageClass(appt.bookingStage)}">${esc(bookingStageLabel(appt.bookingStage))}</span></td>
    <td class="text-right font-black text-rose-700">${money(appt.price)}</td>
    <td class="text-right font-black text-teal-700">${money(remittanceDueFor(appt))}</td>
    <td>${isRemittancePaid(appt) ? `<span class="badge bg-emerald-50 text-emerald-700">已回帳</span>` : `<span class="badge bg-amber-50 text-amber-700">未回帳</span>`}</td>
  </tr>`).join("") : `<tr><td colspan="8" class="py-10 text-center font-bold text-slate-400">今日尚無預約</td></tr>`;

  showModal(`<div class="modal max-w-6xl">
    <div class="mb-5 flex flex-col justify-between gap-4 border-b pb-4 lg:flex-row lg:items-start">
      <div>
        <span class="badge bg-teal-50 text-teal-700">當日營業狀況</span>
        <h3 class="mt-2 text-2xl font-black">營業總表</h3>
        <p class="mt-1 text-sm font-bold text-slate-500">彙整預約進度、營收、店家應回帳與師傅營業狀況。</p>
      </div>
      <div class="flex flex-col gap-2 sm:flex-row">
        <input id="businessSummaryDate" type="date" class="input py-2" value="${esc(day)}">
        <button id="queryBusinessSummaryBtn" class="btn-primary px-5 py-3">查詢</button>
        <button class="btn-light" data-close-modal>關閉</button>
      </div>
    </div>
    <div class="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-6">
      ${metric("今日預約", rows.length)}
      ${metric("已確認", confirmed, "text-teal-700")}
      ${metric("已完成", completed, "text-indigo-700")}
      ${metric("應收總額", money(totalRevenue), "text-rose-700")}
      ${metric("應回帳", money(totalCompany), "text-teal-700")}
      ${metric("未回帳", money(unpaidCompany), "text-amber-700")}
    </div>
    <div class="mb-5 grid gap-4 lg:grid-cols-[.8fr_1.2fr]">
      <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <h4 class="mb-3 font-black">帳務摘要</h4>
        <div class="grid gap-3 sm:grid-cols-2">
          ${metric("已回帳", money(paidCompany), "text-emerald-700")}
          ${metric("師傅抽成", money(totalTherapist), "text-indigo-700")}
        </div>
      </div>
      <div>
        <div class="mb-3 flex items-center justify-between gap-3"><h4 class="font-black">師傅別營業</h4><span class="badge bg-slate-100 text-slate-600">${therapistRows.length} 人</span></div>
        <div class="table-wrap"><table><thead><tr><th>師傅</th><th class="text-right">筆數</th><th class="text-right">應收總額</th><th class="text-right">應回帳</th><th class="text-right">未回帳</th></tr></thead><tbody>${therapistBody}</tbody></table></div>
      </div>
    </div>
    <div>
      <div class="mb-3 flex items-center justify-between gap-3"><h4 class="font-black">當日預約明細</h4><span class="badge bg-slate-100 text-slate-600">${rows.length} 筆</span></div>
      <div class="table-wrap"><table><thead><tr><th>時間</th><th>顧客</th><th>師傅</th><th>服務</th><th>狀態</th><th class="text-right">應收</th><th class="text-right">應回帳</th><th>回帳</th></tr></thead><tbody>${detailBody}</tbody></table></div>
    </div>
  </div>`);
  $("modalRoot").querySelectorAll("[data-open-appt]").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.openAppt;
      closeModal();
      openAppointmentDetailPage(id);
    };
  });
  $("queryBusinessSummaryBtn").onclick = () => openDailyBusinessSummary($("businessSummaryDate").value || todayKey());
}

function weekKeys(anchorKey = todayKey(), offsetWeeks = 0) {
  const date = new Date(`${anchorKey}T00:00:00`);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1 + offsetWeeks * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(date);
    d.setDate(date.getDate() + i);
    return toDateKey(d);
  });
}

function parseShiftSegments(shift = "") {
  if (!isWorking(shift)) return [];
  return String(shift).split(/[,\s、，]+/).map((part) => {
    const [rawStart, rawEnd] = part.split("-");
    if (!rawStart || !rawEnd) return null;
    let start = timeToMinutes(rawStart);
    let end = timeToMinutes(rawEnd);
    if (end <= start) end += 24 * 60;
    return { start, end, label: `${rawStart}-${rawEnd}` };
  }).filter(Boolean);
}

const SCHEDULE_WINDOW_START = 11 * 60;
const SCHEDULE_WINDOW_END = 26 * 60;
const AFTER_MIDNIGHT_CUTOFF = 5 * 60;

function normalizedTimelineMinute(mins) {
  if (mins < AFTER_MIDNIGHT_CUTOFF) return mins + 24 * 60;
  return mins;
}

function currentTimelinePercent() {
  const now = new Date();
  const current = normalizedTimelineMinute(now.getHours() * 60 + now.getMinutes());
  const total = SCHEDULE_WINDOW_END - SCHEDULE_WINDOW_START;
  if (current < SCHEDULE_WINDOW_START || current > SCHEDULE_WINDOW_END) return null;
  return ((current - SCHEDULE_WINDOW_START) / total) * 100;
}

function scheduleBarHtml(shift = "") {
  const segments = parseShiftSegments(shift);
  if (!segments.length) return `<div class="ops-schedule-track"></div>`;
  const total = SCHEDULE_WINDOW_END - SCHEDULE_WINDOW_START;
  const blocks = segments.map((seg) => {
    const start = normalizedTimelineMinute(seg.start);
    const end = normalizedTimelineMinute(seg.end);
    const left = Math.max(0, Math.min(total, start - SCHEDULE_WINDOW_START));
    const right = Math.max(0, Math.min(total, end - SCHEDULE_WINDOW_START));
    if (right <= 0 || left >= total) return "";
    const width = Math.max(3, right - left);
    return `<span class="ops-schedule-block" title="${esc(seg.label)}" style="left:${(left / total) * 100}%;width:${(width / total) * 100}%"><span>${esc(seg.label)}</span></span>`;
  }).join("");
  return `<div class="ops-schedule-track">${blocks}</div>`;
}

function dailyScheduleBoardHtml(dateKey) {
  const working = Object.entries(db.therapists).map(([id, therapist]) => ({
    id,
    name: therapistName(id),
    shift: (db.schedules[id] || {})[dateKey] || "休假"
  })).filter((row) => isWorking(row.shift)).sort((a, b) => a.shift.localeCompare(b.shift));
  if (!working.length) return `<div class="rounded-xl bg-slate-50 p-6 text-center text-sm font-bold text-slate-400">今日尚無按摩師排班</div>`;
  const nowPercent = currentTimelinePercent();
  return `<div class="ops-schedule-scroll">
    <div class="ops-schedule-board">
    <div class="ops-schedule-head">
      <span>按摩師 / 上班時段</span>
      <div class="ops-schedule-axis">
        ${["11:00", "14:00", "17:00", "20:00", "23:00", "02:00"].map((label, index) => `<span class="absolute -translate-x-1/2" style="left:${(index / 5) * 100}%">${label}</span>`).join("")}
        ${nowPercent === null ? "" : `<span class="ops-axis-now" style="left:${nowPercent}%">現在</span>`}
      </div>
    </div>
    ${working.map((row) => `<div class="ops-schedule-row"><div class="ops-schedule-person"><span class="ops-avatar">${esc(row.name.slice(0, 1))}</span><span class="min-w-0"><strong>${esc(row.name)}</strong><small>${esc(row.shift)}</small></span></div>${scheduleBarHtml(row.shift)}</div>`).join("")}
    ${nowPercent === null ? "" : `<div class="ops-schedule-now-overlay" aria-hidden="true"><span class="ops-schedule-now-line" style="left:${nowPercent}%"></span></div>`}
    </div>
  </div>`;
}

function queryTimeLabel(value = "") {
  if (!value) return "";
  return String(value).replace(/\b(\d{1,2})(\d{2})\b/g, (_, h, m) => `${String(h).padStart(2, "0")}:${m}`).slice(0, 5);
}

function normalizedQueryMinute(value = "") {
  const label = queryTimeLabel(value);
  if (!label || !label.includes(":")) return null;
  return normalizedTimelineMinute(timeToMinutes(label));
}

function isMinuteInShift(shift, normalizedMinute) {
  if (normalizedMinute === null) return false;
  return parseShiftSegments(shift).some((seg) => {
    const start = normalizedTimelineMinute(seg.start);
    const end = normalizedTimelineMinute(seg.end);
    return normalizedMinute >= start && normalizedMinute < end;
  });
}

function isRangeInShift(shift, normalizedStart, duration) {
  if (normalizedStart === null) return false;
  const normalizedEnd = normalizedStart + Number(duration || 60);
  return parseShiftSegments(shift).some((seg) => {
    const start = normalizedTimelineMinute(seg.start);
    const end = normalizedTimelineMinute(seg.end);
    return normalizedStart >= start && normalizedEnd <= end;
  });
}

function appointmentCoversMinute(appt, normalizedMinute) {
  if (normalizedMinute === null) return null;
  const start = normalizedTimelineMinute(timeToMinutes(appt.time));
  const end = start + Number(appt.duration || 60);
  return normalizedMinute >= start && normalizedMinute < end ? appt : null;
}

function therapistPhotoHtml(profile = {}, name = "") {
  const photo = String(profile.photoUrl || "").trim();
  if (photo) return `<img src="${esc(photo)}" alt="${esc(name)}" class="h-16 w-16 rounded-xl object-cover">`;
  return `<div class="flex h-16 w-16 items-center justify-center rounded-xl bg-teal-50 text-2xl font-black text-teal-700">${esc((name || "師").charAt(0))}</div>`;
}

function candidateCompleteness(profile = {}) {
  return ["photoUrl", "bio", "specialties", "height", "weight", "age"].reduce((sum, key) => sum + (String(profile[key] || "").trim() ? 1 : 0), 0);
}

function availableTherapistCandidates({ date, time, service = "", duration = 120, limit = 5 }) {
  const query = normalizedQueryMinute(time);
  if (!date || query === null) return [];
  const dur = Number(duration || COURSE_CATALOG[service]?.duration || 120);
  const results = Object.entries(db.therapists).map(([id, profile]) => {
    const shift = (db.schedules[id] || {})[date] || "休假";
    if (!isRangeInShift(shift, query, dur)) return null;
    const start = query;
    const end = start + dur;
    const dayAppts = Object.values(db.appointments).filter((appt) => appt.date === date && appt.therapistId === id);
    const conflict = dayAppts.some((appt) => {
      const apptStart = normalizedTimelineMinute(timeToMinutes(appt.time));
      const apptEnd = apptStart + Number(appt.duration || 60);
      return start < apptEnd && end > apptStart;
    });
    if (conflict) return null;
    return {
      id,
      profile,
      shift,
      dayCount: dayAppts.length,
      score: candidateCompleteness(profile) * 10 - dayAppts.length
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.dayCount - b.dayCount || therapistName(a.id).localeCompare(therapistName(b.id)));
  return Number.isFinite(limit) ? results.slice(0, limit) : results;
}

function isOpenClientSelection(item = {}) {
  return !item.appointmentId && !Object.values(db.appointments || {}).some((appt) => appt.selectionId === item.id);
}

function clientSelectionList(status = "") {
  return Object.values(db.clientSelections || {})
    .filter((item) => !status || (item.status === status && isOpenClientSelection(item)))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function updateClientSelection(selection, status, extra = {}) {
  const snapshot = snapshotDatabase();
  const next = { ...selection, ...extra, status, updatedAt: new Date().toISOString() };
  db.clientSelections[next.id] = next;
  db.customers[clientSelectionKey(next.id)] = {
    name: `${status}-${next.customerName || next.customerContact || "客選"}-${therapistName(next.selectedTherapistId)}`,
    notes: JSON.stringify(next),
    records: []
  };
  const saved = await saveCloudActions([{ action: "saveCustomer", data: { phone: clientSelectionKey(next.id), ...db.customers[clientSelectionKey(next.id)] } }], "客選狀態已更新");
  if (!saved) {
    restoreDatabase(snapshot, "客選狀態未獲雲端確認，已還原");
    return false;
  }
  renderAll();
  return true;
}

function clientSelectionUrl({ selectionId = "", date, time, service, therapistIds = [] }) {
  const url = new URL("client-selection.html", window.location.href);
  if (selectionId) {
    url.searchParams.set("selection", selectionId);
    return url.href;
  }
  url.searchParams.set("date", date);
  url.searchParams.set("time", time);
  if (service) url.searchParams.set("service", service);
  if (therapistIds.length) url.searchParams.set("therapists", therapistIds.join(","));
  else url.searchParams.set("limit", "5");
  return url.href;
}

async function createClientSelectionLink(date, time, service, therapistIds = []) {
  return clientSelectionUrl({ date, time, service, therapistIds });
}

function parseLineTrialMessage(text = "") {
  const body = String(text || "").trim();
  const today = todayKey();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  let date = body.includes("明天") ? toDateKey(tomorrow) : today;
  const dateMatch = body.match(/(\d{1,2})[/-](\d{1,2})/);
  if (dateMatch) date = `${currentYear}-${String(dateMatch[1]).padStart(2, "0")}-${String(dateMatch[2]).padStart(2, "0")}`;
  const colonTime = body.match(/(?:上午|下午|晚上|晚間|今晚|中午)?\s*(\d{1,2})[:：](\d{2})/);
  const pointTime = body.match(/(?:上午|下午|晚上|晚間|今晚|中午)?\s*(\d{1,2})\s*點\s*(半|(\d{1,2})分?)?/);
  const timeMatch = colonTime || pointTime;
  let time = "";
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = timeMatch[2] === "半" ? "30" : String(timeMatch[2] || timeMatch[3] || "00").replace(/\D/g, "").padStart(2, "0");
    if (/(下午|晚上|晚間|今晚)/.test(body) && hour < 12) hour += 12;
    time = `${String(hour).padStart(2, "0")}:${minute.slice(0, 2)}`;
  }
  const serviceKey = Object.entries(COURSE_CATALOG).find(([, course]) => body.includes(course.name.split(" ")[0]) || body.includes(String(course.duration)))?.[0] || "C120";
  return { date, time, service: serviceKey, rawText: body };
}

async function createLineTrialRequest(form) {
  const snapshot = snapshotDatabase();
  const data = Object.fromEntries(new FormData(form).entries());
  const parsed = parseLineTrialMessage(data.message);
  const id = `LINE-${Date.now().toString(36).toUpperCase()}`;
  const selection = {
    id,
    source: "line-trial",
    status: "pending",
    date: data.date || parsed.date,
    time: data.time || parsed.time,
    service: data.service || parsed.service,
    customerName: String(data.customerName || "").trim(),
    customerContact: String(data.contact || `LINE-${id}`).trim(),
    customerNote: parsed.rawText,
    selectedTherapistId: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (!selection.time) {
    $("lineTrialError").textContent = "請至少在訊息或欄位中提供預約時間。";
    $("lineTrialError").classList.remove("hidden");
    return false;
  }
  db.clientSelections[id] = selection;
  db.customers[clientSelectionKey(id)] = {
    name: `LINE測試-${selection.customerName || selection.customerContact}`,
    notes: JSON.stringify(selection),
    records: []
  };
  const saved = await saveCloudActions([{ action: "saveCustomer", data: { phone: clientSelectionKey(id), ...db.customers[clientSelectionKey(id)] } }], "LINE 測試需求已寫入待處理");
  if (!saved) {
    restoreDatabase(snapshot, "LINE 測試需求未獲雲端確認，已還原");
    return false;
  }
  if (!$("view-dispatch")?.classList.contains("hidden")) renderDispatch();
  if (!$("view-system")?.classList.contains("hidden")) renderSystem();
  return true;
}

function lineTrialPanelHtml() {
  return `<div class="card p-5">
    <div class="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <div><span class="badge bg-emerald-50 text-emerald-700">LINE 測試版</span><h3 class="mt-2 font-black">模擬 LINE 預約需求</h3><p class="mt-1 text-sm font-bold text-slate-500">以彈窗模擬客人訊息進後台後的待處理流程。</p></div>
      <button id="openLineTrialBtn" class="btn-teal">開啟測試</button>
    </div>
  </div>`;
}

function openLineTrialModal() {
  const serviceOptions = Object.entries(COURSE_CATALOG).map(([key, course]) => `<option value="${key}">${esc(course.name)}</option>`).join("");
  showModal(`<div class="modal max-w-3xl"><h3 class="mb-5 border-b pb-4 text-xl font-black">模擬 LINE 預約需求</h3>
    <form id="lineTrialForm" class="space-y-4">
      <div><label class="label">客人訊息</label><input name="message" class="input" placeholder="例：想預約今晚 20:00 C課程120分"></div>
      <div class="grid gap-4 md:grid-cols-3">
        <div><label class="label">聯絡 / LINE ID</label><input name="contact" class="input" placeholder="LINE user"></div>
        <div><label class="label">顧客姓名</label><input name="customerName" class="input" placeholder="可空白"></div>
        <div><label class="label">課程</label><select name="service" class="input">${serviceOptions}</select></div>
      </div>
      <input name="date" type="hidden" value="">
      <input name="time" type="hidden" value="">
      <p id="lineTrialError" class="hidden text-sm font-black text-rose-600"></p>
      <div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">送入待處理</button></div>
    </form>
  </div>`);
  $("lineTrialForm").onsubmit = async (event) => {
    event.preventDefault();
    const ok = await createLineTrialRequest(event.currentTarget);
    if (ok) closeModal();
  };
}

function appointmentQueryBoardHtml(dateKey, queryTime = "") {
  const total = SCHEDULE_WINDOW_END - SCHEDULE_WINDOW_START;
  const queryNorm = normalizedQueryMinute(queryTime);
  const queryPercent = queryNorm === null ? null : ((queryNorm - SCHEDULE_WINDOW_START) / total) * 100;
  const todayPercent = dateKey === todayKey() ? currentTimelinePercent() : null;
  const dayAppts = Object.values(db.appointments).filter((a) => a.date === dateKey).sort(sortByTime);
  const working = Object.entries(db.therapists).map(([id, therapist]) => ({
    id,
    name: therapistName(id),
    shift: (db.schedules[id] || {})[dateKey] || "休假"
  })).filter((row) => isWorking(row.shift)).sort((a, b) => a.shift.localeCompare(b.shift));
  if (!working.length) return `<div class="rounded-xl bg-white py-12 text-center font-bold text-slate-400">當日無排班</div>`;
  const axis = ["11:00", "14:00", "17:00", "20:00", "23:00", "02:00"].map((label, index) => `<span class="absolute -translate-x-1/2" style="left:${(index / 5) * 100}%">${label}</span>`).join("");
  return `<div class="card p-5 appointment-time-board">
    <div class="mb-4 flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
      <div><h3 class="font-black">當日師傅時段</h3><p class="text-xs font-bold text-slate-500">綠色為上班時段，橘色為已有預約；點綠色空檔可新增預約，點橘色預約可修改紀錄。</p></div>
      <div class="flex flex-wrap gap-2 text-xs font-black text-slate-500"><span class="badge bg-teal-50 text-teal-700">上班</span><span class="badge bg-amber-50 text-amber-700">已有預約</span>${queryTime ? `<span class="badge bg-indigo-50 text-indigo-700">查詢 ${esc(queryTime)}</span>` : ""}</div>
    </div>
    <div class="space-y-3">
      <div class="appointment-time-head grid grid-cols-[116px_1fr_92px] gap-3 px-1 text-[10px] font-black text-slate-400">
        <span>按摩師</span><div class="relative h-5">${axis}</div><span class="text-right">狀態</span>
      </div>
      ${working.map((row) => {
        const mine = dayAppts.filter((a) => a.therapistId === row.id);
        const busy = mine.find((appt) => appointmentCoversMinute(appt, queryNorm));
        const inShift = isMinuteInShift(row.shift, queryNorm);
        const status = queryNorm === null ? `${mine.length} 筆預約` : (busy ? "已預約" : (inShift ? "可預約" : "未上班"));
        const statusClass = busy ? "bg-amber-50 text-amber-700" : inShift ? "bg-teal-50 text-teal-700" : "bg-slate-100 text-slate-500";
        const shiftBlocks = parseShiftSegments(row.shift).map((seg) => {
          const start = normalizedTimelineMinute(seg.start);
          const end = normalizedTimelineMinute(seg.end);
          const left = Math.max(0, Math.min(total, start - SCHEDULE_WINDOW_START));
          const right = Math.max(0, Math.min(total, end - SCHEDULE_WINDOW_START));
          if (right <= 0 || left >= total) return "";
          const width = Math.max(3, right - left);
          const addTime = queryNorm !== null && queryNorm >= start && queryNorm < end ? queryTime : minsToTime(start);
          return `<button class="absolute top-1 h-9 rounded-lg border border-teal-200 bg-teal-100/70 transition hover:bg-teal-200" data-add-appointment data-therapist="${esc(row.id)}" data-date="${esc(dateKey)}" data-time="${esc(addTime)}" title="新增預約 ${esc(row.name)} ${esc(addTime)}" style="left:${(left / total) * 100}%;width:${(width / total) * 100}%"></button>`;
        }).join("");
        const appointmentBlocks = mine.map((appt) => {
          const start = normalizedTimelineMinute(timeToMinutes(appt.time));
          const end = start + Number(appt.duration || 60);
          const left = Math.max(0, Math.min(total, start - SCHEDULE_WINDOW_START));
          const right = Math.max(0, Math.min(total, end - SCHEDULE_WINDOW_START));
          if (right <= 0 || left >= total) return "";
          const width = Math.max(4, right - left);
          return `<button class="absolute top-2 z-10 h-7 overflow-hidden rounded-md border border-amber-300 bg-amber-100 px-2 text-left text-[10px] font-black text-amber-900 shadow-sm transition hover:bg-amber-200" data-open-appt="${esc(appt.id)}" title="${esc(appt.time)} ${esc(customerDisplay(appt.phone, appt.customerName))}" style="left:${(left / total) * 100}%;width:${(width / total) * 100}%"><span class="truncate">${esc(appt.time)} ${esc(customerDisplay(appt.phone, appt.customerName))}</span></button>`;
        }).join("");
        const queryLine = queryPercent === null || queryPercent < 0 || queryPercent > 100 ? "" : `<span class="absolute -top-1 bottom-0 z-20 w-px bg-indigo-500" style="left:${queryPercent}%"><span class="absolute -top-5 -translate-x-1/2 rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-black text-white">${esc(queryTime)}</span></span>`;
        const nowLine = todayPercent === null ? "" : `<span class="absolute -top-1 bottom-0 z-20 w-px bg-rose-500" style="left:${todayPercent}%"></span>`;
        return `<div class="appointment-time-row grid grid-cols-[116px_1fr_92px] items-center gap-3 rounded-xl border border-slate-100 bg-white p-3">
          <div class="appointment-time-person"><p class="truncate text-sm font-black">${esc(row.name)}</p><p class="text-[10px] font-bold text-teal-700">${esc(row.shift)}</p></div>
          <div class="appointment-time-track relative h-11 rounded-xl bg-slate-100">${shiftBlocks}${appointmentBlocks}${nowLine}${queryLine}</div>
          <div class="appointment-time-status text-right"><span class="badge ${statusClass}">${status}</span></div>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function doorPasswordRecordHtml() {
  const records = db.customers.SYS_DOOR_PWD?.records || [];
  return records.length ? records.slice().map(normalizeAuditRecord).reverse().map((r) => `<tr><td class="font-mono font-black">${esc(backupLabelTime(auditTimestamp(r)) || "舊紀錄未記錄")}</td><td class="font-black">${esc(auditField(r, ["value", "password", "code", "doorPassword"]))}</td><td>${esc(auditField(r, ["reason", "source", "type"]))}</td></tr>`).join("") : `<tr><td colspan="3" class="py-8 text-center font-bold text-slate-400">尚無修改紀錄</td></tr>`;
}

function hydrateResponsiveTables(root = document) {
  root.querySelectorAll(".table-wrap table").forEach((table) => {
    if (table.querySelector("#scheduleHeader")) return;
    const headers = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
    if (!headers.length) return;
    table.closest(".table-wrap")?.classList.add("mobile-card-table");
    table.querySelectorAll("tbody tr").forEach((row) => {
      const cells = Array.from(row.children);
      cells.forEach((cell, index) => {
        if (!cell.hasAttribute("colspan")) cell.dataset.label = headers[index] || "";
      });
      hydrateLayeredTableRow(row, headers);
    });
  });
}

function centerTodayInDateScroll(root = document) {
  const today = todayKey();
  root.querySelectorAll(`[data-date-key="${today}"]`).forEach((node) => {
    const scroller = node.closest("[data-date-scroll], .table-wrap, .overflow-x-auto");
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
    const left = node.offsetLeft - (scroller.clientWidth / 2) + (node.clientWidth / 2);
    scroller.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  });
}

function hydrateLayeredTableRow(row, headers) {
  if (row.dataset.layeredReady === "true") return;
  const cells = Array.from(row.children).filter((cell) => cell.tagName === "TD");
  if (cells.length < 5 || cells.some((cell) => cell.hasAttribute("colspan"))) return;

  const textOf = (cell) => cell.innerText.replace(/\s+/g, " ").trim();
  const actionHeader = /操作|管理|動作|處理|刪除|編輯/;
  const summaryItems = cells.slice(0, 3).map((cell, index) => ({
    label: headers[index] || "",
    value: textOf(cell)
  })).filter((item) => item.value);

  if (!summaryItems.length) return;

  row.dataset.layeredReady = "true";
  row.classList.add("is-layered-row");

  cells.forEach((cell, index) => {
    const label = headers[index] || "";
    const isAction = actionHeader.test(label) || cell.querySelector("button,a,input,select");
    cell.classList.add(isAction ? "mobile-action-cell" : "mobile-detail-cell");
  });

  const summaryCell = document.createElement("td");
  summaryCell.className = "mobile-row-summary";
  summaryCell.colSpan = cells.length;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "mobile-row-summary-button";
  button.setAttribute("aria-expanded", "false");

  const textWrap = document.createElement("span");
  textWrap.className = "mobile-row-summary-text";

  const title = document.createElement("strong");
  title.textContent = summaryItems[0].value;
  textWrap.appendChild(title);

  const meta = document.createElement("span");
  meta.textContent = summaryItems.slice(1).map((item) => `${item.label} ${item.value}`.trim()).join(" / ");
  textWrap.appendChild(meta);

  const toggle = document.createElement("span");
  toggle.className = "mobile-row-summary-toggle";
  toggle.textContent = "詳細";

  button.appendChild(textWrap);
  button.appendChild(toggle);
  summaryCell.appendChild(button);
  row.insertBefore(summaryCell, row.firstChild);

  button.addEventListener("click", () => {
    const expanded = row.classList.toggle("is-expanded");
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.textContent = expanded ? "收合" : "詳細";
  });
}

function responsiveTableHtml(headers, rowsHtml, emptyColspan, extraClass = "") {
  const headerHtml = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  responsiveTableHtml._cellIndex = 0;
  const labeledRows = String(rowsHtml || "").replace(/<td(?![^>]*colspan)([^>]*)>/g, (match, attrs = "") => {
    const index = responsiveTableHtml._cellIndex || 0;
    const label = headers[index % headers.length] || "";
    responsiveTableHtml._cellIndex = index + 1;
    return `<td${attrs} data-label="${esc(label)}">`;
  });
  responsiveTableHtml._cellIndex = 0;
  return `<div class="table-wrap mobile-card-table ${extraClass}"><table><thead><tr>${headerHtml}</tr></thead><tbody>${labeledRows || `<tr><td colspan="${emptyColspan || headers.length}" class="py-10 text-center font-bold text-slate-400">無資料</td></tr>`}</tbody></table></div>`;
}

function collapsibleCardHtml({ title, desc = "", badge = "", body = "", open = true, className = "" }) {
  return `<details class="collapsible-card card ${className}" ${open ? "open" : ""}>
    <summary>
      <span>
        <span class="collapsible-title">${esc(title)}</span>
        ${desc ? `<span class="collapsible-desc">${esc(desc)}</span>` : ""}
      </span>
      <span class="flex items-center gap-2">${badge || ""}<span class="collapsible-chevron">⌄</span></span>
    </summary>
    <div class="collapsible-body">${body}</div>
  </details>`;
}

function navItemHtml(item, attr = "data-tab") {
  const activeClass = item.tab === activeTab ? " active" : "";
  return `<button type="button" ${attr}="${esc(item.tab)}" class="nav-btn${activeClass}">${iconHtml(item.icon || "circle")}<span>${esc(item.label)}</span></button>`;
}

function tabTitle(tab) {
  return [...ADMIN_NAV_ITEMS, ...THERAPIST_NAV_ITEMS].find((item) => item.tab === tab)?.title || "管理中樞";
}

function renderAppShellNavigation() {
  const adminNav = $("adminNav");
  if (adminNav) {
    const primary = ADMIN_NAV_ITEMS.filter((item) => item.tab !== "system");
    const system = ADMIN_NAV_ITEMS.filter((item) => item.tab === "system");
    adminNav.innerHTML = `<p class="nav-section-label">營運</p>${primary.map((item) => navItemHtml(item)).join("")}<p class="nav-section-label nav-section-system">系統</p>${system.map((item) => navItemHtml(item)).join("")}`;
  }
  const therapistNav = $("therapistNav");
  if (therapistNav) {
    therapistNav.innerHTML = `<p class="px-2 py-2 text-xs font-black uppercase tracking-widest text-slate-500">師傅專屬中樞</p>${THERAPIST_NAV_ITEMS.map((item) => navItemHtml(item)).join("")}`;
  }
  const mobileNav = $("mobileBottomNav");
  if (mobileNav) mobileNav.innerHTML = ADMIN_NAV_ITEMS.map((item) => navItemHtml(item, "data-mobile-tab")).join("");
  refreshIcons();
}

function closestFromEvent(event, selector) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  return target?.closest(selector) || null;
}

function renderAll() {
  generateMonthData();
  renderOverview();
  renderDispatch();
  renderCustomers();
  renderPersonnel();
  renderReport();
  renderSystem();
  renderPortal();
  hydrateResponsiveTables();
  refreshIcons();
}

function focusDispatchTarget() {
  const panel = {
    query: "query",
    board: "tasks",
    records: "records"
  }[pendingDispatchFocus];
  if (panel && activeDispatchPanel !== panel) {
    activeDispatchPanel = panel;
    renderAppointmentDetail();
  }
  const targetId = {
    query: "appointmentQueryPanel",
    records: "appointmentRecordsPanel",
    board: "bookingStageBoard"
  }[pendingDispatchFocus];
  if (!targetId) return;
  const focusMode = pendingDispatchFocus;
  pendingDispatchFocus = "";
  requestAnimationFrame(() => {
    const target = $(targetId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    if (focusMode === "query") {
      setTimeout(() => $("appointmentTime")?.focus({ preventScroll: true }), 180);
    }
  });
}

function syncStatusText() {
  const meta = effectiveSyncMeta();
  if (meta.pending) return "還沒同步";
  if (!meta.lastSync) return "還沒更新過";
  const date = new Date(meta.lastSync);
  if (Number.isNaN(date.getTime())) return "還沒更新過";
  return `已更新 ${date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

async function ensureCloudSyncMeta(reason = "登入後讀取雲端資料") {
  if (effectiveSyncMeta().lastSync) return false;
  await writeCloudSyncMeta(reason);
  return true;
}

async function refreshDashboardData() {
  const buttons = [$("refreshOverviewBtn"), $("systemRefreshDataBtn")].filter(Boolean);
  buttons.forEach((button) => {
    button.disabled = true;
    button.dataset.originalHtml = button.innerHTML;
    button.textContent = "更新中...";
  });
  showSnackbar("正在重新讀取雲端資料...");
  try {
    const synced = await tryCloudSync({ force: true });
    if (!synced) {
      showSnackbar("雲端資料讀取失敗，畫面維持原資料");
    } else {
      await writeCloudSyncMeta("重新同步資料");
      renderAll();
      showSnackbar("資料已從雲端更新");
    }
  } catch {
    showSnackbar("現在暫時讀不到雲端，請稍後再試");
  }
  buttons.forEach((button) => {
    if (!button.isConnected) return;
    button.disabled = false;
    button.innerHTML = button.dataset.originalHtml || "更新資料";
  });
  refreshIcons();
}

function syncMobileBottomNav() {
  const nav = $("mobileBottomNav");
  if (!nav) return;
  const isAdminView = currentUser?.role === "admin";
  nav.classList.toggle("hidden", !isAdminView);
  nav.querySelectorAll("[data-mobile-tab]").forEach((button) => {
    const isActive = button.dataset.mobileTab === activeTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });
}

function switchTab(tab, options = {}) {
  if (tab === "schedule") {
    activePersonnelPanel = "schedule";
    tab = "personnel";
  }
  if (tab === "filter" || tab === "appointment") tab = "dispatch";
  if (tab === "appointmentDetail") tab = "dispatch";
  if (tab === "dispatch" && options.clearAppointment) activeAppointmentId = null;
  if (tab === "dispatch" && options.focus) {
    pendingDispatchFocus = options.focus;
    activeDispatchPanel = options.focus === "board" ? "tasks" : options.focus;
  } else if (tab === "dispatch" && options.clearAppointment) {
    activeDispatchPanel = "query";
  }
  activeTab = tab;
  document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
  $(`view-${tab}`)?.classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    if (btn.dataset.tab) btn.setAttribute("aria-current", isActive ? "page" : "false");
  });
  syncMobileBottomNav();
  $("pageTitle").textContent = tabTitle(tab);
  hideSidebar();
  if ($("mainContent")) $("mainContent").scrollTop = 0;
  renderAll();
  if (tab === "dispatch") focusDispatchTarget();
}

function showSidebar() {
  $("adminSidebar").classList.remove("-translate-x-full");
  $("sidebarOverlay").classList.remove("hidden");
}

function hideSidebar() {
  if (window.innerWidth < 1024) {
    $("adminSidebar").classList.add("-translate-x-full");
    $("sidebarOverlay").classList.add("hidden");
  }
}

function renderOverview() {
  const today = todayKey();
  const appts = Object.values(db.appointments);
  const todayAppts = appts.filter((a) => a.date === today).sort(sortByTime);
  const pendingApprovals = approvalsList("pending");
  const now = new Date();
  const currentMins = now.getHours() * 60 + now.getMinutes();
  const todayRevenue = todayAppts.reduce((s, a) => s + Number(a.price || 0), 0);
  const todayCompanyCut = todayAppts.reduce((s, a) => s + remittanceDueFor(a), 0);
  const todayCompanyPaid = todayAppts.reduce((s, a) => s + (isRemittancePaid(a) ? remittanceDueFor(a) : 0), 0);
  const finishedToday = todayAppts.filter((a) => String(a.isCompleted) === "true").length;
  const ongoing = todayAppts.filter((a) => currentMins >= timeToMinutes(a.time) && currentMins < timeToMinutes(a.time) + Number(a.duration || 60));
  const upcoming = todayAppts.filter((a) => timeToMinutes(a.time) >= currentMins).slice(0, 4);
  const upcomingAll = todayAppts.filter((a) => timeToMinutes(a.time) >= currentMins);
  const nextAppt = upcoming[0];
  const todayConfirmed = todayAppts.filter(isBookingConfirmed);
  const todayUnconfirmed = todayAppts.filter(isBookingUnconfirmed);
  const todayPreNoticeDone = todayAppts.filter((a) => ["pre_notice", "completed"].includes(a.bookingStage));
  const todayPendingSelections = clientSelectionList("pending").filter((selection) => selection.date === today);
  const needsCollection = appts.filter((a) => String(a.isCompleted) === "true" && !String(a.collectedPrice || "").trim()).slice(0, 5);
  const noRecordNotes = appts.filter((a) => {
    const record = appointmentRecord(a);
    return String(a.isCompleted) === "true" && !String(record?.notes || "").trim();
  }).slice(0, 5);
  const preNoticeDue = todayAppts.filter((a) => {
    const minsUntil = timeToMinutes(a.time) - currentMins;
    return minsUntil >= 0 && minsUntil <= 30 && !["pre_notice", "completed"].includes(a.bookingStage);
  }).slice(0, 5);
  const todayFlowRows = todayAppts.length ? todayAppts.map((a) => {
    const start = timeToMinutes(a.time);
    const end = start + Number(a.duration || 60);
    const status = String(a.isCompleted) === "true" ? "已完成" : (currentMins >= start && currentMins < end ? "進行中" : (start > currentMins ? "待開始" : "待回報"));
    const statusClass = status === "進行中" ? "bg-teal-600 text-white" : status === "待回報" ? "bg-rose-100 text-rose-700" : status === "已完成" ? "bg-slate-200 text-slate-600" : "bg-amber-100 text-amber-700";
    return `<button data-open-appt="${esc(a.id)}" class="overview-flow-row">
      <span class="overview-flow-time"><strong>${esc(a.time)}</strong><small>${minsToTime(end)}</small></span>
      <span class="overview-flow-customer"><strong>${esc(customerDisplay(a.phone, a.customerName))}</strong>${a.notes ? `<small>備註：${esc(a.notes)}</small>` : `<small>${esc(a.phone || "未留聯絡方式")}</small>`}</span>
      <span class="overview-flow-meta"><strong>${esc(therapistName(a.therapistId))}</strong><small>負責師傅</small></span>
      <span class="overview-flow-meta"><strong>${esc(courseName(a.service))}</strong><small>${roomBadge(a.room)}</small></span>
      <span class="overview-flow-status"><span class="badge ${bookingStageClass(a.bookingStage)}">${esc(bookingStageLabel(a.bookingStage))}</span><span class="badge ${statusClass}">${status}</span></span>
      <span class="overview-flow-amount"><strong>${money(a.price)}</strong><small>${isRemittancePaid(a) ? "已回帳" : "待核對"}</small></span>
      ${iconHtml("chevron-right", "overview-flow-arrow")}
    </button>`;
  }).join("") : `<div class="overview-empty-state">${iconHtml("calendar-check-2")}<strong>今日尚無預約</strong><span>可從預約系統建立第一筆行程</span><button class="btn-teal" data-jump-tab="dispatch">新增預約</button></div>`;
  const todayLabel = new Date(`${today}T00:00:00`).toLocaleDateString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const queueItems = [
    {
      icon: "clipboard-check", tone: "amber", title: "待審核", count: pendingApprovals.length,
      detail: pendingApprovals[0] ? `${therapistName(pendingApprovals[0].therapistId)} · ${approvalTypeLabel(pendingApprovals[0].type)}` : "目前沒有待審核申請",
      attrs: `data-jump-tab="personnel" data-personnel-panel="approvals"`
    },
    {
      icon: "badge-check", tone: "blue", title: "預約待確認", count: todayUnconfirmed.length + todayPendingSelections.length,
      detail: `${todayUnconfirmed.length} 筆未確認 · ${todayPendingSelections.length} 筆客選`,
      attrs: `data-jump-tab="dispatch" data-dispatch-focus="board"`
    },
    {
      icon: "send", tone: "violet", title: "行前通知", count: preNoticeDue.length,
      detail: preNoticeDue[0] ? `${preNoticeDue[0].time} · ${therapistName(preNoticeDue[0].therapistId)}` : "目前沒有待通知行程",
      attrs: `data-jump-tab="dispatch" data-dispatch-focus="board"`
    },
    {
      icon: "circle-dollar-sign", tone: "coral", title: "回款與紀錄", count: needsCollection.length + noRecordNotes.length,
      detail: `${needsCollection.length} 筆未回款 · ${noRecordNotes.length} 筆缺紀錄`,
      attrs: `data-jump-tab="report" data-report-panel="commission"`
    }
  ];
  const queueHtml = queueItems.map((item) => `<button class="ops-queue-row ${item.count ? "" : "is-clear"}" ${item.attrs}>
    <span class="ops-queue-icon tone-${item.tone}">${iconHtml(item.icon)}</span>
    <span class="ops-queue-copy"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></span>
    <span class="ops-queue-count tone-${item.tone}">${item.count}</span>
    ${iconHtml("chevron-right", "ops-queue-arrow")}
  </button>`).join("");
  $("view-overview").innerHTML = `
    <div class="ops-dashboard">
      <section class="ops-command-bar">
        <div class="ops-command-date">
          <span class="ops-eyebrow">${iconHtml("activity")} 今日營運</span>
          <h3>${esc(todayLabel)}</h3>
          <p id="overviewSyncStatus">${syncStatusText()}</p>
        </div>
        <div class="ops-next-action">
          <span>下一個行動</span>
          <strong>${nextAppt ? `${nextAppt.time} · ${customerDisplay(nextAppt.phone, nextAppt.customerName)}` : (pendingApprovals[0] ? `${therapistName(pendingApprovals[0].therapistId)} · ${approvalTypeLabel(pendingApprovals[0].type)}` : "今日營運已整理完成")}</strong>
          <small>${nextAppt ? `${therapistName(nextAppt.therapistId)} · ${courseName(nextAppt.service)}` : (pendingApprovals.length ? `待審核 ${pendingApprovals.length} 筆` : "目前沒有後續預約")}</small>
        </div>
        <div class="ops-command-actions">
          <button class="btn-teal" data-jump-tab="dispatch">${iconHtml("calendar-plus")}<span>預約系統</span></button>
          <button id="businessSummaryBtn" class="btn-light">${iconHtml("chart-no-axes-combined")}<span>營業總表</span></button>
          <button id="refreshOverviewBtn" class="btn-light">${iconHtml("refresh-cw")}<span>更新資料</span></button>
        </div>
      </section>

      <section class="ops-kpi-grid" aria-label="今日營運指標">
        <article class="ops-kpi-card tone-teal"><span class="ops-kpi-icon">${iconHtml("calendar-days")}</span><div><p>今日預約</p><strong>${todayAppts.length}</strong><small>完成 ${finishedToday} 筆 · 未確認 ${todayUnconfirmed.length}</small></div></article>
        <article class="ops-kpi-card tone-blue"><span class="ops-kpi-icon">${iconHtml("activity")}</span><div><p>現場狀態</p><strong>${ongoing.length}</strong><small>${ongoing[0] ? `進行中 ${customerDisplay(ongoing[0].phone, ongoing[0].customerName)}` : (nextAppt ? `下一筆 ${nextAppt.time}` : "目前空檔")}</small></div></article>
        <article class="ops-kpi-card tone-emerald"><span class="ops-kpi-icon">${iconHtml("badge-dollar-sign")}</span><div><p>今日營收</p><strong>${money(todayRevenue)}</strong><small>平均 ${money(todayAppts.length ? Math.round(todayRevenue / todayAppts.length) : 0)}</small></div></article>
        <article class="ops-kpi-card tone-slate"><span class="ops-kpi-icon">${iconHtml("wallet-cards")}</span><div><p>今日應回帳</p><strong>${money(todayCompanyCut)}</strong><small>已回帳 ${money(todayCompanyPaid)} · 未回帳 ${money(Math.max(0, todayCompanyCut - todayCompanyPaid))}</small></div></article>
      </section>

      <div class="ops-workspace-grid">
        <section class="ops-panel ops-schedule-panel">
          <header class="ops-panel-header"><div><span class="ops-section-kicker">人力調度</span><h3>當日排班</h3><p>11:00 到隔日 02:00，紅線標示目前時間</p></div><div class="flex items-center gap-2"><span class="badge bg-teal-50 text-teal-700">${Object.keys(db.therapists).filter((id) => isWorking((db.schedules[id] || {})[today])).length} 人</span><button class="btn-light px-3 py-2 text-xs" data-jump-tab="personnel" data-personnel-panel="schedule">完整班表</button></div></header>
          <div class="ops-panel-body">${dailyScheduleBoardHtml(today)}</div>
        </section>

        <aside class="ops-side-stack">
          <section class="ops-panel ops-queue-panel">
            <header class="ops-panel-header"><div><span class="ops-section-kicker">下一步</span><h3>待處理</h3><p>依序完成今天還需要跟進的工作</p></div></header>
            <div class="ops-queue-list">${queueHtml}</div>
          </section>
          <section class="ops-panel ops-door-panel">
            <header class="ops-panel-header"><div><span class="ops-section-kicker">店務工具</span><h3>大門密碼</h3></div><span id="liveClock" class="ops-live-clock"></span></header>
            <div class="ops-door-controls"><input id="doorPassword" class="input" value="${esc(db.customers.SYS_DOOR_PWD?.notes || "")}" aria-label="大門密碼"><button id="randomDoorBtn" class="btn-light">${iconHtml("dices")}<span>隨機</span></button><button id="doorHistoryBtn" class="btn-light">${iconHtml("history")}<span>紀錄</span></button><button id="saveDoorBtn" class="btn-teal">${iconHtml("save")}<span>儲存</span></button></div>
          </section>
        </aside>
      </div>

      <section class="ops-panel ops-flow-panel">
        <header class="ops-panel-header"><div><span class="ops-section-kicker">服務進度</span><h3>今日流程</h3><p>點選任一筆即可查看、修改與推進狀態</p></div><button class="btn-light px-3 py-2 text-xs" data-jump-tab="dispatch" data-dispatch-focus="records">查看完整清單</button></header>
        <div class="overview-flow-head"><span>時間</span><span>顧客</span><span>師傅</span><span>服務</span><span>狀態</span><span>金額</span><span></span></div>
        <div class="overview-flow-list">${todayFlowRows}</div>
      </section>
    </div>
    `;
  $("saveDoorBtn").onclick = async () => {
    const snapshot = snapshotDatabase();
    const previous = db.customers.SYS_DOOR_PWD || { name: "設定", notes: "", records: [] };
    const nextValue = $("doorPassword").value.trim();
    const records = previous.records || [];
    if (nextValue && nextValue !== previous.notes) {
      records.push({ at: new Date().toLocaleString("zh-TW", { hour12: false }), value: nextValue, reason: "手動更新" });
    }
    db.customers.SYS_DOOR_PWD = { name: "設定", notes: nextValue, records };
    const saved = await saveCloudActions([{ action: "saveCustomer", data: { phone: "SYS_DOOR_PWD", ...db.customers.SYS_DOOR_PWD } }], "大門密碼已更新到雲端");
    if (!saved) {
      restoreDatabase(snapshot, "大門密碼未獲雲端確認，已還原");
      $("doorPassword").value = snapshot.customers?.SYS_DOOR_PWD?.notes || "";
    }
  };
  $("randomDoorBtn").onclick = async () => {
    const snapshot = snapshotDatabase();
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    $("doorPassword").value = code;
    const previous = db.customers.SYS_DOOR_PWD || { name: "設定", notes: "", records: [] };
    const records = previous.records || [];
    records.push({ at: new Date().toLocaleString("zh-TW", { hour12: false }), value: code, reason: "隨機四碼" });
    db.customers.SYS_DOOR_PWD = { name: "設定", notes: code, records };
    const saved = await saveCloudActions([{ action: "saveCustomer", data: { phone: "SYS_DOOR_PWD", ...db.customers.SYS_DOOR_PWD } }], "已產生並儲存隨機大門密碼");
    if (!saved) {
      restoreDatabase(snapshot, "隨機密碼未獲雲端確認，已還原");
      $("doorPassword").value = snapshot.customers?.SYS_DOOR_PWD?.notes || "";
    }
  };
  $("doorHistoryBtn").onclick = () => {
    showModal(`<div class="modal max-w-2xl"><h3 class="mb-5 border-b pb-4 text-xl font-black">大門密碼修改紀錄</h3><div class="table-wrap"><table><thead><tr><th>時間</th><th>密碼</th><th>來源</th></tr></thead><tbody>${doorPasswordRecordHtml()}</tbody></table></div><div class="mt-5 flex justify-end border-t pt-4"><button class="btn-light" data-close-modal>關閉</button></div></div>`);
  };
  $("view-overview").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
  $("businessSummaryBtn").onclick = () => openDailyBusinessSummary();
  $("refreshOverviewBtn").onclick = refreshDashboardData;
  renderLiveStatus();
}

function renderLiveStatus() {
  const rows = $("liveStatusRows");
  const clock = $("liveClock");
  if (!rows && !clock) return;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  if (clock) clock.textContent = `目前時間 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const nowPercent = currentTimelinePercent();
  document.querySelectorAll(".schedule-now-line").forEach((line) => {
    line.classList.toggle("hidden", nowPercent === null);
    if (nowPercent !== null) line.style.left = `${nowPercent}%`;
  });
  if (!rows) return;
  const visible = Object.values(db.appointments).filter((a) => a.date === todayKey()).sort(sortByTime);
  rows.innerHTML = visible.length ? visible.map((a) => {
    const start = timeToMinutes(a.time);
    const end = start + Number(a.duration || 60);
    const ongoing = current >= start && current <= end;
    const completed = String(a.isCompleted) === "true";
    const status = completed ? "已完成" : (ongoing ? `進行中，剩餘 ${end - current} 分` : (start > current ? `待開始，${start - current} 分後` : "待回報"));
    const statusClass = completed ? "text-slate-500" : (ongoing ? "text-teal-700" : (start > current ? "text-amber-700" : "text-rose-700"));
    return `<tr><td><div class="font-mono font-black">${esc(a.time || "--:--")}</div><div class="mt-1">${roomBadge(a.room)}</div></td><td class="font-black text-teal-700">${esc(therapistName(a.therapistId))}</td><td><button class="text-left font-black text-slate-900 hover:text-teal-700" data-open-appt="${esc(a.id)}">${esc(customerDisplay(a.phone, a.customerName))}</button><div class="text-xs text-slate-500">${esc(courseName(a.service))}</div></td><td class="font-mono font-black">${minsToTime(end)}</td><td class="text-right font-black ${statusClass}">${status}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="py-8 text-center font-bold text-slate-400">今日尚無預約</td></tr>`;
  rows.querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
}

function appointmentCandidateStripHtml(date, time, service) {
  if (!time) return "";
  const course = COURSE_CATALOG[service] || {};
  const candidates = availableTherapistCandidates({ date, time, service, duration: course.duration || 120, limit: 6 });
  return `<div id="appointmentCandidateStrip" class="card dispatch-candidate-panel border-teal-100 bg-teal-50/40 p-5">
    <div class="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
      <div><span class="ops-section-kicker">02 · 選擇處理方式</span><h3 class="mt-2 text-lg font-black">找到 ${candidates.length} 位可接師傅</h3><p class="mt-1 text-xs font-bold text-slate-500">${esc(date)} ${esc(time)} · ${esc(courseName(service))}</p></div>
      ${candidates.length ? `<button id="clientSelectionFromResultsBtn" class="btn-light shrink-0">${iconHtml("users")}<span>挑選師傅給客人</span></button>` : ""}
    </div>
    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      ${candidates.length ? candidates.map(({ id, profile, shift }) => `<article class="rounded-2xl border border-teal-100 bg-white p-4">
        <div class="flex gap-3">
          ${therapistPhotoHtml(profile, therapistName(id))}
          <div class="min-w-0">
            <h4 class="truncate font-black">${esc(therapistName(id))}</h4>
            <p class="mt-1 text-xs font-bold text-teal-700">${esc(shift)}</p>
            <p class="mt-1 text-xs font-bold text-slate-500">${esc(therapistDisplayMeta(profile) || "基本資料待補")}</p>
          </div>
        </div>
        <p class="mt-3 line-clamp-2 min-h-10 text-xs font-bold text-slate-500">${esc(profile.specialties || profile.bio || "尚未填寫專長介紹")}</p>
        <button class="mt-3 w-full rounded-xl bg-teal-600 px-3 py-2 text-sm font-black text-white hover:bg-teal-700" data-add-appointment data-therapist="${esc(id)}" data-date="${esc(date)}" data-time="${esc(time)}">直接建立預約</button>
      </article>`).join("") : `<div class="rounded-2xl border border-dashed border-teal-200 bg-white py-10 text-center text-sm font-bold text-slate-500 md:col-span-2 xl:col-span-3"><p class="font-black text-slate-700">目前沒有完全符合的師傅</p><p class="mt-1">請調整時間或課程，或展開下方完整班表查看其他空檔。</p></div>`}
    </div>
  </div>`;
}

function appointmentQueryPanelHtml() {
  const selectedDate = $("appointmentDate")?.value || dispatchQueryState.date || todayKey();
  const selectedTime = queryTimeLabel($("appointmentTime")?.value || dispatchQueryState.time || "");
  const selectedService = $("appointmentService")?.value || dispatchQueryState.service || "C120";
  dispatchQueryState = { date: selectedDate, time: selectedTime, service: selectedService };
  const serviceOptions = Object.entries(COURSE_CATALOG).map(([key, course]) => `<option value="${key}" ${selectedService === key ? "selected" : ""}>${esc(course.name)}</option>`).join("");
  return `
    <div id="appointmentQueryPanel" class="card dispatch-query-card scroll-mt-20 p-5">
      <div class="flex flex-col gap-5">
        <div class="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
          <div>
            <span class="ops-section-kicker">01 · 輸入需求</span>
            <h3 class="mt-2 text-xl font-black">客人想預約什麼時間？</h3>
            <p class="mt-1 text-sm font-bold text-slate-500">填寫日期、時間與課程後，下一步再選擇直接建立或傳給客人挑選。</p>
          </div>
          <div id="dispatchQueryStatus" class="dispatch-query-status">${selectedTime ? `${iconHtml("check-circle-2")} 可從下方選擇師傅` : `${iconHtml("clock-3")} 請先輸入時間`}</div>
        </div>
        <div class="grid gap-3 lg:grid-cols-[1fr_1fr_1.2fr_auto] lg:items-end">
          <div><label class="label">日期</label><input id="appointmentDate" type="date" class="input py-2" value="${selectedDate}"></div>
          <div><label class="label">時間</label><input id="appointmentTime" type="time" class="input py-2" value="${esc(selectedTime)}"></div>
          <div><label class="label">服務</label><select id="appointmentService" class="input py-2">${serviceOptions}</select></div>
          <button id="queryAppointmentBtn" class="btn-primary px-5 py-3">${iconHtml("search")}<span>尋找可接師傅</span></button>
        </div>
      </div>
    </div>
    ${appointmentCandidateStripHtml(selectedDate, selectedTime, selectedService)}
    <details id="dispatchScheduleDetails" class="card collapsible-card dispatch-schedule-details" ${selectedTime ? "" : "open"}>
      <summary><span><span class="collapsible-title">查看完整班表與房型</span><span class="collapsible-desc">找不到合適人選時再展開；綠色空檔可新增，橘色預約可修改。</span></span><span class="collapsible-chevron">⌄</span></summary>
      <div class="collapsible-body">
        <div class="mb-4 flex justify-end"><div class="flex rounded-xl bg-slate-100 p-1"><button id="apptCardBtn" class="rounded-lg px-4 py-2 text-sm font-black">師傅時段</button><button id="apptTimelineBtn" class="rounded-lg px-4 py-2 text-sm font-black">房型時程</button></div></div>
        <div id="appointmentBoard" class="space-y-5"></div>
        <div id="appointmentTimeline" class="hidden overflow-x-auto"></div>
      </div>
    </details>`;
}

function bindAppointmentQueryControls() {
  if (!$("appointmentDate") || !$("appointmentBoard") || !$("appointmentTimeline")) return;
  const getDate = () => $("appointmentDate").value || todayKey();
  const getTime = () => queryTimeLabel($("appointmentTime")?.value || "");
  const getService = () => $("appointmentService")?.value || "C120";
  const selectedDate = getDate();
  const selectedTime = getTime();
  const captureQueryState = () => {
    dispatchQueryState = { date: getDate(), time: getTime(), service: getService() };
  };
  const markQueryChanged = () => {
    captureQueryState();
    activeAppointmentView = "card";
    const candidateStrip = $("appointmentCandidateStrip");
    if (candidateStrip) candidateStrip.classList.add("hidden");
    const status = $("dispatchQueryStatus");
    if (status) status.innerHTML = `${iconHtml("circle-alert")} 需求已變更，請重新尋找`;
    renderAppointmentBoard(getDate(), getTime());
    refreshIcons();
  };
  $("appointmentDate").onchange = markQueryChanged;
  $("appointmentTime").onchange = markQueryChanged;
  $("appointmentService").onchange = markQueryChanged;
  $("queryAppointmentBtn").onclick = () => {
    captureQueryState();
    if (!getTime()) {
      showSnackbar("請先輸入預約時間");
      $("appointmentTime").focus();
      return;
    }
    renderDispatch();
  };
  const clientSelectionButton = $("clientSelectionFromResultsBtn");
  if (clientSelectionButton) clientSelectionButton.onclick = () => openClientSelectionLinkModal(getDate(), getTime(), getService());
  $("apptCardBtn").onclick = () => { activeAppointmentView = "card"; renderAppointmentBoard(getDate(), getTime()); };
  $("apptTimelineBtn").onclick = () => { activeAppointmentView = "timeline"; renderAppointmentBoard(getDate(), getTime()); };
  renderAppointmentBoard(selectedDate, selectedTime);
}

function renderAppointment() {
  const section = $("view-appointment");
  if (!section) return;
  section.innerHTML = appointmentQueryPanelHtml();
  bindAppointmentQueryControls();
}

function renderAppointmentBoard(date, queryTime = "") {
  if (!$("appointmentBoard") || !$("appointmentTimeline")) return;
  $("appointmentBoard").classList.toggle("hidden", activeAppointmentView !== "card");
  $("appointmentTimeline").classList.toggle("hidden", activeAppointmentView !== "timeline");
  $("apptCardBtn").className = activeAppointmentView === "card" ? "rounded-lg bg-white px-4 py-2 text-sm font-black text-teal-700 shadow" : "rounded-lg px-4 py-2 text-sm font-black text-slate-500";
  $("apptTimelineBtn").className = activeAppointmentView === "timeline" ? "rounded-lg bg-white px-4 py-2 text-sm font-black text-teal-700 shadow" : "rounded-lg px-4 py-2 text-sm font-black text-slate-500";
  const appts = Object.values(db.appointments).filter((a) => a.date === date).sort(sortByTime);
  const board = $("appointmentBoard");
  board.innerHTML = appointmentQueryBoardHtml(date, queryTime);
  board.querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
  renderTimeline(date, appts);
}

function openClientSelectionLinkModal(date, time, service) {
  if (!date || !time) {
    showSnackbar("請先選擇日期與時間");
    return;
  }
  const course = COURSE_CATALOG[service] || {};
  const candidates = availableTherapistCandidates({ date, time, service, duration: course.duration || 120, limit: Infinity });
  showModal(`<div class="modal max-w-3xl">
    <div class="mb-5 border-b pb-4">
      <h3 class="text-xl font-black">產生客選分享連結</h3>
      <p class="mt-1 text-sm font-bold text-slate-500">${esc(date)} ${esc(time)} · ${esc(courseName(service))} · 勾選要讓客人看到的師傅</p>
    </div>
    <div id="clientSelectionLinkBox" class="hidden rounded-2xl border border-teal-200 bg-teal-50 p-4">
      <div class="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <div><p class="text-sm font-black text-teal-900">連結已產生</p><p class="text-xs font-bold text-teal-700">下一步：複製給客人，等客人送出選擇後再到預約系統確認。</p></div>
        <span id="clientSelectionLinkStatus" class="badge bg-white text-teal-700">可分享</span>
      </div>
      <div class="flex flex-col gap-2 sm:flex-row">
        <input id="clientSelectionUrlInput" class="input bg-white text-sm" readonly value="">
        <button id="copyClientSelectionUrlBtn" class="btn-teal shrink-0">複製連結</button>
        <button id="previewClientSelectionUrlBtn" class="btn-light shrink-0">預覽</button>
      </div>
    </div>
    <div class="mt-5 flex flex-col justify-between gap-3 rounded-xl border bg-white p-4 sm:flex-row sm:items-center">
      <div><p class="font-black">可接師傅名單</p><p class="text-xs font-bold text-slate-500">客人頁只會顯示你勾選的人；客人不會看到當日筆數。</p></div>
      <div class="flex items-center gap-2">
        <span id="clientSelectionPickedCount" class="badge bg-teal-50 text-teal-700">已選 0 / ${candidates.length}</span>
        <button id="clearClientSelectionCandidatesBtn" class="btn-light px-3 py-2 text-xs">清空</button>
      </div>
    </div>
    <div class="mt-3 max-h-[52vh] overflow-y-auto pr-1">
      <div class="grid gap-3 md:grid-cols-2">
        ${candidates.length ? candidates.map(({ id, profile, shift }) => `<label class="block cursor-pointer rounded-xl border bg-white p-4 transition hover:border-teal-200 hover:bg-teal-50/40" data-client-selection-card="${esc(id)}">
          <div class="flex gap-3">
            <input type="checkbox" class="mt-1 h-5 w-5 shrink-0 accent-teal-600" data-client-selection-candidate value="${esc(id)}">
            ${therapistPhotoHtml(profile, therapistName(id))}
            <div class="min-w-0">
              <h4 class="truncate font-black">${esc(therapistName(id))}</h4>
              <p class="mt-1 text-xs font-bold text-teal-700">${esc(shift)}</p>
              <p class="mt-1 text-xs font-bold text-slate-500">${esc(therapistDisplayMeta(profile) || "基本資料未完整")}</p>
            </div>
          </div>
          <p class="mt-3 line-clamp-3 text-sm font-bold text-slate-600">${esc(profile.bio || profile.specialties || "尚未填寫介紹詞")}</p>
          <div class="mt-3 flex flex-wrap gap-2 text-xs font-black"><span class="badge bg-teal-50 text-teal-700">可接</span><span class="badge bg-slate-100 text-slate-600">會出現在客選頁</span></div>
        </label>`).join("") : `<div class="md:col-span-2 rounded-xl border border-dashed bg-white py-10 text-center font-bold text-slate-400">此時段沒有可接師傅，請改時間或課程。</div>`}
      </div>
    </div>
    <p id="clientSelectionPickError" class="mt-3 hidden text-sm font-black text-rose-600"></p>
    <div class="mt-5 flex flex-col-reverse justify-end gap-3 border-t pt-4 sm:flex-row">
      <button class="btn-light" data-close-modal>關閉</button>
      <button id="buildClientSelectionUrlBtn" class="btn-teal" ${candidates.length ? "" : "disabled"}>產生分享連結</button>
    </div>
  </div>`);
  const selectedIds = () => Array.from(document.querySelectorAll("[data-client-selection-candidate]:checked")).map((input) => input.value);
  const refreshPickedState = () => {
    const picked = new Set(selectedIds());
    $("clientSelectionPickedCount").textContent = `已選 ${picked.size} / ${candidates.length}`;
    $("buildClientSelectionUrlBtn").disabled = !picked.size;
    document.querySelectorAll("[data-client-selection-card]").forEach((card) => {
      card.classList.toggle("border-teal-500", picked.has(card.dataset.clientSelectionCard));
      card.classList.toggle("bg-teal-50", picked.has(card.dataset.clientSelectionCard));
    });
    $("clientSelectionPickError").classList.add("hidden");
  };
  document.querySelectorAll("[data-client-selection-candidate]").forEach((input) => input.onchange = refreshPickedState);
  $("clearClientSelectionCandidatesBtn").onclick = () => {
    document.querySelectorAll("[data-client-selection-candidate]").forEach((input) => { input.checked = false; });
    $("clientSelectionLinkBox").classList.add("hidden");
    refreshPickedState();
  };
  $("buildClientSelectionUrlBtn").onclick = async () => {
    const picked = selectedIds();
    if (!picked.length) {
      $("clientSelectionPickError").textContent = "請至少勾選一位師傅。";
      $("clientSelectionPickError").classList.remove("hidden");
      return;
    }
    const button = $("buildClientSelectionUrlBtn");
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = "產生中...";
    try {
      const url = await createClientSelectionLink(date, time, service, picked);
      $("clientSelectionUrlInput").value = url;
      $("clientSelectionLinkBox").classList.remove("hidden");
      $("clientSelectionUrlInput").select();
      $("clientSelectionLinkStatus").textContent = `已選 ${picked.length} 位`;
      await copyText(url, "客選連結已產生並複製");
      button.dataset.originalText = "重新產生連結";
    } catch (error) {
      console.error("Client selection link creation failed", error);
      $("clientSelectionPickError").textContent = "客選連結產生失敗，請重新選擇師傅後再試。";
      $("clientSelectionPickError").classList.remove("hidden");
    } finally {
      button.disabled = false;
      button.textContent = button.dataset.originalText || "產生分享連結";
    }
  };
  $("copyClientSelectionUrlBtn").onclick = async () => {
    const input = $("clientSelectionUrlInput");
    if (!input.value) return;
    input.select();
    await copyText(input.value, "客選連結已複製");
  };
  $("previewClientSelectionUrlBtn").onclick = () => {
    const input = $("clientSelectionUrlInput");
    if (input.value) window.open(input.value, "_blank", "noopener");
  };
  refreshPickedState();
}

function apptCard(a) {
  const customerCount = Object.values(db.appointments).filter((x) => x.phone === a.phone).length;
  return `<div class="relative rounded-xl border bg-white p-4 shadow-sm">
    <div class="mb-2 flex items-start justify-between gap-2"><button data-open-appt="${esc(a.id)}" class="text-left text-lg font-black hover:text-teal-700">${esc(a.time)} <span class="text-xs text-slate-400">(${a.duration}m)</span></button>${roomBadge(a.room)}</div>
    <button data-open-appt="${esc(a.id)}" class="mb-2 block text-left font-black hover:text-teal-700">${esc(customerDisplay(a.phone, a.customerName))} <span class="badge ${customerCount <= 1 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}">${customerCount <= 1 ? "新客" : "熟客"}</span></button>
    <div class="flex items-end justify-between gap-2"><span class="rounded-lg bg-slate-100 px-2 py-1 text-xs font-black text-slate-600">${esc(courseName(a.service))}</span><span class="font-black text-rose-600">${money(a.price)}</span></div>
    <div class="mt-3 flex justify-end gap-2"><button data-edit-appt="${esc(a.id)}" class="btn-light px-3 py-1 text-xs">詳細資訊</button><button data-delete-appt="${esc(a.id)}" class="rounded-lg bg-rose-50 px-3 py-1 text-xs font-black text-rose-700">刪除</button></div>
  </div>`;
}

function renderTimeline(date, appts) {
  const container = $("appointmentTimeline");
  const rooms = ["R", "T", "OUT"];
  const startHour = SCHEDULE_WINDOW_START / 60;
  const endHour = SCHEDULE_WINDOW_END / 60;
  const pxPerMinute = 1.55;
  const height = (endHour - startHour) * 60 * pxPerMinute;
  const nowPercent = currentTimelinePercent();
  const nowTop = nowPercent === null ? null : 48 + (nowPercent / 100) * height;
  let html = `<div class="card flex min-w-[900px] overflow-hidden"><div class="relative w-20 shrink-0 border-r bg-slate-50" style="height:${height + 48}px"><div class="sticky top-0 z-10 h-12 border-b bg-slate-100 p-3 text-center text-xs font-black">時間</div>`;
  for (let h = startHour; h <= endHour; h++) {
    const top = 48 + (h - startHour) * 60 * pxPerMinute;
    html += `<div class="absolute left-0 right-0 border-t text-right text-xs font-black text-slate-500" style="top:${top}px"><span class="mr-2 -translate-y-2 inline-block">${String(h % 24).padStart(2, "0")}:00</span></div>`;
  }
  if (nowTop !== null) html += `<div class="absolute left-0 right-0 z-20 border-t-2 border-rose-500" style="top:${nowTop}px"><span class="ml-1 -translate-y-1/2 rounded bg-rose-500 px-1.5 py-0.5 text-[10px] font-black text-white">現在</span></div>`;
  html += `</div>`;
  rooms.forEach((room) => {
    html += `<div class="timeline-grid relative min-w-[260px] flex-1 border-r" style="height:${height + 48}px"><div class="sticky top-0 z-10 h-12 border-b bg-white p-3 text-center text-sm font-black">${room === "OUT" ? "外出" : `${room}房`}</div>`;
    if (nowTop !== null) html += `<div class="absolute left-0 right-0 z-10 border-t-2 border-rose-500/70" style="top:${nowTop}px"></div>`;
    appts.filter((a) => a.room === room).forEach((a) => {
      const top = 48 + (normalizedTimelineMinute(timeToMinutes(a.time)) - startHour * 60) * pxPerMinute;
      const blockHeight = Math.max(Number(a.duration || 60) * pxPerMinute - 3, 44);
      if (top < 48 || top > height + 48) return;
      html += `<button class="timeline-block block text-left ${room === "R" ? "border-amber-300 bg-amber-50" : room === "T" ? "border-cyan-300 bg-cyan-50" : "border-rose-300 bg-rose-50"}" data-open-appt="${esc(a.id)}" style="top:${top}px;height:${blockHeight}px">
        <div class="px-3 py-2 text-xs font-black">${esc(a.time)} ${esc(therapistName(a.therapistId))}</div>
        <div class="px-3 text-sm font-black">${esc(customerDisplay(a.phone, a.customerName))}</div>
        <div class="px-3 text-xs text-slate-600">${esc(courseName(a.service))}</div>
      </button>`;
    });
    html += `</div>`;
  });
  container.innerHTML = html + `</div>`;
  container.querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
}

function roomBadge(room) {
  const map = { R: "border-amber-200 bg-amber-50 text-amber-800", T: "border-cyan-200 bg-cyan-50 text-cyan-800", OUT: "border-rose-200 bg-rose-50 text-rose-700" };
  return `<span class="badge ${map[room] || "bg-slate-100 text-slate-600"}">${room === "OUT" ? "外出" : `${esc(room || "-")}房`}</span>`;
}

function suggestedRoomFor({ date, time, duration = 60, service = "", excludeId = "" }) {
  if (String(service || "").startsWith("OUT")) return "OUT";
  if (!date || !time) return "R";
  const start = normalizedTimelineMinute(timeToMinutes(time));
  const end = start + Number(duration || 60) + 10;
  const taken = Object.values(db.appointments).filter((a) => a.date === date && a.id !== excludeId);
  const isAvailable = (room) => !taken.some((a) => {
    if (a.room !== room) return false;
    const apptStart = normalizedTimelineMinute(timeToMinutes(a.time));
    const apptEnd = apptStart + Number(a.duration || 60) + 10;
    return start < apptEnd && end > apptStart;
  });
  if (isAvailable("R")) return "R";
  if (isAvailable("T")) return "T";
  return "R";
}

function openAppointmentModal({ therapistId, date, appointmentId, time = "", service = "", phone = "", customerName = "", notes = "", bookingStage = "", selectionId = "" }) {
  editingAppointmentId = appointmentId || null;
  pendingClientSelectionId = selectionId || null;
  const existing = appointmentId ? db.appointments[appointmentId] : null;
  const selectedTherapist = existing?.therapistId || therapistId;
  const selectedDate = existing?.date || date || $("appointmentDate")?.value || todayKey();
  const selectedService = existing?.service || service || "";
  const selectedCourse = COURSE_CATALOG[selectedService] || {};
  const selectedStage = existing?.bookingStage || bookingStage || "confirmed";
  const serviceOptions = [`<option value="">自訂/其他項目</option>`].concat(Object.entries(COURSE_CATALOG).map(([k, c]) => `<option value="${k}" ${selectedService === k ? "selected" : ""}>${esc(c.name)} (${money(c.price)})</option>`)).join("");
  showModal(`
    <div class="modal max-w-xl">
      <h3 class="mb-5 border-b pb-4 text-xl font-black">${existing ? "修改預約" : "新增顧客預約"} <span class="ml-2 rounded-lg bg-teal-50 px-2 py-1 text-sm text-teal-700">${esc(selectedDate)}</span></h3>
      <form id="apptForm" class="space-y-4">
        <div><label class="label">指定按摩師</label><select name="therapistId" class="input">${Object.keys(db.therapists).map((id) => `<option value="${id}" ${id === selectedTherapist ? "selected" : ""}>${esc(therapistName(id))}</option>`).join("")}</select></div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div><label class="label">服務課程</label><select name="service" class="input">${serviceOptions}</select></div>
          <div><label class="label">應收金額</label><input name="price" type="number" class="input" value="${esc(existing?.price || selectedCourse.price || "")}"></div>
          <div><label class="label">預約時間</label><input name="time" type="time" class="input" value="${esc(existing?.time || time || "")}"></div>
          <div><label class="label">預估時長</label><input name="duration" type="number" min="10" step="10" class="input" value="${esc(existing?.duration || selectedCourse.duration || 60)}"></div>
        </div>
        <div><label class="label">工作室安排</label><select name="room" class="input"><option value="R">Royal (R房)</option><option value="T">Tiffany (T房)</option><option value="OUT">外出</option></select><p id="roomHint" class="mt-2 hidden rounded-lg p-2 text-xs font-black"></p></div>
        <div><label class="label">預約進度</label><select name="bookingStage" class="input">${bookingStageOptions(selectedStage)}</select></div>
        <div><label class="label">聯絡方式</label><input name="phone" class="input" value="${esc(existing?.phone || phone || "")}"></div>
        <div><label class="label">顧客姓名 <span class="text-slate-400">(選填)</span></label><input name="customerName" class="input" value="${esc(existing?.customerName || customerName || "")}" placeholder="未填則顯示顧客編碼"></div>
        <div><label class="label">備註</label><textarea name="notes" class="input min-h-24" placeholder="例如：客人偏好、特殊需求、櫃檯交接事項">${esc(existing?.notes || notes || "")}</textarea></div>
        <p id="apptError" class="hidden text-sm font-black text-rose-600"></p>
        <div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">${existing ? "更新預約" : "儲存預約"}</button></div>
      </form>
  </div>`);
  const form = $("apptForm");
  form.room.value = existing?.room || suggestedRoomFor({ date: selectedDate, time: existing?.time || time || "", duration: existing?.duration || selectedCourse.duration || 60, service: selectedService, excludeId: existing?.id || "" });
  form.service.value = selectedService;
  form.service.onchange = () => {
    const c = COURSE_CATALOG[form.service.value];
    if (!c) return;
    form.duration.value = c.duration;
    form.price.value = c.price;
    if (form.service.value.startsWith("OUT")) form.room.value = "OUT";
    else suggestRoom(form, selectedDate);
  };
  form.time.onchange = () => suggestRoom(form, selectedDate);
  form.duration.onchange = () => suggestRoom(form, selectedDate);
  form.phone.oninput = () => {
    const customer = db.customers[form.phone.value.trim()];
    if (customer && !form.customerName.value.trim()) form.customerName.value = customer.name;
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    saveAppointmentFromForm(form, selectedDate);
  };
}

function suggestRoom(form, date) {
  const hint = $("roomHint");
  if (!form.time.value || form.room.value === "OUT") return;
  const start = timeToMinutes(form.time.value);
  const end = start + Number(form.duration.value || 60) + 10;
  const taken = Object.values(db.appointments).filter((a) => a.date === date && a.id !== editingAppointmentId);
  const isAvailable = (room) => !taken.some((a) => a.room === room && start < timeToMinutes(a.time) + Number(a.duration || 60) + 10 && end > timeToMinutes(a.time));
  if (isAvailable("R")) {
    form.room.value = "R";
    hint.classList.add("hidden");
  } else if (isAvailable("T")) {
    form.room.value = "T";
    hint.textContent = "R房已有安排，已自動切換至T房。";
    hint.className = "mt-2 rounded-lg bg-amber-50 p-2 text-xs font-black text-amber-700";
  } else {
    hint.textContent = "R房與T房都可能衝突，儲存時會再次確認。";
    hint.className = "mt-2 rounded-lg bg-rose-50 p-2 text-xs font-black text-rose-700";
  }
}

async function saveAppointmentFromForm(form, date) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.id = editingAppointmentId || `APT-${Date.now().toString(36).toUpperCase()}`;
  data.appId = data.id;
  data.date = date;
  data.duration = Number(data.duration || 60);
  data.price = Number(data.price || 0);
  data.bookingStage = normalizeBookingStage(data.bookingStage || db.appointments[data.id]?.bookingStage || "confirmed", db.appointments[data.id] || {});
  data.isCompleted = data.bookingStage === "completed";
  data.collectedPrice = db.appointments[data.id]?.collectedPrice || "";
  data.selectionId = pendingClientSelectionId || db.appointments[data.id]?.selectionId || "";
  data.customerName = String(data.customerName || "").trim();
  data.phone = String(data.phone || "").trim();
  if (!data.time || !data.phone) {
    $("apptError").textContent = "時間與聯絡方式必填；顧客姓名可留空。";
    $("apptError").classList.remove("hidden");
    return;
  }
  const conflict = findAppointmentConflict(data);
  const commit = async () => {
    const snapshot = snapshotDatabase();
    setFormBusy(form, true);
    db.appointments[data.id] = data;
    const customer = db.customers[data.phone] || { name: data.customerName, notes: "", records: [] };
    customer.name = data.customerName;
    if (!customer.code) {
      db.customers[data.phone] = customer;
      assignCustomerCodes(db);
    }
    customer.records ||= [];
    const recordIndex = customer.records.findIndex((r) => r.id === data.id);
    const existingRecord = recordIndex >= 0 ? customer.records[recordIndex] : {};
    const record = { ...existingRecord, id: data.id, date: data.date, therapistId: data.therapistId, therapistName: therapistName(data.therapistId), service: data.service, notes: existingRecord.notes || "", collectedPrice: data.collectedPrice || existingRecord.collectedPrice || "" };
    if (recordIndex >= 0) customer.records[recordIndex] = record;
    else customer.records.push(record);
    db.customers[data.phone] = customer;
    const metaAction = syncAppointmentMeta(data);
    const actions = [
      { action: "addAppointment", data },
      { action: "saveCustomer", data: { phone: data.phone, ...customer } },
      metaAction
    ].filter(Boolean);
    if (pendingClientSelectionId && db.clientSelections[pendingClientSelectionId]) {
      const selection = {
        ...db.clientSelections[pendingClientSelectionId],
        status: "confirmed",
        appointmentId: data.id,
        updatedAt: new Date().toISOString()
      };
      db.clientSelections[selection.id] = selection;
      db.customers[clientSelectionKey(selection.id)] = {
        name: `confirmed-${selection.customerName || selection.customerContact || "客選"}-${therapistName(selection.selectedTherapistId)}`,
        notes: JSON.stringify(selection),
        records: []
      };
      actions.push({ action: "saveCustomer", data: { phone: clientSelectionKey(selection.id), ...db.customers[clientSelectionKey(selection.id)] } });
    }
    const saved = await saveCloudActions(actions, "預約已寫入雲端");
    setFormBusy(form, false);
    if (!saved) {
      restoreDatabase(snapshot, "預約未獲雲端確認，已還原");
      return;
    }
    pendingClientSelectionId = null;
    closeModal();
    renderAll();
  };
  if (conflict) {
    confirmAction("仍要儲存撞期預約？", conflict, commit, "強制儲存");
  } else {
    commit();
  }
}

function findAppointmentConflict(data) {
  const start = timeToMinutes(data.time);
  const end = start + Number(data.duration || 60);
  const sameDay = Object.values(db.appointments).filter((a) => a.date === data.date && a.id !== data.id);
  const therapist = sameDay.find((a) => a.therapistId === data.therapistId && start < timeToMinutes(a.time) + Number(a.duration || 60) && end > timeToMinutes(a.time));
  const room = data.room !== "OUT" && sameDay.find((a) => a.room === data.room && start < timeToMinutes(a.time) + Number(a.duration || 60) + 10 && end + 10 > timeToMinutes(a.time));
  if (!therapist && !room) return "";
  return `${therapist ? `師傅在 ${therapist.time} 已有預約。\n` : ""}${room ? `${data.room}房時段或10分鐘緩衝不足。` : ""}`;
}

async function deleteAppointment(id) {
  const snapshot = snapshotDatabase();
  try {
    const appt = db.appointments[id];
    delete db.appointments[id];
    if (appt && db.customers[appt.phone]?.records) db.customers[appt.phone].records = db.customers[appt.phone].records.filter((r) => r.id !== id);
    delete db.appointmentMeta?.[id];
    delete db.customers[appointmentMetaKey(id)];
    if (activeAppointmentId === id) activeAppointmentId = null;
    switchTab("dispatch", { clearAppointment: true });
    const actions = [
      { action: "deleteAppointment", data: { appId: id } },
      { action: "deleteCustomer", data: { phone: appointmentMetaKey(id) } }
    ];
    if (appt?.phone && db.customers[appt.phone]) actions.push({ action: "saveCustomer", data: { phone: appt.phone, ...db.customers[appt.phone] } });
    const synced = await saveCloudActions(actions, "預約已刪除", {
      verifyCloud: (cloudDb) => !cloudDb.appointments?.[id] && !cloudDb.customers?.[appointmentMetaKey(id)]
    });
    if (!synced) {
      restoreDatabase(snapshot, "刪除未獲雲端確認，已還原預約");
      markSyncPending(true, "delete-appointment-awaiting-sync");
      return;
    }
    renderAll();
  } catch (error) {
    console.error("deleteAppointment failed", error);
    restoreDatabase(snapshot, "刪除失敗，已還原預約");
    showSnackbar("刪除失敗，原預約已保留");
  }
}

async function updateAppointmentStage(id, stage) {
  const appt = db.appointments[id];
  if (!appt) return;
  const snapshot = snapshotDatabase();
  appt.bookingStage = normalizeBookingStage(stage, appt);
  appt.isCompleted = appt.bookingStage === "completed";
  const metaAction = syncAppointmentMeta(appt);
  const saved = await saveCloudActions([
    { action: "addAppointment", data: { ...appt, appId: id } },
    metaAction
  ].filter(Boolean), "預約進度已更新");
  if (!saved) {
    restoreDatabase(snapshot, "預約進度未獲雲端確認，已還原");
    return;
  }
  renderAll();
  if (activeAppointmentId === id) renderAppointmentDetail();
}

async function quickConfirmClientSelection(selectionId) {
  const selection = db.clientSelections[selectionId];
  if (!selection) return;
  const course = COURSE_CATALOG[selection.service] || {};
  const id = `APT-${Date.now().toString(36).toUpperCase()}`;
  const data = {
    id,
    appId: id,
    date: selection.date,
    time: selection.time,
    therapistId: selection.selectedTherapistId,
    service: selection.service || "",
    duration: Number(selection.duration || course.duration || 60),
    price: Number(course.price || 0),
    room: suggestedRoomFor({ date: selection.date, time: selection.time, duration: selection.duration || course.duration || 60, service: selection.service }),
    customerName: String(selection.customerName || "").trim(),
    phone: String(selection.customerContact || "").trim(),
    notes: String(selection.customerNote || "").trim(),
    bookingStage: "confirmed",
    isCompleted: false,
    collectedPrice: "",
    selectionId: selection.id
  };
  if (!data.phone) {
    showSnackbar("客選缺少聯絡方式，請用編輯建立補資料");
    return;
  }
  const conflict = findAppointmentConflict(data);
  const commit = async () => {
    const snapshot = snapshotDatabase();
    db.appointments[id] = data;
    const customer = db.customers[data.phone] || { name: data.customerName, notes: "", records: [] };
    customer.name = data.customerName;
    db.customers[data.phone] = customer;
    if (!customer.code) assignCustomerCodes(db);
    customer.records ||= [];
    customer.records.push({ id, date: data.date, therapistId: data.therapistId, therapistName: therapistName(data.therapistId), service: data.service, collectedPrice: "", notes: "" });
    const nextSelection = { ...selection, status: "confirmed", appointmentId: id, updatedAt: new Date().toISOString() };
    db.clientSelections[nextSelection.id] = nextSelection;
    db.customers[clientSelectionKey(nextSelection.id)] = {
      name: `confirmed-${nextSelection.customerName || nextSelection.customerContact || "客選"}-${therapistName(nextSelection.selectedTherapistId)}`,
      notes: JSON.stringify(nextSelection),
      records: []
    };
    const metaAction = syncAppointmentMeta(data);
    const saved = await saveCloudActions([
      { action: "addAppointment", data },
      { action: "saveCustomer", data: { phone: data.phone, ...customer } },
      { action: "saveCustomer", data: { phone: clientSelectionKey(nextSelection.id), ...db.customers[clientSelectionKey(nextSelection.id)] } },
      metaAction
    ].filter(Boolean), "已快速建立確認預約");
    if (!saved) {
      restoreDatabase(snapshot, "快速確認未獲雲端確認，已還原");
      return;
    }
    activeAppointmentId = null;
    switchTab("dispatch");
  };
  if (conflict) confirmAction("仍要快速確認？", conflict, commit, "確認建立");
  else commit();
}

function openAppointmentDetailPage(id) {
  activeAppointmentId = id || null;
  switchTab("dispatch");
}

function appointmentRecord(appt) {
  return db.customers[appt.phone]?.records?.find((r) => r.id === appt.id);
}

function renderDispatch() {
  renderAppointmentDetail();
}

function renderAppointmentDetail() {
  const section = $("view-dispatch") || $("appointmentDataPanel") || $("view-appointmentDetail");
  if (!section) return;
  const appts = Object.values(db.appointments).sort((a, b) => a.date === b.date ? sortByTime(a, b) : String(b.date).localeCompare(String(a.date)));
  if (activeAppointmentId && !db.appointments[activeAppointmentId]) activeAppointmentId = null;
  const active = activeAppointmentId ? db.appointments[activeAppointmentId] : null;
  section.innerHTML = active ? renderAppointmentDetailForm(active, appts) : renderAppointmentListPage(appts);
  bindAppointmentQueryControls();
  section.querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
  section.querySelectorAll("[data-delete-appt]").forEach((btn) => btn.onclick = () => confirmAction("刪除預約", "此動作會移除該筆預約與關聯紀錄。", () => deleteAppointment(btn.dataset.deleteAppt)));
  section.querySelectorAll("[data-dispatch-view]").forEach((btn) => btn.onclick = () => {
    if ($("appointmentDate")) {
      dispatchQueryState = {
        date: $("appointmentDate").value || todayKey(),
        time: queryTimeLabel($("appointmentTime")?.value || ""),
        service: $("appointmentService")?.value || "C120"
      };
    }
    activeDispatchPanel = btn.dataset.dispatchView;
    renderAppointmentDetail();
  });
  section.querySelectorAll("[data-workbench-focus]").forEach((btn) => btn.onclick = () => {
    pendingDispatchFocus = btn.dataset.workbenchFocus;
    activeDispatchPanel = pendingDispatchFocus === "board" ? "tasks" : pendingDispatchFocus;
    renderAppointmentDetail();
    focusDispatchTarget();
  });
  section.querySelectorAll("[data-create-from-selection]").forEach((btn) => btn.onclick = () => {
    const selection = db.clientSelections[btn.dataset.createFromSelection];
    if (!selection) return;
    openAppointmentModal({
      therapistId: selection.selectedTherapistId,
      date: selection.date,
      time: selection.time,
      service: selection.service,
      phone: selection.customerContact || "",
      customerName: selection.customerName || "",
      notes: selection.customerNote || "",
      bookingStage: "therapist_match",
      selectionId: selection.id
    });
  });
  section.querySelectorAll("[data-line-selection-query]").forEach((btn) => btn.onclick = () => {
    const selection = db.clientSelections[btn.dataset.lineSelectionQuery];
    if (!selection) return;
    openClientSelectionLinkModal(selection.date, selection.time, selection.service);
  });
  section.querySelectorAll("[data-reject-selection]").forEach((btn) => btn.onclick = () => {
    const selection = db.clientSelections[btn.dataset.rejectSelection];
    if (!selection) return;
    confirmAction("略過客選", "此筆客人選擇會標記為已略過，不會建立預約。", () => updateClientSelection(selection, "rejected"), "標記略過");
  });
  section.querySelectorAll("[data-quick-confirm-selection]").forEach((btn) => btn.onclick = () => {
    confirmAction("快速確認預約？", "系統會直接建立已確認預約，並自動帶入課程價格、時長與房型。需要調整細節時請改用「編輯建立」。", () => quickConfirmClientSelection(btn.dataset.quickConfirmSelection), "快速確認");
  });
  section.querySelectorAll("[data-mark-stage]").forEach((btn) => btn.onclick = () => updateAppointmentStage(btn.dataset.markStage, btn.dataset.stage));
  section.querySelectorAll("[data-copy-notice]").forEach((btn) => btn.onclick = async () => {
    const target = $(btn.dataset.copyNotice);
    if (!target) return;
    const label = btn.dataset.copyNotice === "customerNoticeText" ? "給顧客" : "給師傅";
    target.select();
    await copyText(target.value, `${label}通知已複製`);
  });
  const backBtn = $("backToAppointmentListBtn");
  if (backBtn) backBtn.onclick = () => { activeAppointmentId = null; renderAppointmentDetail(); };
  const cancelBtn = $("cancelAppointmentDetailBtn");
  if (cancelBtn) cancelBtn.onclick = () => { activeAppointmentId = null; renderAppointmentDetail(); };
  section.querySelectorAll("[data-toggle-appointment-scope]").forEach((btn) => btn.onclick = () => {
    appointmentRecordScope = appointmentRecordScope === "month" ? "today" : "month";
    renderAppointmentDetail();
    pendingDispatchFocus = "records";
    focusDispatchTarget();
  });
  const form = $("appointmentDetailForm");
  if (form) {
    form.service.onchange = () => {
      const course = COURSE_CATALOG[form.service.value];
      if (!course) return;
      form.duration.value = course.duration;
      form.price.value = course.price;
      if (form.service.value.startsWith("OUT")) form.room.value = "OUT";
    };
    form.phone.oninput = () => {
      const customer = db.customers[form.phone.value.trim()];
      if (customer && !form.customerName.value.trim()) form.customerName.value = customer.name;
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      saveAppointmentDetailForm(form);
    };
  }
  hydrateResponsiveTables(section);
  refreshIcons();
}

function bookingWorkbenchIntroHtml(monthAppts, pendingSelections) {
  const unconfirmed = monthAppts.filter(isBookingUnconfirmed).length;
  const tab = (key, icon, label, count = "") => `<button type="button" class="dispatch-view-tab ${activeDispatchPanel === key ? "active" : ""}" data-dispatch-view="${key}" aria-selected="${activeDispatchPanel === key}">${iconHtml(icon)}<span>${label}</span>${count !== "" ? `<b>${count}</b>` : ""}</button>`;
  return `<section class="card dispatch-command-bar">
    <div class="dispatch-command-main">
      <div>
        <span class="ops-section-kicker">預約系統</span>
        <h2>現在要處理哪一件事？</h2>
        <p>建立新預約、處理下一步，或查詢已建立的紀錄。</p>
      </div>
      <nav class="dispatch-view-tabs" aria-label="預約工作區">
        ${tab("query", "calendar-plus", "建立預約")}
        ${tab("tasks", "list-checks", "待處理", pendingSelections.length + unconfirmed)}
        ${tab("records", "history", "全部預約", monthAppts.length)}
      </nav>
    </div>
  </section>`;
}

function bookingCardHtml(appt, tone = "slate") {
  const toneClass = {
    amber: "border-amber-200 bg-amber-50",
    teal: "border-teal-200 bg-teal-50",
    violet: "border-violet-200 bg-violet-50",
    rose: "border-rose-200 bg-rose-50",
    slate: "border-slate-200 bg-white"
  }[tone] || "border-slate-200 bg-white";
  return `<button data-open-appt="${esc(appt.id)}" class="w-full rounded-xl border ${toneClass} p-3 text-left transition hover:border-teal-400 hover:bg-teal-50">
    <div class="flex items-start justify-between gap-3"><span class="font-mono text-sm font-black">${esc(appt.date)} ${esc(appt.time || "--:--")}</span><span class="badge ${bookingStageClass(appt.bookingStage)}">${esc(bookingStageLabel(appt.bookingStage))}</span></div>
    <div class="mt-2 font-black text-slate-900">${esc(customerDisplay(appt.phone, appt.customerName))}</div>
    <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-bold text-slate-500"><span>${esc(therapistName(appt.therapistId))}</span><span>${esc(courseName(appt.service))}</span><span>${appt.room === "OUT" ? "外出" : `${esc(appt.room || "-")}房`}</span><span>${money(appt.price)}</span></div>
    <div class="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs font-black text-slate-700">下一步：${esc(bookingNextAction(appt))}</div>
  </button>`;
}

function bookingStageBoardHtml(monthAppts) {
  const today = todayKey();
  const followupItems = monthAppts.filter((a) => a.bookingStage === "pre_notice" || (String(a.isCompleted) === "true" && (!String(a.collectedPrice || "").trim() || !String(appointmentRecord(a)?.notes || "").trim())));
  const lanes = [
    { title: "媒合 / 待確認", desc: "需要人員推進的預約", items: monthAppts.filter(isBookingUnconfirmed), tone: "amber", empty: "目前沒有未確認預約" },
    { title: "等待行前", desc: "已確認且不是今日的預約", items: monthAppts.filter((a) => a.bookingStage === "confirmed" && a.date !== today), tone: "teal", empty: "尚無等待行前的預約" },
    { title: "今日需通知", desc: "告知師傅房型與大門密碼", items: monthAppts.filter((a) => a.bookingStage === "confirmed" && a.date === today), tone: "violet", empty: "今日通知已完成或無預約" },
    { title: "待回報", desc: "補回款金額與服務紀錄", items: followupItems, tone: "slate", empty: "尚無回報待補" }
  ];
  return `<div id="bookingStageBoard" class="grid scroll-mt-20 gap-4 xl:grid-cols-4">
    ${lanes.map((lane) => `<section class="card p-4">
      <div class="mb-3 flex items-start justify-between gap-3"><div><h3 class="font-black">${lane.title}</h3><p class="text-xs font-bold text-slate-500">${lane.desc}</p></div><span class="badge bg-slate-100 text-slate-600">${lane.items.length}</span></div>
      <div class="space-y-2">${lane.items.slice(0, 6).map((appt) => bookingCardHtml(appt, lane.tone)).join("") || `<p class="rounded-xl bg-slate-50 p-4 text-center text-sm font-bold text-slate-400">${lane.empty}</p>`}</div>
    </section>`).join("")}
  </div>`;
}

function bookingNextAction(appt = {}) {
  const stage = normalizeBookingStage(appt.bookingStage, appt);
  if (stage === "inquiry") return "整理需求，查時段或給客選";
  if (stage === "candidate_sent") return "等待客人選擇師傅";
  if (stage === "therapist_match") return "確認師傅可接";
  if (stage === "customer_confirm") return "回覆顧客確認課程與金額";
  if (stage === "confirmed") return appt.date === todayKey() ? "行前通知師傅房型與密碼" : "等待行前通知";
  if (stage === "pre_notice") return "服務後補回款與紀錄";
  if (stage === "completed") {
    const record = appointmentRecord(appt) || {};
    if (!String(appt.collectedPrice || "").trim()) return "補實際回款";
    if (!String(record.notes || "").trim()) return "補服務紀錄";
    return "已完成";
  }
  return "檢查預約資料";
}

function bookingStageRailHtml(currentStage = "confirmed") {
  const activeIndex = Math.max(0, BOOKING_STAGES.findIndex((stage) => stage.key === currentStage));
  return `<div class="mb-5 rounded-2xl border bg-slate-50 p-4">
    <div class="grid gap-3 md:grid-cols-7">
      ${BOOKING_STAGES.map((stage, index) => {
        const done = index <= activeIndex;
        const active = stage.key === currentStage;
        return `<div class="flex items-center gap-2 md:block">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-black ${active ? "bg-teal-600 text-white" : done ? "bg-teal-100 text-teal-800" : "bg-slate-200 text-slate-500"}">${index + 1}</div>
          <p class="mt-0 text-xs font-black ${active ? "text-teal-700" : done ? "text-slate-700" : "text-slate-400"} md:mt-2">${stage.label}</p>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function therapistNoticeText(appt) {
  const remittanceDue = remittanceDueFor(appt);
  return [
    `預約通知`,
    `時間：${appointmentNoticeDateTime(appt)}`,
    `課程：${noticeCourseName(appt)}`,
    `應收金額：${money(appt.price)}`,
    `應回帳金額：${money(remittanceDue)}`
  ].filter(Boolean).join("\n");
}

function noticeCourseName(appt) {
  const base = courseName(appt.service);
  return base.replace(/(\d+)\s*分\b/g, "$1分鐘");
}

function appointmentNoticeDateTime(appt) {
  const date = normalizeDateField(appt.date || "");
  const parts = date.split("-");
  const dayText = parts.length === 3 ? `${parts[1]} / ${parts[2]}` : date;
  return `${dayText} ${appt.time || ""}`.trim();
}

function stableNoticeIndex(seed = "", length = 1) {
  const text = String(seed || "");
  let total = 0;
  for (let i = 0; i < text.length; i += 1) total += text.charCodeAt(i);
  return length ? total % length : 0;
}

function customerNoticeClosing(appt) {
  const closings = [
    "感謝您的預約，摩根SPA是您最優質的身體療癒第一選擇。",
    "感謝您的預約，摩根SPA期待為您帶來安心而細緻的身體療癒體驗。",
    "感謝您的預約，摩根SPA將用專業服務陪您好好放鬆、恢復狀態。",
    "感謝您的預約，摩根SPA很榮幸陪伴您享受一段舒適的療癒時光。"
  ];
  return closings[stableNoticeIndex(appt.id || appt.phone || appt.date, closings.length)];
}

function customerNoticeText(appt) {
  return [
    "預約成功",
    `師傅：${therapistName(appt.therapistId)}`,
    `時間：${appointmentNoticeDateTime(appt)}`,
    `課程：${noticeCourseName(appt)}`,
    `金額：${money(appt.price)}`,
    customerNoticeClosing(appt)
  ].join("\n");
}

function renderAppointmentListPage(appts) {
  const monthSet = new Set(monthDates.map((d) => d.key));
  const monthAppts = appts.filter((a) => monthSet.has(a.date));
  const pendingSelections = clientSelectionList("pending");
  const today = todayKey();
  const visibleAppts = appointmentRecordScope === "month" ? monthAppts : monthAppts.filter((a) => a.date === today);
  const visibleConfirmed = visibleAppts.filter(isBookingConfirmed);
  const visibleUnconfirmed = visibleAppts.filter(isBookingUnconfirmed);
  const visibleFollowup = visibleAppts.filter((a) => a.bookingStage === "pre_notice" || (String(a.isCompleted) === "true" && (!String(a.collectedPrice || "").trim() || !String(appointmentRecord(a)?.notes || "").trim())));
  const listTitle = appointmentRecordScope === "month" ? "完整預約清單" : "今日預約清單";
  const listDesc = appointmentRecordScope === "month" ? "目前顯示本月所有預約；可切回今日，避免日常操作資訊過多。" : "日常作業先看今日預約；需要核對時再展開本月完整清單。";
  const toggleText = appointmentRecordScope === "month" ? "只看今日" : "完整清單";
  const pendingSelectionPanel = pendingSelections.length ? `<div class="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-5">
    <div class="mb-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
      <div><h3 class="font-black text-amber-950">客選待確認</h3><p class="text-sm font-bold text-amber-800">客人已選師傅，但尚未正式建立預約。</p></div>
      <span class="badge bg-white text-amber-700">${pendingSelections.length} 筆</span>
    </div>
    <div class="grid gap-3 lg:grid-cols-2">
      ${pendingSelections.map((selection) => {
        const hasTherapist = Boolean(selection.selectedTherapistId);
        const profile = hasTherapist ? db.therapists[selection.selectedTherapistId] || {} : {};
        const displayName = hasTherapist ? therapistName(selection.selectedTherapistId) : "尚未媒合師傅";
        return `<article class="rounded-xl border border-amber-100 bg-white p-4">
          <div class="flex justify-between gap-4">
            <div class="flex min-w-0 gap-3">
              ${hasTherapist ? therapistPhotoHtml(profile, displayName) : `<div class="flex h-16 w-16 items-center justify-center rounded-xl bg-amber-50 text-xl font-black text-amber-700">?</div>`}
              <div class="min-w-0">
                <p class="text-xs font-black text-slate-400">${esc(selection.date)} ${esc(selection.time)} · ${esc(courseName(selection.service))}</p>
                <h4 class="mt-1 truncate font-black">${esc(displayName)}</h4>
                <p class="mt-1 text-sm font-bold text-slate-500">${esc(selection.customerName || "未留姓名")} ${selection.customerContact ? `｜${esc(selection.customerContact)}` : ""}</p>
                ${selection.source === "line-trial" ? `<p class="mt-2 line-clamp-2 text-xs font-bold text-amber-700">LINE訊息：${esc(selection.customerNote || "")}</p>` : ""}
              </div>
            </div>
            <span class="badge ${hasTherapist ? "bg-amber-50 text-amber-700" : "bg-indigo-50 text-indigo-700"}">${hasTherapist ? "待確認" : "待媒合"}</span>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            ${hasTherapist ? `<button class="btn-teal px-3 py-2 text-sm" data-quick-confirm-selection="${esc(selection.id)}">快速確認</button>` : `<button class="btn-teal px-3 py-2 text-sm" data-line-selection-query="${esc(selection.id)}">查可接師傅</button>`}
            <button class="btn-light px-3 py-2 text-sm" data-create-from-selection="${esc(selection.id)}">${hasTherapist ? "編輯建立" : "手動建立"}</button>
            <button class="rounded-xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-600" data-reject-selection="${esc(selection.id)}">略過</button>
          </div>
        </article>`;
      }).join("")}
    </div>
  </div>` : "";
  const rows = visibleAppts.length ? visibleAppts.map((a) => {
    const cut = COURSE_CATALOG[a.service]?.therapistCut || 0;
    return `<tr>
      <td><button data-open-appt="${esc(a.id)}" class="font-mono font-black text-teal-700 hover:text-teal-900">${esc(a.date)} ${esc(a.time)}</button><button data-open-appt="${esc(a.id)}" class="mt-1 block text-left font-black text-slate-900 hover:text-teal-700">${esc(customerDisplay(a.phone, a.customerName))}</button><div class="text-xs font-bold text-slate-400">${esc(a.phone || "")}</div></td>
      <td><div class="font-black">${esc(therapistName(a.therapistId))}</div><div class="mt-1 flex flex-wrap items-center gap-2 text-xs font-bold text-slate-500"><span>${esc(courseName(a.service))}</span>${roomBadge(a.room)}</div></td>
      <td><span class="badge ${bookingStageClass(a.bookingStage)}">${esc(bookingStageLabel(a.bookingStage))}</span><div class="mt-1 text-xs font-bold text-slate-500">${esc(bookingNextAction(a))}</div></td>
      <td class="text-right"><div class="font-black text-rose-600">${money(a.price)}</div><div class="mt-1 text-xs font-black text-teal-700">店收 ${money(Number(a.price || 0) - cut)}</div></td>
      <td class="text-right">
        <div class="flex justify-end gap-2">
          <button data-open-appt="${esc(a.id)}" class="btn-light px-3 py-1 text-xs">查看 / 修改</button>
          <button data-delete-appt="${esc(a.id)}" class="rounded-lg bg-rose-50 px-3 py-1 text-xs font-black text-rose-700">移除</button>
        </div>
      </td>
    </tr>`;
  }).join("") : `<tr><td colspan="5" class="py-10 text-center font-bold text-slate-400">${appointmentRecordScope === "month" ? "本月無預約資料" : "今日無預約資料"}</td></tr>`;
  const recordsPanel = `<div id="appointmentRecordsPanel" class="card scroll-mt-20 p-5">
    <div class="mb-5 flex flex-col justify-between gap-4 border-b pb-5 sm:flex-row sm:items-center">
      <div><h3 class="text-lg font-black">${listTitle}</h3><p class="text-sm font-bold text-slate-500">${listDesc}</p></div>
      <button class="btn-light" data-toggle-appointment-scope>${toggleText}</button>
    </div>
    <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
      ${metric(appointmentRecordScope === "month" ? "本月預約筆數" : "今日預約筆數", visibleAppts.length)}
      ${metric("未確認", visibleUnconfirmed.length, "text-amber-700")}
      ${metric("已確認", visibleConfirmed.length, "text-teal-700")}
      ${metric("待回報", visibleFollowup.length, "text-indigo-700")}
    </div>
    <div class="table-wrap mt-5"><table><thead><tr><th>時間 / 顧客</th><th>師傅 / 服務</th><th>進度 / 下一步</th><th class="text-right">金額</th><th class="text-right">操作</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
  const taskWorkspace = `<div class="dispatch-task-workspace">
    <div class="dispatch-section-heading"><div><span class="ops-section-kicker">今日作業</span><h3>依下一步處理待辦</h3><p>先完成客選確認，再依流程推進現有預約。</p></div><button class="btn-teal" data-dispatch-view="query">${iconHtml("plus")}<span>建立新預約</span></button></div>
    ${pendingSelectionPanel}
    ${bookingStageBoardHtml(monthAppts)}
  </div>`;
  const queryWorkspace = `<div class="dispatch-query-workspace">${appointmentQueryPanelHtml()}</div>`;
  const workspace = activeDispatchPanel === "tasks" ? taskWorkspace : activeDispatchPanel === "records" ? recordsPanel : queryWorkspace;
  return `${bookingWorkbenchIntroHtml(monthAppts, pendingSelections)}<div class="dispatch-workspace">${workspace}</div>`;
}

function renderAppointmentDetailForm(appt, allAppts) {
  const record = appointmentRecord(appt) || {};
  const cut = COURSE_CATALOG[appt.service]?.therapistCut || 0;
  const companyCut = Number(appt.price || 0) - cut;
  const therapistText = therapistNoticeText(appt);
  const customerText = customerNoticeText(appt);
  const sameCustomer = allAppts.filter((a) => a.phone && a.phone === appt.phone).length;
  const serviceOptions = [`<option value="">自訂/其他項目</option>`].concat(Object.entries(COURSE_CATALOG).map(([key, course]) => `<option value="${key}" ${appt.service === key ? "selected" : ""}>${esc(course.name)} (${money(course.price)})</option>`)).join("");
  return `<div class="grid gap-5 xl:grid-cols-[1fr_360px]">
    <form id="appointmentDetailForm" class="card p-5 appointment-detail-form">
      <div class="mb-5 flex flex-col justify-between gap-4 border-b pb-5 sm:flex-row sm:items-center">
        <div><p class="text-xs font-black uppercase tracking-widest text-slate-500">預約資料</p><h3 class="text-xl font-black">${esc(customerDisplay(appt.phone, appt.customerName))}</h3><p class="mt-1 text-xs font-bold text-slate-500">ID：${esc(appt.id)}</p><p class="mt-2 inline-flex rounded-full bg-teal-50 px-3 py-1 text-xs font-black text-teal-700">下一步：${esc(bookingNextAction(appt))}</p></div>
        <div class="flex gap-2"><button id="backToAppointmentListBtn" type="button" class="btn-light">返回清單</button><button data-delete-appt="${esc(appt.id)}" type="button" class="rounded-xl bg-rose-50 px-4 py-2 font-black text-rose-700">刪除</button></div>
      </div>
      ${bookingStageRailHtml(appt.bookingStage || "confirmed")}
      <div class="grid gap-4 md:grid-cols-2">
        <div><label class="label">預約日期</label><input name="date" type="date" class="input" value="${esc(appt.date || todayKey())}"></div>
        <div><label class="label">預約時間</label><input name="time" type="time" class="input" value="${esc(appt.time || "")}"></div>
        <div><label class="label">指定按摩師</label><select name="therapistId" class="input">${Object.keys(db.therapists).map((id) => `<option value="${esc(id)}" ${id === appt.therapistId ? "selected" : ""}>${esc(therapistName(id))}</option>`).join("")}</select></div>
        <div><label class="label">工作室安排</label><select name="room" class="input"><option value="R" ${appt.room === "R" ? "selected" : ""}>Royal (R房)</option><option value="T" ${appt.room === "T" ? "selected" : ""}>Tiffany (T房)</option><option value="OUT" ${appt.room === "OUT" ? "selected" : ""}>外出</option></select></div>
        <div><label class="label">預約進度</label><select name="bookingStage" class="input">${bookingStageOptions(appt.bookingStage || (String(appt.isCompleted) === "true" ? "completed" : "confirmed"))}</select></div>
        <div><label class="label">服務課程</label><select name="service" class="input">${serviceOptions}</select></div>
        <div><label class="label">預估時長</label><input name="duration" type="number" min="10" step="10" class="input" value="${esc(appt.duration || 60)}"></div>
        <div><label class="label">應收金額</label><input name="price" type="number" class="input" value="${esc(appt.price || 0)}"></div>
        <div><label class="label">實際回款</label><input name="collectedPrice" type="number" class="input" value="${esc(appt.collectedPrice || record.collectedPrice || "")}"></div>
        <div><label class="label">聯絡方式</label><input name="phone" class="input" value="${esc(appt.phone || "")}"></div>
        <div><label class="label">顧客姓名 <span class="text-slate-400">(選填)</span></label><input name="customerName" class="input" value="${esc(appt.customerName || "")}" placeholder="未填則顯示顧客編碼"></div>
        <div class="md:col-span-2"><label class="label">備註</label><textarea name="notes" class="input min-h-24" placeholder="例如：客人偏好、特殊需求、櫃檯交接事項">${esc(appt.notes || "")}</textarea></div>
        <label class="flex items-center gap-3 rounded-xl border p-4 font-black md:col-span-2"><input name="isCompleted" type="checkbox" ${String(appt.isCompleted) === "true" ? "checked" : ""}> 標記為已完成</label>
        <div class="md:col-span-2"><label class="label">服務紀錄 / 顧客反饋</label><textarea name="recordNotes" class="input min-h-28">${esc(record.notes || "")}</textarea></div>
      </div>
      <p id="appointmentDetailError" class="mt-4 hidden text-sm font-black text-rose-600"></p>
      <div class="appointment-detail-actions mt-5 flex justify-end gap-3 border-t pt-4"><button id="cancelAppointmentDetailBtn" type="button" class="btn-light">取消</button><button class="btn-teal">儲存預約資料</button></div>
    </form>
    <aside class="space-y-4">
      <div class="card p-5"><h4 class="mb-4 font-black">帳務摘要</h4><div class="space-y-3">${metric("應收金額", money(appt.price), "text-rose-700")}${metric("店家應收", money(companyCut), "text-teal-700")}${metric("師傅抽成", money(cut), "text-indigo-700")}</div></div>
      <div class="card p-5">
        <div class="mb-3 flex items-center justify-between gap-3"><h4 class="font-black">複製通知訊息</h4><span class="badge ${bookingStageClass(appt.bookingStage)}">${esc(bookingStageLabel(appt.bookingStage))}</span></div>
        <div class="space-y-2 rounded-xl bg-slate-50 p-4 text-sm font-bold text-slate-600">
          <p>師傅：<b class="text-slate-900">${esc(therapistName(appt.therapistId))}</b></p>
          <p>時間：<b class="text-slate-900">${esc(appt.date)} ${esc(appt.time)}</b></p>
          <p>房型：<b class="text-slate-900">${appt.room === "OUT" ? "外出" : `${esc(appt.room || "-")}房`}</b></p>
          <p>大門密碼：<b class="text-slate-900">${esc(db.customers.SYS_DOOR_PWD?.notes || "未設定")}</b></p>
          <p>課程：<b class="text-slate-900">${esc(courseName(appt.service))}</b></p>
          <p>應收：<b class="text-rose-700">${money(appt.price)}</b>，應回款：<b class="text-teal-700">${money(companyCut)}</b></p>
        </div>
        <div class="mt-4 space-y-4">
          <div class="rounded-xl border bg-white p-3">
            <div class="mb-2 flex items-center justify-between gap-3"><label class="label mb-0">給師傅</label><span class="badge bg-teal-50 text-teal-700">內部</span></div>
            <textarea id="therapistNoticeText" readonly class="input min-h-36 bg-slate-50 text-sm">${esc(therapistText)}</textarea>
            <button type="button" class="btn-light mt-2 w-full" data-copy-notice="therapistNoticeText">複製給師傅</button>
          </div>
          <div class="rounded-xl border bg-white p-3">
            <div class="mb-2 flex items-center justify-between gap-3"><label class="label mb-0">給顧客</label><span class="badge bg-indigo-50 text-indigo-700">客訊</span></div>
            <textarea id="customerNoticeText" readonly class="input min-h-40 bg-slate-50 text-sm">${esc(customerText)}</textarea>
            <button type="button" class="btn-light mt-2 w-full" data-copy-notice="customerNoticeText">複製給顧客</button>
          </div>
        </div>
        <div class="mt-3 grid grid-cols-1 gap-2">
          <button type="button" class="btn-teal" data-mark-stage="${esc(appt.id)}" data-stage="pre_notice">標記已通知</button>
        </div>
      </div>
      <div class="card p-5"><h4 class="mb-3 font-black">顧客摘要</h4><p class="font-black">${esc(customerDisplay(appt.phone, appt.customerName))}</p><p class="text-sm font-bold text-slate-500">${esc(appt.phone || "無聯絡方式")}</p><p class="mt-3 text-sm text-slate-600">累積預約：<b>${sameCustomer}</b> 筆</p><p class="mt-3 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm text-slate-600">${esc(db.customers[appt.phone]?.notes || "尚無顧客備註")}</p></div>
    </aside>
  </div>`;
}

async function saveAppointmentDetailForm(form) {
  const old = db.appointments[activeAppointmentId];
  if (!old) return;
  const data = Object.fromEntries(new FormData(form).entries());
  const next = {
    ...old,
    ...data,
    id: old.id,
    appId: old.id,
    duration: Number(data.duration || 60),
    price: Number(data.price || 0),
    bookingStage: normalizeBookingStage(data.bookingStage || old.bookingStage || "confirmed", old),
    isCompleted: data.isCompleted === "on" || data.bookingStage === "completed",
    collectedPrice: data.collectedPrice || "",
    phone: String(data.phone || "").trim(),
    customerName: String(data.customerName || "").trim(),
    notes: String(data.notes || "").trim()
  };
  const err = $("appointmentDetailError");
  if (next.isCompleted) next.bookingStage = "completed";
  if (!next.date || !next.time || !next.phone) {
    err.textContent = "日期、時間與聯絡方式必填；顧客姓名可留空。";
    err.classList.remove("hidden");
    return;
  }
  const commit = async () => {
    const snapshot = snapshotDatabase();
    setFormBusy(form, true);
    if (old.phone && old.phone !== next.phone && db.customers[old.phone]?.records) {
      db.customers[old.phone].records = db.customers[old.phone].records.filter((r) => r.id !== next.id);
    }
    db.appointments[next.id] = next;
    const customer = db.customers[next.phone] || { name: next.customerName, notes: "", records: [] };
    customer.name = next.customerName;
    if (!customer.code) {
      db.customers[next.phone] = customer;
      assignCustomerCodes(db);
    }
    customer.records ||= [];
    const idx = customer.records.findIndex((r) => r.id === next.id);
    const record = { id: next.id, date: next.date, therapistId: next.therapistId, therapistName: therapistName(next.therapistId), service: next.service, collectedPrice: next.collectedPrice, notes: data.recordNotes || "" };
    if (idx >= 0) customer.records[idx] = { ...customer.records[idx], ...record };
    else customer.records.push(record);
    db.customers[next.phone] = customer;
    const actions = [
      { action: "addAppointment", data: next },
      { action: "saveCustomer", data: { phone: next.phone, ...customer } },
      syncAppointmentMeta(next)
    ].filter(Boolean);
    if (old.phone && old.phone !== next.phone && db.customers[old.phone]) actions.push({ action: "saveCustomer", data: { phone: old.phone, ...db.customers[old.phone] } });
    const saved = await saveCloudActions(actions, "預約資料已寫入雲端");
    setFormBusy(form, false);
    if (!saved) {
      restoreDatabase(snapshot, "預約資料未獲雲端確認，已還原");
      return;
    }
    renderAll();
    activeAppointmentId = next.id;
    switchTab("dispatch");
  };
  const conflict = findAppointmentConflict(next);
  if (conflict) confirmAction("仍要儲存撞期預約？", conflict, commit, "強制儲存");
  else commit();
}

function renderCustomers() {
  $("view-customer").innerHTML = `
    <div class="card p-5">
      <div class="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div><h3 class="text-lg font-black">顧客資料庫 (CRM)</h3><p class="text-sm font-bold text-slate-500">熟客輪廓、偏好與消費歷程</p></div>
        <button id="addCustomerBtn" class="btn-teal">新增顧客檔案</button>
      </div>
      <div class="mb-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div class="relative">
          ${iconHtml("search", "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400")}
          <input id="customerSearchInput" class="input pl-10" placeholder="搜尋顧客編碼、姓名或聯絡方式">
        </div>
        <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:flex sm:items-center">
          <label class="sr-only" for="customerSortKey">排序依據</label>
          <select id="customerSortKey" class="input min-w-0 sm:w-44">
            <option value="code">顧客編號</option>
            <option value="visits">來店次數</option>
            <option value="spend">累積消費額</option>
          </select>
          <button id="customerSortDirection" type="button" class="btn-light inline-flex min-w-24 items-center justify-center gap-2" title="切換排序方向"></button>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>顧客編碼</th><th>聯絡方式</th><th>顧客姓名</th><th>來店次數</th><th>累積消費額</th><th>偏好備註</th><th class="text-right">操作</th></tr></thead><tbody id="customerRows"></tbody></table></div>
    </div>`;
  $("addCustomerBtn").onclick = () => openCustomerModal();
  $("customerSearchInput").oninput = drawCustomerRows;
  $("customerSortKey").value = customerSortState.key;
  $("customerSortKey").onchange = (event) => {
    customerSortState.key = event.currentTarget.value;
    customerSortState.direction = event.currentTarget.value === "code" ? "asc" : "desc";
    drawCustomerRows();
  };
  $("customerSortDirection").onclick = () => {
    customerSortState.direction = customerSortState.direction === "asc" ? "desc" : "asc";
    drawCustomerRows();
  };
  drawCustomerRows();
}

function drawCustomerRows() {
  const rows = $("customerRows");
  if (!rows) return;
  const q = ($("customerSearchInput")?.value || "").trim().toLowerCase();
  const appointmentsByPhone = Object.values(db.appointments).reduce((index, appointment) => {
    const phone = String(appointment.phone || "");
    if (phone) (index[phone] ||= []).push(appointment);
    return index;
  }, {});
  const customerCodeValue = (code = "") => {
    const numeric = String(code).match(/\d+/)?.[0];
    return numeric ? Number(numeric) : Number.MAX_SAFE_INTEGER;
  };
  const customers = Object.entries(db.customers)
    .filter(([phone, c]) => !isSystemCustomerKey(phone) && (!q || phone.toLowerCase().includes(q) || String(c.code || "").toLowerCase().includes(q) || String(c.name || "").toLowerCase().includes(q)))
    .map(([phone, customer]) => {
      const completed = (appointmentsByPhone[phone] || []).filter((appointment) => normalizeBookingStage(appointment.bookingStage, appointment) === "completed" || String(appointment.isCompleted) === "true");
      return {
        phone,
        customer,
        visits: completed.length,
        spend: completed.reduce((sum, appointment) => sum + (Number(appointment.price) || 0), 0)
      };
    });
  const direction = customerSortState.direction === "asc" ? 1 : -1;
  customers.sort((a, b) => {
    let comparison = 0;
    if (customerSortState.key === "visits") comparison = a.visits - b.visits;
    else if (customerSortState.key === "spend") comparison = a.spend - b.spend;
    else comparison = customerCodeValue(a.customer.code) - customerCodeValue(b.customer.code) || String(a.customer.code || "").localeCompare(String(b.customer.code || ""), "zh-Hant", { numeric: true });
    return comparison * direction || String(a.customer.code || a.phone).localeCompare(String(b.customer.code || b.phone), "zh-Hant", { numeric: true });
  });
  const html = customers.map(({ phone, customer: c, visits, spend }) => `<tr><td class="font-mono font-black text-teal-700">${esc(c.code || "")}</td><td class="font-mono font-black text-indigo-700">${esc(phone)}</td><td class="font-black">${esc(c.name || c.code || "未填寫")}</td><td><span class="badge ${visits <= 1 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}">${visits.toLocaleString()} 次</span></td><td class="font-black text-slate-800">${money(spend)}</td><td class="max-w-[280px] truncate">${esc(c.notes || "無")}</td><td class="text-right"><button class="btn-light px-3 py-1 text-xs" data-record="${esc(phone)}">檔案</button> <button class="rounded-lg bg-rose-50 px-3 py-1 text-xs font-black text-rose-700" data-delete-customer="${esc(phone)}">刪除</button></td></tr>`).join("");
  rows.innerHTML = html || `<tr><td colspan="7" class="py-8 text-center font-bold text-slate-400">無符合顧客</td></tr>`;
  const directionButton = $("customerSortDirection");
  if (directionButton) {
    const ascending = customerSortState.direction === "asc";
    directionButton.innerHTML = `${iconHtml(ascending ? "arrow-up" : "arrow-down", "h-4 w-4")}<span>${ascending ? "升冪" : "降冪"}</span>`;
  }
  refreshIcons();
  rows.querySelectorAll("[data-record]").forEach((btn) => btn.onclick = () => openCustomerModal(btn.dataset.record, true));
  rows.querySelectorAll("[data-delete-customer]").forEach((btn) => btn.onclick = () => confirmAction("刪除 CRM 檔案", "顧客基本資料與服務紀錄將移除。", async () => {
    const snapshot = snapshotDatabase();
    const phone = btn.dataset.deleteCustomer;
    delete db.customers[phone];
    renderAll();
    const saved = await saveCloudActions([{ action: "deleteCustomer", data: { phone } }], "顧客檔案已刪除", {
      verifyCloud: (cloudDb) => !cloudDb.customers?.[phone]
    });
    if (!saved) restoreDatabase(snapshot, "刪除未獲雲端確認，已還原顧客");
  }));
}

function openCustomerModal(phone = "", recordsOpen = false) {
  const c = phone ? db.customers[phone] : null;
  const historyCount = phone ? customerConsumptionHistory(phone).length : 0;
  const therapistOptions = Object.keys(db.therapists).map((id) => `<option value="${id}">${esc(therapistName(id))}</option>`).join("");
  showModal(`
    <div class="modal max-w-2xl">
      <h3 class="mb-5 border-b pb-4 text-xl font-black">顧客檔案與服務紀錄</h3>
      <form id="customerForm" class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div><label class="label">顧客編碼</label><input class="input bg-slate-100 font-mono" readonly value="${esc(c?.code || "儲存後自動產生")}"></div>
          <div><label class="label">聯絡方式</label><input name="phone" class="input" ${phone ? "readonly" : ""} value="${esc(phone)}"></div>
          <div class="sm:col-span-2"><label class="label">顧客姓名 <span class="text-slate-400">(選填)</span></label><input name="name" class="input" value="${esc(c?.name || "")}" placeholder="未填則以顧客編碼顯示"></div>
          <div class="sm:col-span-2"><label class="label">偏好與整體備註</label><textarea name="notes" class="input min-h-24">${esc(c?.notes || "")}</textarea></div>
        </div>
        ${recordsOpen && phone ? `<div class="rounded-xl border bg-slate-50 p-4">
          <h4 class="mb-3 font-black">新增 / 編輯服務紀錄</h4>
          <div class="grid gap-3 sm:grid-cols-2">
            <input id="recordDate" type="date" class="input" value="${todayKey()}">
            <select id="recordTherapist" class="input">${therapistOptions}</select>
            <input id="recordService" class="input" placeholder="服務項目">
            <input id="recordCollectedPrice" class="input" placeholder="實際回款">
            <textarea id="recordNotes" class="input sm:col-span-2" placeholder="服務細節與身體反饋"></textarea>
          </div>
          <button id="addRecordBtn" type="button" class="btn-teal mt-3">儲存此筆入檔</button>
        </div>
        <div><h4 class="mb-3 font-black">消費與服務紀錄 <span id="recordCountBadge" class="badge bg-indigo-50 text-indigo-700">${historyCount}</span></h4><div id="recordList" class="space-y-3">${renderRecordList(phone)}</div></div>` : ""}
        <p id="customerError" class="hidden text-sm font-black text-rose-600"></p>
        <div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>關閉</button><button class="btn-teal">儲存基本資料</button></div>
      </form>
    </div>`);
  $("customerForm").onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!data.phone.trim()) {
      $("customerError").textContent = "聯絡方式必填；顧客姓名可留空。";
      $("customerError").classList.remove("hidden");
      return;
    }
    const snapshot = snapshotDatabase();
    db.customers[data.phone] = { code: db.customers[data.phone]?.code, name: data.name.trim(), notes: data.notes.trim(), records: db.customers[data.phone]?.records || [] };
    assignCustomerCodes(db);
    setFormBusy(event.currentTarget, true);
    const saved = await saveCloudActions([{ action: "saveCustomer", data: { phone: data.phone, ...db.customers[data.phone] } }], "顧客資料已寫入雲端");
    setFormBusy(event.currentTarget, false);
    if (!saved) {
      restoreDatabase(snapshot, "顧客資料未獲雲端確認，已還原");
      return;
    }
    closeModal();
    renderAll();
  };
  if ($("addRecordBtn")) $("addRecordBtn").onclick = () => addCustomerRecord(phone);
  $("modalRoot").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => {
    closeModal();
    openAppointmentDetailPage(btn.dataset.openAppt);
  });
}

function customerConsumptionHistory(phone) {
  const manualRecords = [...(db.customers[phone]?.records || [])];
  const recordsById = new Map(manualRecords.filter((record) => record.id).map((record) => [String(record.id), record]));
  const completedAppointments = Object.values(db.appointments).filter((appointment) => appointment.phone === phone && (normalizeBookingStage(appointment.bookingStage, appointment) === "completed" || String(appointment.isCompleted) === "true"));
  const appointmentIds = new Set(completedAppointments.map((appointment) => String(appointment.id || appointment.appId || "")).filter(Boolean));
  const appointmentHistory = completedAppointments.map((appointment) => {
    const id = String(appointment.id || appointment.appId || "");
    const record = recordsById.get(id) || {};
    return {
      ...record,
      ...appointment,
      id,
      date: appointment.date || record.date || "",
      time: appointment.time || record.time || "",
      therapistId: appointment.therapistId || record.therapistId || "",
      therapistName: record.therapistName || therapistName(appointment.therapistId),
      service: appointment.service || record.service || "",
      price: Number(appointment.price) || 0,
      collectedPrice: appointment.collectedPrice || record.collectedPrice || "",
      notes: record.notes || "",
      appointmentLinked: true
    };
  });
  const standaloneRecords = manualRecords.filter((record) => !record.id || !appointmentIds.has(String(record.id))).map((record) => ({
    ...record,
    price: Number(record.price || record.collectedPrice) || 0,
    appointmentLinked: Boolean(record.id && db.appointments[record.id])
  }));
  return [...appointmentHistory, ...standaloneRecords].sort((a, b) => `${b.date || ""} ${b.time || ""}`.localeCompare(`${a.date || ""} ${a.time || ""}`));
}

function renderRecordList(phone) {
  const records = customerConsumptionHistory(phone);
  return records.length ? records.map((record) => {
    const displayPrice = Number(record.price || record.collectedPrice) || 0;
    const remittance = Number(record.collectedPrice) || 0;
    return `<article class="rounded-lg border bg-white p-4">
      <div class="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <div class="flex flex-wrap items-center gap-2"><b>${esc(record.date || "未填日期")}${record.time ? ` ${esc(record.time)}` : ""}</b><span class="badge bg-slate-100 text-slate-600">${esc(courseName(record.service))}</span></div>
          <p class="mt-1 text-xs font-black text-teal-700">${esc(record.therapistName || therapistName(record.therapistId))}</p>
        </div>
        <div class="text-left sm:text-right"><p class="text-xs font-bold text-slate-400">消費金額</p><strong class="text-lg text-slate-900">${money(displayPrice)}</strong>${remittance ? `<p class="text-xs font-bold text-teal-700">實際回款 ${money(remittance)}</p>` : ""}</div>
      </div>
      <p class="mt-3 whitespace-pre-wrap border-t pt-3 text-sm text-slate-600">${esc(record.notes || "尚未填寫服務備註")}</p>
      ${record.appointmentLinked && record.id ? `<button type="button" class="btn-light mt-3 px-3 py-1 text-xs" data-open-appt="${esc(record.id)}">開啟預約資料</button>` : ""}
    </article>`;
  }).join("") : `<div class="rounded-lg border border-dashed py-6 text-center text-sm font-bold text-slate-400">尚無已完成的消費紀錄</div>`;
}

async function addCustomerRecord(phone) {
  const snapshot = snapshotDatabase();
  const therapistId = $("recordTherapist").value;
  const service = $("recordService").value.trim();
  const record = { id: `REC-${Date.now().toString(36)}`, date: $("recordDate").value, therapistId, therapistName: therapistName(therapistId), service, collectedPrice: $("recordCollectedPrice").value.trim(), notes: $("recordNotes").value.trim() };
  db.customers[phone].records ||= [];
  db.customers[phone].records.push(record);
  const saved = await saveCloudActions([{ action: "saveCustomer", data: { phone, ...db.customers[phone] } }], "服務紀錄已寫入雲端");
  if (!saved) {
    restoreDatabase(snapshot, "服務紀錄未獲雲端確認，已還原");
    return;
  }
  $("recordList").innerHTML = renderRecordList(phone);
  if ($("recordCountBadge")) $("recordCountBadge").textContent = customerConsumptionHistory(phone).length;
  $("recordList").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => {
    closeModal();
    openAppointmentDetailPage(btn.dataset.openAppt);
  });
}

function buildDateRange(start, end) {
  const out = [];
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  if (Number.isNaN(s) || Number.isNaN(e) || s > e) return monthDates;
  for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push({ key: toDateKey(d), displayShort: `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`, displayFull: `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} (${days[d.getDay()]})`, isWeekend: d.getDay() === 0 || d.getDay() === 6 });
  }
  return out;
}

function drawScheduleTable() {
  currentScheduleViewDates = buildDateRange(scheduleFilterStart, scheduleFilterEnd);
  $("scheduleHeader").innerHTML = `<th class="sticky left-0 z-10 bg-slate-50">按摩師</th>` + currentScheduleViewDates.map((d) => `<th data-date-key="${esc(d.key)}" class="${d.isWeekend ? "text-rose-600" : ""} ${d.key === todayKey() ? "bg-teal-50 text-teal-700" : ""}">${esc(d.displayShort)}</th>`).join("");
  $("scheduleRows").innerHTML = Object.keys(db.therapists).map((id) => `<tr><td class="sticky left-0 bg-white font-black">${esc(therapistName(id))} <button class="ml-2 rounded bg-slate-100 px-2 py-1 text-xs" data-edit-schedule="${id}">✎</button></td>${currentScheduleViewDates.map((d) => `<td data-date-key="${esc(d.key)}" class="${isWorking((db.schedules[id] || {})[d.key]) ? "font-bold text-slate-700" : "text-slate-400"} ${d.key === todayKey() ? "bg-teal-50/50" : ""}">${esc((db.schedules[id] || {})[d.key] || "休假")}</td>`).join("")}</tr>`).join("");
  $("scheduleRows").querySelectorAll("[data-edit-schedule]").forEach((btn) => btn.onclick = () => openScheduleModal(btn.dataset.editSchedule));
  setTimeout(() => centerTodayInDateScroll($("view-personnel")), 80);
}

function openScheduleFilterModal() {
  showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">設定班表查詢區間</h3><form id="scheduleFilterForm" class="space-y-4"><div><label class="label">開始日期</label><input name="start" type="date" class="input" value="${esc(scheduleFilterStart)}"></div><div><label class="label">結束日期</label><input name="end" type="date" class="input" value="${esc(scheduleFilterEnd)}"></div><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">套用區間</button></div></form></div>`);
  $("scheduleFilterForm").onsubmit = (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    scheduleFilterStart = data.start || monthDates[0]?.key || todayKey();
    scheduleFilterEnd = data.end || monthDates.at(-1)?.key || todayKey();
    closeModal();
    renderPersonnel();
  };
}

function openScheduleModal(id) {
  showModal(`<div class="modal max-w-4xl"><h3 class="mb-5 border-b pb-4 text-xl font-black">強制編輯：${esc(therapistName(id))}</h3><form id="scheduleForm" class="space-y-4"><div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${currentScheduleViewDates.map((d) => `<label class="rounded-xl border bg-slate-50 p-3"><span class="label ${d.isWeekend ? "text-rose-600" : ""}">${esc(d.displayFull)}</span><input class="input py-2" name="${d.key}" value="${esc((db.schedules[id] || {})[d.key] || "")}" placeholder="休假 / 13:00-22:00"></label>`).join("")}</div><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">覆寫紀錄</button></div></form></div>`);
  $("scheduleForm").onsubmit = async (event) => {
    event.preventDefault();
    const snapshot = snapshotDatabase();
    setFormBusy(event.currentTarget, true);
    db.schedules[id] ||= {};
    Object.entries(Object.fromEntries(new FormData(event.currentTarget).entries())).forEach(([date, value]) => db.schedules[id][date] = normalizeShift(value));
    const saved = await saveCloudActions([{ action: "saveSchedule", data: { id, schedule: db.schedules[id] } }], "班表已寫入雲端");
    setFormBusy(event.currentTarget, false);
    if (!saved) {
      restoreDatabase(snapshot, "班表未獲雲端確認，已還原");
      return;
    }
    closeModal();
    renderAll();
  };
}

function normalizeShift(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned || cleaned.includes("休")) return "休假";
  return cleaned.replace(/\b(\d{1,2})(\d{2})\b/g, (_, h, m) => `${String(h).padStart(2, "0")}:${m}`).replace(/\s*[~到至]\s*/g, "-").replace(/\s*[、，]\s*/g, ",");
}

function exportScheduleCSV() {
  if (!currentScheduleViewDates.length) drawScheduleTable();
  let csv = "\uFEFF按摩師姓名," + currentScheduleViewDates.map((d) => `"${d.displayFull}"`).join(",") + "\n";
  Object.entries(db.therapists).forEach(([id, t]) => {
    csv += `"${therapistName(id)}",` + currentScheduleViewDates.map((d) => `"${(db.schedules[id] || {})[d.key] || "休假"}"`).join(",") + "\n";
  });
  downloadCSV(csv, `排班總表_${scheduleFilterStart}_至_${scheduleFilterEnd}.csv`);
}

function therapistProfileFields(profile = {}) {
  return `
    <div><label class="label">暱稱</label><input name="nickname" class="input" value="${esc(profile.nickname || "")}" placeholder="例如：Noah"></div>
    <div><label class="label">姓名</label><input name="name" class="input" value="${esc(profile.name || "")}" placeholder="真實姓名"></div>
    <div><label class="label">聯絡方式</label><input name="contact" class="input" value="${esc(profile.contact || "")}" placeholder="電話 / Line ID"></div>
    <div class="md:col-span-2"><label class="label">照片網址</label><input name="photoUrl" class="input" value="${esc(profile.photoUrl || "")}" placeholder="貼上公開圖片網址，例如 GitHub / Google Drive / Imgur 圖片連結"></div>
    <div><label class="label">身高 (cm)</label><input name="height" inputmode="numeric" class="input" value="${esc(profile.height || "")}" placeholder="例：170"></div>
    <div><label class="label">體重 (kg)</label><input name="weight" inputmode="numeric" class="input" value="${esc(profile.weight || "")}" placeholder="例：60"></div>
    <div><label class="label">年齡</label><input name="age" inputmode="numeric" class="input" value="${esc(profile.age || "")}" placeholder="例：28"></div>
    <div class="md:col-span-2"><label class="label">專長</label><input name="specialties" class="input" value="${esc(profile.specialties || "")}" placeholder="例：肩頸放鬆、深層舒壓、腿部循環"></div>
    <div class="md:col-span-2"><label class="label">備註</label><textarea name="notes" class="input min-h-24" placeholder="內部管理備註、排班偏好或注意事項">${esc(profile.notes || "")}</textarea></div>
    <div class="md:col-span-2">
      <div class="mb-2 flex items-center justify-between gap-3">
        <label class="label mb-0">介紹詞</label>
        <button type="button" class="btn-light px-3 py-1 text-xs" data-generate-therapist-bio>介紹詞生成器</button>
      </div>
      <textarea name="bio" class="input min-h-28" placeholder="可手動填寫，或使用介紹詞生成器">${esc(profile.bio || "")}</textarea>
    </div>`;
}

function collectTherapistProfile(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.id = String(data.id || "").trim();
  data.pin = cleanPin(data.pin);
  Object.keys(THERAPIST_PROFILE_DEFAULTS).forEach((key) => {
    data[key] = String(data[key] || "").trim();
  });
  return data;
}

function generateTherapistBio(data) {
  const displayName = data.nickname || data.name || "這位按摩師";
  const specialties = data.specialties || "放鬆舒壓與客製化調理";
  const profileBits = [
    data.age ? `${data.age}歲` : "",
    data.height ? `${data.height}cm` : "",
    data.weight ? `${data.weight}kg` : ""
  ].filter(Boolean).join("，");
  const note = data.notes ? `服務時特別重視${data.notes.replace(/[。.!！?？]+$/g, "")}。` : "服務節奏穩定，會依照顧客狀態調整力道與重點。";
  return `${displayName}${profileBits ? `（${profileBits}）` : ""}，擅長${specialties}。${note}`;
}

function wireTherapistBioGenerator(formId) {
  const form = $(formId);
  const btn = form?.querySelector("[data-generate-therapist-bio]");
  if (!form || !btn) return;
  btn.onclick = () => {
    const data = collectTherapistProfile(form);
    form.elements.bio.value = generateTherapistBio(data);
    showSnackbar("介紹詞已生成，可再手動調整");
  };
}

async function saveTherapistProfile(data) {
  const snapshot = snapshotDatabase();
  const existing = db.therapists[data.id] || {};
  db.therapists[data.id] = normalizeTherapistProfile({ ...existing, ...data });
  db.schedules[data.id] ||= {};
  const { pin, ...profile } = db.therapists[data.id];
  db.customers[therapistProfileKey(data.id)] = { name: profile.nickname || profile.name || data.id, notes: JSON.stringify(profile), records: [] };
  const saved = await saveCloudActions([
    { action: "addTherapist", data: therapistWritePayload(data.id, { ...db.therapists[data.id], pin: data.pin }) },
    { action: "saveCustomer", data: { phone: therapistProfileKey(data.id), ...db.customers[therapistProfileKey(data.id)] } }
  ], "按摩師資料已寫入雲端");
  if (!saved) restoreDatabase(snapshot, "按摩師資料未獲雲端確認，已還原");
  return saved;
}

function approvalsList(status = "") {
  return Object.values(db.approvals || {})
    .filter((item) => !status || item.status === status)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function approvalSummary(item) {
  if (item.type === "schedule") {
    const days = Object.keys(item.data?.schedule || {}).length;
    return `${item.data?.weekLabel || "班表區間"}，共 ${days} 天`;
  }
  if (item.type === "password") return "變更為新的 4 位數 PIN";
  const d = item.data || {};
  return [d.nickname || d.name || "", d.contact || "", d.specialties || ""].filter(Boolean).join(" · ") || "更新人事基本資料";
}

function renderApprovalDetail(item) {
  if (item.type === "schedule") {
    const rows = Object.entries(item.data?.schedule || {}).map(([date, shift]) => `<tr><td class="font-mono font-black">${esc(date)}</td><td>${esc(item.before?.[date] || "休假")}</td><td class="font-black text-teal-700">${esc(shift)}</td></tr>`).join("");
    return `<div class="table-wrap mt-3"><table><thead><tr><th>日期</th><th>原班表</th><th>申請班表</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  if (item.type === "password") {
    return `<div class="mt-3 rounded-xl bg-slate-50 p-3 text-sm font-bold text-slate-600">舊版密碼審核紀錄；目前前台變更密碼已改為直接更新。</div>`;
  }
  const d = item.data || {};
  return `<div class="mt-3 grid gap-2 rounded-xl bg-slate-50 p-3 text-sm font-bold text-slate-600 sm:grid-cols-2">
    <div>暱稱：${esc(d.nickname || "未填")}</div><div>姓名：${esc(d.name || "未填")}</div>
    <div>聯絡方式：${esc(d.contact || "未填")}</div><div>基本資料：${esc([d.age ? `${d.age}歲` : "", d.height ? `${d.height}cm` : "", d.weight ? `${d.weight}kg` : ""].filter(Boolean).join(" / ") || "未填")}</div>
    <div class="sm:col-span-2">專長：${esc(d.specialties || "未填")}</div>
    <div class="sm:col-span-2">介紹 / 備註：${esc(d.bio || d.notes || "未填")}</div>
  </div>`;
}

async function updateApprovalRecord(item, status, extra = {}) {
  const snapshot = snapshotDatabase();
  const next = { ...item, ...extra, status, updatedAt: new Date().toISOString(), reviewedBy: currentUser?.id || "" };
  db.approvals[next.id] = next;
  db.customers[approvalKey(next.id)] = {
    name: `${approvalStatusLabel(status)}-${approvalTypeLabel(next.type)}-${therapistName(next.therapistId)}`,
    notes: JSON.stringify(next),
    records: []
  };
  const saved = await saveCloudActions([{ action: "saveCustomer", data: { phone: approvalKey(next.id), ...db.customers[approvalKey(next.id)] } }], `申請已${approvalStatusLabel(status)}`);
  if (!saved) restoreDatabase(snapshot, "審核更新未獲雲端確認，已還原");
  return saved;
}

async function approveRequest(id) {
  const item = db.approvals[id];
  if (!item || item.status !== "pending") return;
  const snapshot = snapshotDatabase();
  const therapistId = item.therapistId;
  const therapist = db.therapists[therapistId] || { pin: "" };
  const actions = [];
  const schedulePatch = item.type === "schedule" ? { ...(item.data?.schedule || {}) } : {};

  if (item.type === "profile") {
    db.therapists[therapistId] = normalizeTherapistProfile({ ...therapist, ...item.data, id: therapistId, pin: therapist.pin });
    const { pin, ...profile } = db.therapists[therapistId];
    db.customers[therapistProfileKey(therapistId)] = { name: profile.nickname || profile.name || therapistId, notes: JSON.stringify(profile), records: [] };
    actions.push(
      { action: "addTherapist", data: therapistWritePayload(therapistId, { ...db.therapists[therapistId], pin }) },
      { action: "saveCustomer", data: { phone: therapistProfileKey(therapistId), ...db.customers[therapistProfileKey(therapistId)] } }
    );
  } else if (item.type === "password") {
    db.therapists[therapistId] = normalizeTherapistProfile({ ...therapist, pin: cleanPin(item.data?.pin) });
    actions.push({ action: "addTherapist", data: therapistWritePayload(therapistId, db.therapists[therapistId]) });
  } else if (item.type === "schedule") {
    db.schedules[therapistId] = { ...(db.schedules[therapistId] || {}), ...schedulePatch };
    actions.push({ action: "saveSchedule", data: { id: therapistId, schedule: db.schedules[therapistId] } });
  }

  const next = { ...item, status: "approved", updatedAt: new Date().toISOString(), reviewedBy: currentUser?.id || "" };
  db.approvals[id] = next;
  db.customers[approvalKey(id)] = { name: `已核可-${approvalTypeLabel(item.type)}-${therapistName(therapistId)}`, notes: JSON.stringify(next), records: [] };
  actions.push({ action: "saveCustomer", data: { phone: approvalKey(id), ...db.customers[approvalKey(id)] } });
  persist("審核核可套用");
  renderPersonnel();
  showSnackbar("已核可並套用，正在同步雲端");
  const synced = await saveCloudActions(actions, "申請已核可並套用");
  if (!synced) {
    restoreDatabase(snapshot, "核可未獲雲端確認，已還原申請");
    markSyncPending(true, "approval-awaiting-cloud-confirmation");
    showSnackbar("核可未完成，原申請已保留，可稍後重試");
    return false;
  }
  renderPersonnel();
  return true;
}

async function handleApprovalAction(button, action) {
  if (!button?.dataset) return;
  const id = action === "approve" ? button.dataset.approveRequest : action === "reject" ? button.dataset.rejectRequest : button.dataset.dismissApproval;
  if (!id || button.disabled) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = action === "approve" ? "套用中..." : action === "reject" ? "處理中..." : originalText;
  try {
    if (action === "approve") await approveRequest(id);
    else if (action === "reject") await rejectRequest(id);
    else await dismissApproval(id);
  } catch (error) {
    console.error("approval action failed", error);
    showSnackbar(`審核動作失敗：${error?.message || "請重新整理後再試一次"}`);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function rejectRequest(id) {
  const item = db.approvals[id];
  if (!item || item.status !== "pending") return;
  const saved = await updateApprovalRecord(item, "rejected");
  if (!saved) return;
  renderAll();
}

async function dismissApproval(id) {
  const item = db.approvals[id];
  if (!item || item.status === "pending") return;
  const snapshot = snapshotDatabase();
  delete db.approvals[id];
  delete db.customers[approvalKey(id)];
  const saved = await saveCloudActions([{ action: "deleteCustomer", data: { phone: approvalKey(id) } }], "審核紀錄已移除");
  if (!saved) {
    restoreDatabase(snapshot, "移除未獲雲端確認，已還原審核紀錄");
    return;
  }
  renderAll();
}

function renderPersonnel() {
  const section = $("view-personnel");
  scheduleFilterStart ||= monthDates[0]?.key || todayKey();
  scheduleFilterEnd ||= monthDates.at(-1)?.key || todayKey();
  const pendingCount = approvalsList("pending").length;
  const personnelTabs = {
    schedule: { label: "班表", icon: "calendar-range" },
    staff: { label: "人員資料", icon: "contact" },
    approvals: { label: "待審核", icon: "badge-check" },
    admins: { label: "管理員", icon: "shield-check" }
  };
  const panelBtn = (panel) => {
    const item = personnelTabs[panel];
    return `<button class="workspace-tab ${activePersonnelPanel === panel ? "active" : ""}" data-personnel-panel="${panel}">${iconHtml(item.icon)}<span>${item.label}</span>${panel === "approvals" && pendingCount ? `<b>${pendingCount}</b>` : ""}</button>`;
  };
  const approvalPanel = `
    <div class="workbench-panel card overflow-hidden">
      <div class="border-b bg-slate-50 p-5">
        <h3 class="font-black">前台變更審核</h3>
        <p class="mt-1 text-sm font-bold text-slate-500">師傅在前台提出的人事資料與班表變更，需在此核可後才會套用；密碼變更已改為前台直接更新。</p>
      </div>
      <div class="divide-y divide-slate-100">
        ${approvalsList().length ? approvalsList().map((item) => {
          const statusClass = item.status === "approved" ? "bg-teal-50 text-teal-700" : item.status === "rejected" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700";
          return `<div class="p-5">
            <div class="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="badge bg-slate-100 text-slate-700">${esc(approvalTypeLabel(item.type))}</span>
                  <span class="badge ${statusClass}">${esc(approvalStatusLabel(item.status))}</span>
                  <span class="text-xs font-bold text-slate-400">${esc(new Date(item.createdAt).toLocaleString("zh-TW", { hour12: false }))}</span>
                </div>
                <h4 class="mt-2 text-lg font-black">${esc(therapistName(item.therapistId))} <span class="font-mono text-sm text-slate-400">${esc(item.therapistId)}</span></h4>
                <p class="mt-1 text-sm font-bold text-slate-500">${esc(approvalSummary(item))}</p>
              </div>
              ${item.status === "pending" ? `<div class="flex gap-2"><button class="btn-teal px-4 py-2 text-sm" data-approve-request="${esc(item.id)}">核可套用</button><button class="rounded-xl bg-rose-50 px-4 py-2 text-sm font-black text-rose-700" data-reject-request="${esc(item.id)}">退回</button></div>` : `<button class="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-lg font-black text-slate-500 hover:bg-rose-50 hover:text-rose-600" title="移除此審核紀錄" data-dismiss-approval="${esc(item.id)}">×</button>`}
            </div>
            ${renderApprovalDetail(item)}
          </div>`;
        }).join("") : `<div class="p-10 text-center text-sm font-bold text-slate-400">目前沒有前台送審項目</div>`}
      </div>
    </div>`;
  const staffPanel = `
    <div class="workbench-panel card p-5">
      <div class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div><h3 class="font-black">人事資料</h3><p class="text-sm font-bold text-slate-500">人員清單保持乾淨，需要建立新人時再開啟新增表單。</p></div>
        <button id="openTherapistCreateBtn" class="btn-teal">新增人員</button>
      </div>
    </div>
    <div class="workbench-panel card overflow-hidden">
      <div class="border-b bg-slate-50 p-5"><h3 class="font-black">在職人員資料庫</h3></div>
      <div class="staff-mobile-grid hidden p-4">
        ${staffMobileCardsHtml()}
      </div>
      <div class="staff-desktop-table table-wrap rounded-none border-0">
        <table>
          <thead><tr><th>編號</th><th>暱稱 / 姓名</th><th>基本資料</th><th>專長</th><th>密碼</th><th>操作</th></tr></thead>
          <tbody>${Object.entries(db.therapists).map(([id, t]) => `<tr>
            <td class="font-black">${esc(id)}</td>
            <td><div class="font-black">${esc(t.nickname || t.name || "未填寫")}</div><div class="text-xs font-bold text-slate-500">${esc(t.name || "未填真實姓名")}</div></td>
            <td class="max-w-[220px] text-sm font-bold text-slate-600">${esc(therapistDisplayMeta(t) || "未填寫")}</td>
            <td class="max-w-[240px] truncate text-sm font-bold text-slate-600">${esc(t.specialties || "未填寫")}</td>
            <td><span class="badge bg-slate-100 text-slate-700">${esc(cleanPin(t.pin))}</span></td>
            <td class="space-x-2"><button data-edit-therapist="${esc(id)}" class="btn-light px-3 py-1 text-xs">編輯</button><button data-delete-therapist="${esc(id)}" class="rounded-lg bg-rose-50 px-3 py-1 text-xs font-black text-rose-700">刪除人員</button></td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    </div>`;
  const schedulePanel = `
    <div class="workbench-panel card overflow-hidden">
      <div class="workbench-panel-head">
        <div><span class="page-kicker">排班管理</span><h3>班表矩陣</h3><p>橫向瀏覽日期；點人員旁的編輯按鈕即可調整所選區間。</p></div>
        <div class="workbench-actions">
          <div class="date-range-chip">${iconHtml("calendar-range")}<span>${esc(scheduleFilterStart)} 至 ${esc(scheduleFilterEnd)}</span></div>
          <button id="openScheduleFilterBtn" class="btn-light">${iconHtml("sliders-horizontal")}設定區間</button>
          <button id="exportScheduleBtn" class="btn-teal">${iconHtml("download")}匯出</button>
        </div>
      </div>
      <div class="schedule-table-wrap table-wrap rounded-none border-0" data-date-scroll><table><thead><tr id="scheduleHeader"></tr></thead><tbody id="scheduleRows"></tbody></table></div>
    </div>`;
  const adminPanel = `
    <div class="workbench-panel card overflow-hidden">
      <div class="flex flex-col justify-between gap-3 border-b bg-slate-50 p-5 sm:flex-row sm:items-center">
        <div><h3 class="font-black">系統管理員</h3><p class="mt-1 text-sm font-bold text-slate-500">管理後台登入權限，需要新增時再開啟表單。</p></div>
        <button id="openAdminCreateBtn" class="btn-teal">新增管理員</button>
      </div>
      <div class="admin-mobile-grid hidden p-4">
        ${adminMobileCardsHtml()}
      </div>
      <div class="admin-desktop-table table-wrap rounded-none border-0"><table><thead><tr><th>帳號</th><th>姓名</th><th>密碼</th><th>Email</th><th>操作</th></tr></thead><tbody>${Object.entries(db.admins).map(([id, a]) => `<tr><td class="font-black">${esc(id)}</td><td>${esc(a.name)}</td><td><span class="badge bg-slate-100 text-slate-700">${esc(cleanPin(a.pin))}</span></td><td>${esc(a.email || "無")}</td><td class="space-x-2"><button data-edit-admin="${esc(id)}" class="btn-light px-3 py-1 text-xs">編輯</button>${id === "admin" ? `<span class="text-xs font-bold text-slate-400">預設不可刪</span>` : `<button data-delete-admin="${esc(id)}" class="rounded-lg bg-rose-50 px-3 py-1 text-xs font-black text-rose-700">刪除</button>`}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
  section.innerHTML = `
    <div class="page-workbench-header">
      <div>
        <span class="page-kicker">人事管理</span>
        <h2>班表與人員</h2>
        <p>先處理每日排班，再管理人員資料、送審項目與登入權限。</p>
      </div>
      <div class="workspace-tabs" role="tablist">${panelBtn("schedule")}${panelBtn("staff")}${panelBtn("approvals")}${panelBtn("admins")}</div>
    </div>
    ${activePersonnelPanel === "schedule" ? schedulePanel : activePersonnelPanel === "admins" ? adminPanel : activePersonnelPanel === "approvals" ? approvalPanel : staffPanel}`;
  section.querySelectorAll("[data-personnel-panel]").forEach((btn) => btn.onclick = () => {
    activePersonnelPanel = btn.dataset.personnelPanel;
    renderPersonnel();
  });
  if (activePersonnelPanel === "schedule") {
    $("openScheduleFilterBtn").onclick = openScheduleFilterModal;
    $("exportScheduleBtn").onclick = exportScheduleCSV;
    drawScheduleTable();
    return;
  }
  if (activePersonnelPanel === "staff") {
    $("openTherapistCreateBtn").onclick = openTherapistCreator;
    section.querySelectorAll("[data-edit-therapist]").forEach((btn) => btn.onclick = () => openTherapistEditor(btn.dataset.editTherapist));
    section.querySelectorAll("[data-delete-therapist]").forEach((btn) => btn.onclick = () => confirmAction("刪除按摩師", "排班資料會保留於資料庫記錄中，但人員不再顯示。", async () => {
      const id = btn.dataset.deleteTherapist;
      const snapshot = snapshotDatabase();
      delete db.therapists[id];
      delete db.customers[therapistProfileKey(id)];
      renderAll();
      const saved = await saveCloudActions([
        { action: "deleteTherapist", data: { id } },
        { action: "deleteCustomer", data: { phone: therapistProfileKey(id) } }
      ], "按摩師資料已刪除", {
        verifyCloud: (cloudDb) => !cloudDb.therapists?.[id] && !cloudDb.customers?.[therapistProfileKey(id)]
      });
      if (!saved) restoreDatabase(snapshot, "刪除未獲雲端確認，已還原按摩師");
    }));
    return;
  }
  if (activePersonnelPanel === "approvals") {
    return;
  }
  if (activePersonnelPanel === "admins") {
    $("openAdminCreateBtn").onclick = openAdminCreator;
    section.querySelectorAll("[data-edit-admin]").forEach((btn) => btn.onclick = () => openAdminEditor(btn.dataset.editAdmin));
    section.querySelectorAll("[data-delete-admin]").forEach((btn) => btn.onclick = () => confirmAction("刪除管理員", "此帳號將無法登入。", async () => {
      const id = btn.dataset.deleteAdmin;
      const snapshot = snapshotDatabase();
      delete db.admins[id];
      renderAll();
      const saved = await saveCloudActions([{ action: "deleteCustomer", data: { phone: `SYS_ADMIN_${id}` } }], "管理員權限已刪除", {
        verifyCloud: (cloudDb) => !cloudDb.customers?.[`SYS_ADMIN_${id}`]
      });
      if (!saved) restoreDatabase(snapshot, "刪除未獲雲端確認，已還原管理員");
    }));
  }
}

function openTherapistCreator() {
  showModal(`<div class="modal max-w-4xl">
    <h3 class="mb-5 border-b pb-4 text-xl font-black">新增按摩師基本人事資料</h3>
    <form id="therapistCreateForm" class="space-y-5">
      <div class="grid gap-4 md:grid-cols-2">
        <div><label class="label">編號 (登入帳號)</label><input name="id" class="input" placeholder="例：T004"></div>
        <div><label class="label">密碼 PIN</label><input name="pin" class="input" inputmode="numeric" autocomplete="off" placeholder="4 位數，可含開頭 0"></div>
        ${therapistProfileFields()}
      </div>
      <div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">建立檔案並開通登入</button></div>
    </form>
  </div>`);
  $("therapistCreateForm").onsubmit = async (event) => {
    event.preventDefault();
    const data = collectTherapistProfile(event.currentTarget);
    if (!data.id || !data.pin) return showSnackbar("編號與密碼 PIN 必填");
    setFormBusy(event.currentTarget, true);
    const saved = await saveTherapistProfile(data);
    setFormBusy(event.currentTarget, false);
    if (!saved) return;
    closeModal();
    renderAll();
  };
  wireTherapistBioGenerator("therapistCreateForm");
}

function openTherapistEditor(id) {
  const therapist = db.therapists[id];
  if (!therapist) return;
  showModal(`<div class="modal max-w-4xl">
    <h3 class="mb-5 border-b pb-4 text-xl font-black">編輯按摩師基本人事資料</h3>
    <form id="therapistEditForm" class="space-y-5">
      <div class="grid gap-4 md:grid-cols-2">
        <div><label class="label">編號 (登入帳號)</label><input name="id" class="input bg-slate-100" readonly value="${esc(id)}"></div>
        <div><label class="label">密碼 PIN</label><input name="pin" class="input" inputmode="numeric" autocomplete="off" value="${esc(cleanPin(therapist.pin))}"><p class="mt-2 text-xs font-bold text-slate-500">PIN 會以文字保存，開頭 0 不會被移除。</p></div>
        ${therapistProfileFields(therapist)}
      </div>
      <div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">儲存修改</button></div>
    </form>
  </div>`);
  $("therapistEditForm").onsubmit = async (event) => {
    event.preventDefault();
    const data = collectTherapistProfile(event.currentTarget);
    if (!data.pin) return showSnackbar("密碼 PIN 必填");
    setFormBusy(event.currentTarget, true);
    const saved = await saveTherapistProfile(data);
    setFormBusy(event.currentTarget, false);
    if (!saved) return;
    closeModal();
    renderAll();
  };
  wireTherapistBioGenerator("therapistEditForm");
}

async function saveAdminForm(form, { closeAfter = false } = {}) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.id = String(data.id || "").trim();
  data.name = String(data.name || "").trim();
  data.email = String(data.email || "").trim();
  data.pin = cleanPin(data.pin);
  if (!data.id || !data.name || !data.pin) {
    showSnackbar("管理員資料必填");
    return false;
  }
  setFormBusy(form, true);
  const snapshot = snapshotDatabase();
  db.admins[data.id] = { name: data.name, pin: data.pin, email: data.email };
  const saved = await saveCloudActions([{ action: "saveCustomer", data: { phone: `SYS_ADMIN_${data.id}`, name: data.name, notes: sheetText(data.pin), records: [{ email: data.email }] } }], "管理員權限已寫入雲端");
  setFormBusy(form, false);
  if (!saved) {
    restoreDatabase(snapshot, "管理員資料未獲雲端確認，已還原");
    return false;
  }
  if (closeAfter) closeModal();
  renderAll();
  return true;
}

function openAdminCreator() {
  showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">新增管理員權限</h3><form id="adminCreateForm" class="space-y-4"><div><label class="label">帳號</label><input name="id" class="input" placeholder="帳號"></div><div><label class="label">姓名</label><input name="name" class="input" placeholder="姓名"></div><div><label class="label">Email</label><input name="email" class="input" placeholder="Email"></div><div><label class="label">密碼 PIN</label><input name="pin" class="input" inputmode="numeric" autocomplete="off" placeholder="4位數字"><p class="mt-2 text-xs font-bold text-slate-500">PIN 會以文字保存，開頭 0 不會被移除。</p></div><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">建立</button></div></form></div>`);
  $("adminCreateForm").onsubmit = async (event) => {
    event.preventDefault();
    await saveAdminForm(event.currentTarget, { closeAfter: true });
  };
}

function openAdminEditor(id) {
  const admin = db.admins[id];
  if (!admin) return;
  showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">編輯管理員權限</h3><form id="adminEditForm" class="space-y-4"><div><label class="label">帳號</label><input name="id" class="input bg-slate-100" readonly value="${esc(id)}"></div><div><label class="label">姓名</label><input name="name" class="input" value="${esc(admin.name || "")}"></div><div><label class="label">Email</label><input name="email" class="input" value="${esc(admin.email || "")}"></div><div><label class="label">密碼 PIN</label><input name="pin" class="input" inputmode="numeric" autocomplete="off" value="${esc(cleanPin(admin.pin))}"><p class="mt-2 text-xs font-bold text-slate-500">PIN 會以文字保存，開頭 0 不會被移除。</p></div><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">儲存修改</button></div></form></div>`);
  $("adminEditForm").onsubmit = async (event) => {
    event.preventDefault();
    await saveAdminForm(event.currentTarget, { closeAfter: true });
  };
}

function adminMobileCardsHtml() {
  return Object.entries(db.admins).map(([id, a]) => `<article class="admin-mobile-card">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="font-mono text-xs font-black text-slate-400">${esc(id)}</p>
        <h4 class="mt-1 truncate text-lg font-black text-slate-900">${esc(a.name || "未填寫")}</h4>
        <p class="mt-0.5 truncate text-xs font-bold text-slate-500">${esc(a.email || "無 Email")}</p>
      </div>
      <span class="badge bg-slate-100 text-slate-700">PIN ${esc(cleanPin(a.pin))}</span>
    </div>
    <div class="mt-4 grid ${id === "admin" ? "grid-cols-1" : "grid-cols-2"} gap-2">
      <button data-edit-admin="${esc(id)}" class="btn-light px-3 py-2 text-xs">編輯</button>
      ${id === "admin" ? `<span class="rounded-lg bg-slate-50 px-3 py-2 text-center text-xs font-black text-slate-400">預設不可刪</span>` : `<button data-delete-admin="${esc(id)}" class="rounded-lg bg-rose-50 px-3 py-2 text-xs font-black text-rose-700">刪除</button>`}
    </div>
  </article>`).join("");
}

function staffMobileCardsHtml() {
  return Object.entries(db.therapists).map(([id, t]) => `<article class="staff-mobile-card">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="font-mono text-xs font-black text-slate-400">${esc(id)}</p>
        <h4 class="mt-1 truncate text-lg font-black text-slate-900">${esc(t.nickname || t.name || "未填寫")}</h4>
        <p class="mt-0.5 truncate text-xs font-bold text-slate-500">${esc(t.name || "未填真實姓名")}</p>
      </div>
      <span class="badge bg-slate-100 text-slate-700">PIN ${esc(cleanPin(t.pin))}</span>
    </div>
    <div class="mt-4 grid gap-3 text-sm">
      <div>
        <p class="text-[11px] font-black text-slate-400">基本資料</p>
        <p class="mt-1 font-bold text-slate-700">${esc(therapistDisplayMeta(t) || "未填寫")}</p>
      </div>
      <div>
        <p class="text-[11px] font-black text-slate-400">專長</p>
        <p class="mt-1 font-bold text-slate-700">${esc(t.specialties || "未填寫")}</p>
      </div>
    </div>
    <div class="mt-4 grid grid-cols-2 gap-2">
      <button data-edit-therapist="${esc(id)}" class="btn-light px-3 py-2 text-xs">編輯</button>
      <button data-delete-therapist="${esc(id)}" class="rounded-lg bg-rose-50 px-3 py-2 text-xs font-black text-rose-700">刪除</button>
    </div>
  </article>`).join("");
}

function renderReport() {
  reportFilterStart ||= todayKey();
  reportFilterEnd ||= todayKey();
  const start = reportFilterStart;
  const end = reportFilterEnd;
  const rows = Object.values(db.appointments).filter((a) => a.date >= start && a.date <= end).sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date));
  const total = rows.reduce((s, a) => s + Number(a.price || 0), 0);
  const therapistCut = rows.reduce((s, a) => s + Number(COURSE_CATALOG[a.service]?.therapistCut || 0), 0);
  const collected = rows.reduce((s, a) => s + Number(a.collectedPrice || 0), 0);
  const outstanding = Math.max(0, total - collected);
  const reportTabs = {
    revenue: { label: "營收明細", icon: "receipt-text" },
    guests: { label: "每日來客", icon: "users" },
    retention: { label: "回客分析", icon: "repeat-2" },
    commission: { label: "抽成／回帳", icon: "wallet-cards" }
  };
  const reportTab = (panel) => `<button class="workspace-tab ${activeReportPanel === panel ? "active" : ""}" data-report-panel="${panel}">${iconHtml(reportTabs[panel].icon)}<span>${reportTabs[panel].label}</span></button>`;
  const allApptsByPhone = {};
  Object.values(db.appointments).sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date)).forEach((a) => {
    if (!a.phone) return;
    allApptsByPhone[a.phone] ||= [];
    allApptsByPhone[a.phone].push(a);
  });
  const revenueTable = `<div class="table-wrap"><table><thead><tr><th>預約日期時間</th><th>顧客</th><th>師傅</th><th>服務</th><th class="text-right">總金額</th><th class="text-right">店家應收</th><th class="text-right">師傅抽成</th></tr></thead><tbody>${rows.length ? rows.map((a) => {
    const tc = COURSE_CATALOG[a.service]?.therapistCut || 0;
    return `<tr><td><button data-open-appt="${esc(a.id)}" class="font-mono font-black text-teal-700 hover:text-teal-900">${esc(a.date)} ${esc(a.time)}</button></td><td><button data-open-appt="${esc(a.id)}" class="font-black hover:text-teal-700">${esc(customerDisplay(a.phone, a.customerName))}</button></td><td>${esc(therapistName(a.therapistId))}</td><td>${esc(courseName(a.service))}</td><td class="text-right font-black text-rose-600">${money(a.price)}</td><td class="text-right font-black text-teal-700">${money(Number(a.price || 0) - tc)}</td><td class="text-right font-black text-indigo-700">${money(tc)}</td></tr>`;
  }).join("") : `<tr><td colspan="7" class="py-10 text-center font-bold text-slate-400">該區間無預約</td></tr>`}</tbody></table></div>`;
  const guestByDate = {};
  rows.forEach((a) => {
    guestByDate[a.date] ||= { count: 0, phones: new Set(), newGuests: 0, returningGuests: 0, total: 0 };
    const bucket = guestByDate[a.date];
    bucket.count += 1;
    bucket.total += Number(a.price || 0);
    if (a.phone) {
      bucket.phones.add(a.phone);
      const first = allApptsByPhone[a.phone]?.[0];
      if (first?.id === a.id) bucket.newGuests += 1;
      else bucket.returningGuests += 1;
    }
  });
  const guestTable = `<div class="table-wrap"><table><thead><tr><th>日期</th><th class="text-right">來客數</th><th class="text-right">不重複顧客</th><th class="text-right">新客</th><th class="text-right">回客</th><th class="text-right">營業額</th></tr></thead><tbody>${Object.entries(guestByDate).length ? Object.entries(guestByDate).map(([date, b]) => `<tr><td class="font-mono font-black">${esc(date)}</td><td class="text-right font-black">${b.count}</td><td class="text-right font-black">${b.phones.size}</td><td class="text-right font-black text-emerald-700">${b.newGuests}</td><td class="text-right font-black text-amber-700">${b.returningGuests}</td><td class="text-right font-black text-rose-700">${money(b.total)}</td></tr>`).join("") : `<tr><td colspan="6" class="py-10 text-center font-bold text-slate-400">該區間無來客資料</td></tr>`}</tbody></table></div>`;
  const therapistStats = Object.keys(db.therapists).map((id) => {
    const mine = rows.filter((a) => a.therapistId === id);
    const phoneCounts = {};
    mine.forEach((a) => { if (a.phone) phoneCounts[a.phone] = (phoneCounts[a.phone] || 0) + 1; });
    const unique = Object.keys(phoneCounts).length;
    const returnGuests = Object.values(phoneCounts).filter((count) => count > 1).length;
    const rate = unique ? Math.round((returnGuests / unique) * 100) : 0;
    return { id, count: mine.length, unique, returnGuests, rate, total: mine.reduce((s, a) => s + Number(a.price || 0), 0) };
  }).filter((row) => row.count > 0).sort((a, b) => b.rate - a.rate || b.count - a.count);
  const retentionTable = `<div class="table-wrap"><table><thead><tr><th>師傅</th><th class="text-right">服務筆數</th><th class="text-right">不重複顧客</th><th class="text-right">回客人數</th><th class="text-right">回客率</th><th class="text-right">營業額</th></tr></thead><tbody>${therapistStats.length ? therapistStats.map((s) => `<tr><td class="font-black text-teal-700">${esc(therapistName(s.id))}</td><td class="text-right font-black">${s.count}</td><td class="text-right font-black">${s.unique}</td><td class="text-right font-black text-amber-700">${s.returnGuests}</td><td class="text-right font-black text-indigo-700">${s.rate}%</td><td class="text-right font-black text-rose-700">${money(s.total)}</td></tr>`).join("") : `<tr><td colspan="6" class="py-10 text-center font-bold text-slate-400">該區間無師傅統計</td></tr>`}</tbody></table></div>`;
  const commissionStats = Object.keys(db.therapists).map((id) => {
    const mine = rows.filter((a) => a.therapistId === id);
    const gross = mine.reduce((s, a) => s + Number(a.price || 0), 0);
    const paid = mine.reduce((s, a) => s + Number(a.collectedPrice || 0), 0);
    const cut = mine.reduce((s, a) => s + therapistCutFor(a), 0);
    return { id, count: mine.length, gross, paid, outstanding: Math.max(0, gross - paid), cut, company: Math.max(0, gross - cut) };
  }).filter((row) => row.count > 0).sort((a, b) => b.gross - a.gross);
  const commissionTable = `<div class="table-wrap"><table><thead><tr><th>師傅</th><th class="text-right">服務筆數</th><th class="text-right">應收總額</th><th class="text-right">已回帳</th><th class="text-right">未回帳</th><th class="text-right">師傅抽成</th><th class="text-right">店家應收</th></tr></thead><tbody>${commissionStats.length ? commissionStats.map((s) => `<tr><td class="font-black text-teal-700">${esc(therapistName(s.id))}</td><td class="text-right font-black">${s.count}</td><td class="text-right font-black text-rose-700">${money(s.gross)}</td><td class="text-right font-black text-emerald-700">${money(s.paid)}</td><td class="text-right font-black text-amber-700">${money(s.outstanding)}</td><td class="text-right font-black text-indigo-700">${money(s.cut)}</td><td class="text-right font-black text-teal-700">${money(s.company)}</td></tr>`).join("") : `<tr><td colspan="7" class="py-10 text-center font-bold text-slate-400">該區間無抽成資料</td></tr>`}</tbody></table></div>`;
  const panelContent = { revenue: revenueTable, guests: guestTable, retention: retentionTable, commission: commissionTable }[activeReportPanel] || revenueTable;
  const panelDescriptions = {
    revenue: "逐筆核對服務金額、店家應收與師傅抽成。",
    guests: "按日期比較來客、新客、回客與每日營業額。",
    retention: "檢視各師傅服務量、顧客結構與回客表現。",
    commission: "集中追蹤已回帳、未回帳、抽成與店家應收。"
  };
  $("view-report").innerHTML = `
    <div class="page-workbench-header">
      <div>
        <span class="page-kicker">財務管理</span>
        <h2>營運與回帳</h2>
        <p>先掌握區間金額，再進入營收、來客、回客或回帳明細。</p>
      </div>
      <div class="workbench-actions">
        <div class="date-range-chip">${iconHtml("calendar-range")}<span>${esc(start)} 至 ${esc(end)}</span></div>
        <button id="queryReportBtn" class="btn-light">${iconHtml("sliders-horizontal")}設定區間</button>
        <button id="exportReportBtn" class="btn-teal">${iconHtml("download")}輸出</button>
      </div>
    </div>
    <div class="report-summary-grid">
      <div class="report-summary-card tone-slate"><span>${iconHtml("users")}</span><div><p>服務筆數</p><strong>${rows.length}</strong><small>${start === end ? "當日" : "所選區間"}</small></div></div>
      <div class="report-summary-card tone-rose"><span>${iconHtml("circle-dollar-sign")}</span><div><p>應收總額</p><strong>${money(total)}</strong><small>顧客支付總額</small></div></div>
      <div class="report-summary-card tone-teal"><span>${iconHtml("badge-check")}</span><div><p>已回帳</p><strong>${money(collected)}</strong><small>目前已登記</small></div></div>
      <div class="report-summary-card tone-amber"><span>${iconHtml("clock-3")}</span><div><p>未回帳</p><strong>${money(outstanding)}</strong><small>尚待追蹤</small></div></div>
      <div class="report-summary-card tone-indigo"><span>${iconHtml("hand-coins")}</span><div><p>師傅抽成</p><strong>${money(therapistCut)}</strong><small>依課程計算</small></div></div>
    </div>
    <div class="report-data-card card overflow-hidden">
      <div class="report-data-head">
        <div class="workspace-tabs report-tabs" role="tablist">${reportTab("revenue")}${reportTab("guests")}${reportTab("retention")}${reportTab("commission")}</div>
        <p>${esc(panelDescriptions[activeReportPanel] || panelDescriptions.revenue)}</p>
      </div>
      <div class="report-data-body">${panelContent}</div>
    </div>`;
  $("queryReportBtn").onclick = openReportFilterModal;
  $("exportReportBtn").onclick = exportReportCSV;
  $("view-report").querySelectorAll("[data-report-panel]").forEach((btn) => btn.onclick = () => {
    activeReportPanel = btn.dataset.reportPanel;
    renderReport();
  });
  $("view-report").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
  hydrateResponsiveTables($("view-report"));
}

function openReportFilterModal() {
  showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">設定財務查詢區間</h3><form id="reportFilterForm" class="space-y-4"><div><label class="label">開始日期</label><input name="start" type="date" class="input" value="${esc(reportFilterStart || todayKey())}"></div><div><label class="label">結束日期</label><input name="end" type="date" class="input" value="${esc(reportFilterEnd || todayKey())}"></div><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">套用查詢</button></div></form></div>`);
  $("reportFilterForm").onsubmit = (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    reportFilterStart = data.start || todayKey();
    reportFilterEnd = data.end || todayKey();
    closeModal();
    renderReport();
  };
}

function exportReportCSV() {
  const start = reportFilterStart || todayKey();
  const end = reportFilterEnd || todayKey();
  const rows = Object.values(db.appointments).filter((a) => a.date >= start && a.date <= end).sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date));
  let csv = "\uFEFF";
  if (activeReportPanel === "commission") {
    csv += "師傅,服務筆數,應收總額,已回帳,未回帳,師傅抽成,店家應收\n";
    Object.keys(db.therapists).forEach((id) => {
      const mine = rows.filter((a) => a.therapistId === id);
      if (!mine.length) return;
      const gross = mine.reduce((s, a) => s + Number(a.price || 0), 0);
      const paid = mine.reduce((s, a) => s + Number(a.collectedPrice || 0), 0);
      const cut = mine.reduce((s, a) => s + therapistCutFor(a), 0);
      csv += `"${therapistName(id)}",${mine.length},${gross},${paid},${Math.max(0, gross - paid)},${cut},${Math.max(0, gross - cut)}\n`;
    });
  } else if (activeReportPanel === "retention") {
    csv += "師傅,服務筆數,不重複顧客,回客人數,回客率,營業額\n";
    Object.keys(db.therapists).forEach((id) => {
      const mine = rows.filter((a) => a.therapistId === id);
      if (!mine.length) return;
      const phoneCounts = {};
      mine.forEach((a) => { if (a.phone) phoneCounts[a.phone] = (phoneCounts[a.phone] || 0) + 1; });
      const unique = Object.keys(phoneCounts).length;
      const returnGuests = Object.values(phoneCounts).filter((count) => count > 1).length;
      csv += `"${therapistName(id)}",${mine.length},${unique},${returnGuests},${unique ? Math.round((returnGuests / unique) * 100) : 0}%,${mine.reduce((s, a) => s + Number(a.price || 0), 0)}\n`;
    });
  } else if (activeReportPanel === "guests") {
    csv += "日期,來客數,不重複顧客,營業額\n";
    const byDate = {};
    rows.forEach((a) => {
      byDate[a.date] ||= { count: 0, phones: new Set(), total: 0 };
      byDate[a.date].count += 1;
      byDate[a.date].total += Number(a.price || 0);
      if (a.phone) byDate[a.date].phones.add(a.phone);
    });
    Object.entries(byDate).forEach(([date, b]) => csv += `${date},${b.count},${b.phones.size},${b.total}\n`);
  } else {
    csv += "日期,時間,顧客編碼,顧客姓名,聯絡方式,負責師傅,服務項目,總金額,店家應收,師傅抽成\n";
    rows.forEach((a) => {
      const tc = COURSE_CATALOG[a.service]?.therapistCut || 0;
      csv += `${a.date},${a.time},"${customerCode(a.phone)}","${a.customerName || db.customers[a.phone]?.name || ""}","${a.phone}","${therapistName(a.therapistId)}","${courseName(a.service)}",${a.price},${Number(a.price || 0) - tc},${tc}\n`;
    });
  }
  downloadCSV(csv, `報表_${activeReportPanel}_${start}_至_${end}.csv`);
}

function renderSystem() {
  const section = $("view-system");
  if (!section) return;
  const stats = dbStats();
  const meta = effectiveSyncMeta();
  const backups = listLocalBackups().slice(0, 8);
  const loginRows = adminLoginRecords(80);
  const frontdeskRows = frontdeskLoginRecords(80);
  const doorRows = [...(db.customers.SYS_DOOR_PWD?.records || [])].map(normalizeAuditRecord).reverse().slice(0, 20);
  const backupRows = backups.length ? backups.map((item) => `<tr>
    <td class="font-mono font-black">${esc(backupLabelTime(item.at))}</td>
    <td><div class="font-black">${esc(item.reason || "資料修改前")}</div><div class="mt-1 text-xs font-bold text-slate-400">${esc(item.key.replace(`${LOCAL_BACKUP_PREFIX}-`, ""))}</div></td>
    <td class="text-right font-black">${item.stats.appointments}</td>
    <td class="text-right font-black">${item.stats.customers}</td>
    <td class="text-right"><button class="btn-light px-3 py-1 text-xs" data-download-backup="${esc(item.key)}">下載</button></td>
  </tr>`).join("") : `<tr><td colspan="5" class="py-10 text-center font-bold text-slate-400">尚無修改快照</td></tr>`;
  const loginTableRows = loginRows.length ? loginRows.map((item) => `<tr>
    <td class="font-mono font-black">${esc(backupLabelTime(auditTimestamp(item)) || "舊紀錄未記錄")}</td>
    <td><div class="font-black">${esc(auditField(item, ["adminName", "name", "adminId"], "未知管理員"))}</div><div class="mt-1 font-mono text-xs font-bold text-slate-400">${esc(auditField(item, ["adminId", "account", "userId"], ""))}</div></td>
    <td class="font-bold text-slate-600">${esc(auditField(item, ["source", "origin", "host", "path"]))}</td>
    <td class="max-w-[360px] truncate text-xs font-bold text-slate-500">${esc(auditField(item, ["device", "userAgent", "browser"]))}</td>
  </tr>`).join("") : `<tr><td colspan="4" class="py-10 text-center font-bold text-slate-400">尚無後台管理登入紀錄</td></tr>`;
  const frontdeskTableRows = frontdeskRows.length ? frontdeskRows.map((item) => `<tr>
    <td class="font-mono font-black">${esc(backupLabelTime(auditTimestamp(item)) || "舊紀錄未記錄")}</td>
    <td><div class="font-black">${esc(auditField(item, ["therapistName", "name", "therapistId"], "未知師傅"))}</div><div class="mt-1 font-mono text-xs font-bold text-slate-400">${esc(auditField(item, ["therapistId", "staffId", "userId"], ""))}</div></td>
    <td class="font-bold text-slate-600">${esc(auditField(item, ["source", "origin", "host", "path"]))}</td>
    <td class="max-w-[360px] truncate text-xs font-bold text-slate-500">${esc(auditField(item, ["device", "userAgent", "browser"]))}</td>
  </tr>`).join("") : `<tr><td colspan="4" class="py-10 text-center font-bold text-slate-400">尚無前台師傅登入紀錄</td></tr>`;
  const doorTableRows = doorRows.length ? doorRows.map((item) => `<tr>
    <td class="font-mono font-black">${esc(backupLabelTime(auditTimestamp(item)) || "舊紀錄未記錄")}</td>
    <td class="font-mono text-lg font-black">${esc(auditField(item, ["value", "password", "code", "doorPassword"]))}</td>
    <td class="font-bold text-slate-600">${esc(auditField(item, ["reason", "source", "type"]))}</td>
  </tr>`).join("") : `<tr><td colspan="3" class="py-10 text-center font-bold text-slate-400">尚無大門密碼修改紀錄</td></tr>`;
  const noteStore = systemNoteStore();
  const noteRows = [...(noteStore.records || [])].reverse().slice(0, 6);
  const noteRecordHtml = noteRows.length ? `<div class="mt-4 rounded-xl border bg-slate-50 p-3">
    <p class="mb-2 text-xs font-black text-slate-500">最近更新</p>
    <div class="space-y-2">${noteRows.map((item) => `<div class="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-xs font-bold text-slate-500"><span>${esc(backupLabelTime(item.at))}</span><span>${esc(item.adminName || item.adminId || "系統")} · ${Number(item.length || 0)} 字</span></div>`).join("")}</div>
  </div>` : "";
  const systemTabs = [
    { key: "status", label: "系統狀態", icon: "activity" },
    { key: "data", label: "資料安全", icon: "database-backup" },
    { key: "audit", label: "稽核紀錄", icon: "list-checks" },
    { key: "integrations", label: "整合測試", icon: "plug" }
  ];
  const systemTabsHtml = systemTabs.map((item) => `<button type="button" role="tab" data-system-panel="${item.key}" class="system-tab${activeSystemPanel === item.key ? " active" : ""}" aria-selected="${activeSystemPanel === item.key}">${iconHtml(item.icon)}<span>${item.label}</span></button>`).join("");
  const actionRow = ({ id = "", title, desc, icon, tone = "normal", href = "" }) => {
    const classes = `system-action-row${tone === "danger" ? " border-rose-200 bg-rose-50/40" : ""}`;
    const content = `<span class="system-action-copy"><span class="system-action-icon">${iconHtml(icon)}</span><span><strong>${esc(title)}</strong><small>${esc(desc)}</small></span></span>${iconHtml("chevron-right")}`;
    return href ? `<a class="${classes}" href="${esc(href)}" target="_blank" rel="noopener">${content}</a>` : `<button type="button" id="${id}" class="${classes} w-full text-left">${content}</button>`;
  };
  const syncLabel = meta.pending ? "需要確認" : meta.lastSync ? "雲端已讀取" : "尚未更新";
  const syncTone = meta.pending || !meta.lastSync ? "is-warning" : "is-ok";
  const lastSyncLabel = meta.lastSync ? backupLabelTime(meta.lastSync) : "尚無紀錄";

  let panelHtml = "";
  if (activeSystemPanel === "data") {
    panelHtml = `
      <div class="system-panel-grid">
        <div class="card p-5">
          <div class="mb-4 border-b pb-4"><span class="badge bg-teal-50 text-teal-700">必要</span><h3 class="mt-2 text-lg font-black">備份與復原</h3><p class="mt-1 text-xs font-bold text-slate-500">先備份，再查看修改紀錄；只有雲端資料確定異常時才使用強制回寫。</p></div>
          <div class="system-action-list">
            ${actionRow({ id: "systemDownloadBackupBtn", title: "下載完整備份", desc: "匯出目前所有預約、顧客、人事與班表資料。", icon: "download" })}
            ${actionRow({ id: "systemOpenHistoryBtn", title: "修改紀錄與復原", desc: "查看快照，下載單一版本或復原到指定時間。", icon: "history" })}
          </div>
        </div>
        <div class="card p-5">
          <div class="mb-4 border-b pb-4"><span class="badge bg-slate-100 text-slate-700">功能分工</span><h3 class="mt-2 text-lg font-black">哪些功能該在這裡</h3></div>
          <div class="space-y-3 text-sm font-bold text-slate-600">
            <p><span class="mr-2 text-teal-700">必要</span>重新讀取、完整備份、修改紀錄。</p>
            <p><span class="mr-2 text-indigo-700">需要時</span>登入稽核、大門密碼歷程與資料復原。</p>
            <p><span class="mr-2 text-amber-700">附加</span>LINE 模擬與外部流程測試。</p>
            <p><span class="mr-2 text-rose-700">高風險</span>把目前畫面資料強制覆寫回雲端。</p>
          </div>
        </div>
      </div>
      <div class="card p-5">
        <div class="mb-4 flex flex-col justify-between gap-3 border-b pb-4 sm:flex-row sm:items-center"><div><h3 class="font-black">最近修改快照</h3><p class="mt-1 text-xs font-bold text-slate-500">畫面只顯示最近 8 筆；完整紀錄請使用上方復原工具。</p></div><span class="badge bg-slate-100 text-slate-700">${backups.length} 筆</span></div>
        ${responsiveTableHtml(["時間", "來源", "預約", "顧客", "操作"], backupRows, 5)}
      </div>
      ${collapsibleCardHtml({ title: "進階資料修復", desc: "只在雲端資料確定錯誤、且已先下載備份時使用。", open: false, className: "system-danger-zone", body: `<div class="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p class="font-black text-rose-800">強制把目前畫面資料寫回雲端</p><p class="mt-1 text-xs font-bold leading-relaxed text-rose-600">此操作不是一般同步，可能覆蓋其他裝置剛完成的更新。</p></div><button id="systemUploadLocalBtn" class="btn-light shrink-0 border-rose-200 text-rose-700 hover:bg-rose-50">強制回寫雲端</button></div>` })}`;
  } else if (activeSystemPanel === "audit") {
    panelHtml = `
      <div class="card p-5">
        <div class="mb-5 flex flex-col justify-between gap-3 border-b pb-4 sm:flex-row sm:items-center"><div><span class="badge bg-indigo-50 text-indigo-700">需要時</span><h3 class="mt-2 text-lg font-black">登入稽核</h3><p class="mt-1 text-xs font-bold text-slate-500">用於確認帳號、時間、來源與使用裝置，不參與日常預約流程。</p></div><div class="flex gap-2"><span class="badge bg-slate-100 text-slate-700">後台 ${loginRows.length}</span><span class="badge bg-teal-50 text-teal-700">前台 ${frontdeskRows.length}</span></div></div>
        <div class="grid gap-6 xl:grid-cols-2">
          <div><h4 class="mb-3 font-black">後台管理登入</h4>${responsiveTableHtml(["時間", "管理員", "來源", "裝置"], loginTableRows, 4)}</div>
          <div><h4 class="mb-3 font-black">前台師傅登入</h4>${responsiveTableHtml(["時間", "師傅", "來源", "裝置"], frontdeskTableRows, 4)}</div>
        </div>
      </div>
      ${collapsibleCardHtml({ title: "大門密碼修改紀錄", desc: `目前密碼：${esc(db.customers.SYS_DOOR_PWD?.notes || "未設定")}，共顯示 ${doorRows.length} 筆。`, open: false, body: responsiveTableHtml(["時間", "密碼", "來源"], doorTableRows, 3) })}`;
  } else if (activeSystemPanel === "integrations") {
    panelHtml = `
      <div class="system-panel-grid">
        ${lineTrialPanelHtml()}
        <div class="card p-5">
          <div class="mb-4 border-b pb-4"><span class="badge bg-amber-50 text-amber-700">附加功能</span><h3 class="mt-2 text-lg font-black">外部入口與測試</h3><p class="mt-1 text-xs font-bold text-slate-500">測試工具與正式營運分開，避免測試資料混入預約流程。</p></div>
          <div class="system-action-list">
            ${actionRow({ href: `./frontdesk.html?v=${encodeURIComponent(APP_VERSION)}`, title: "開啟前台師傅系統", desc: "驗證師傅登入、排班與服務回報。", icon: "external-link" })}
            ${actionRow({ id: "systemGoBookingBtn", title: "前往預約系統建立客選", desc: "客選連結必須從可接師傅名單建立，不在系統頁直接產生。", icon: "calendar-check" })}
          </div>
        </div>
      </div>
      <div class="card p-5"><div class="grid gap-4 md:grid-cols-3"><div><span class="badge bg-teal-50 text-teal-700">正式入口</span><h4 class="mt-2 font-black">前台師傅系統</h4><p class="mt-1 text-xs font-bold text-slate-500">個人班表、人事資料與服務回報。</p></div><div><span class="badge bg-slate-100 text-slate-700">由預約產生</span><h4 class="mt-2 font-black">顧客客選頁</h4><p class="mt-1 text-xs font-bold text-slate-500">只呈現後台勾選的可接師傅。</p></div><div><span class="badge bg-amber-50 text-amber-700">測試用途</span><h4 class="mt-2 font-black">LINE 模擬</h4><p class="mt-1 text-xs font-bold text-slate-500">目前只測試訊息轉待辦，不取代正式 LINE API。</p></div></div></div>`;
  } else {
    panelHtml = `
      <div class="system-panel-grid">
        <div class="card p-5">
          <div class="mb-4 flex flex-col justify-between gap-3 border-b pb-4 sm:flex-row sm:items-start"><div><span class="badge bg-teal-50 text-teal-700">必要</span><h3 class="mt-2 text-lg font-black">雲端資料狀態</h3><p class="mt-1 text-xs font-bold text-slate-500">這裡只回答兩件事：目前讀到多少資料，以及最後一次何時成功更新。</p></div><span class="system-status-chip ${syncTone}">${iconHtml(meta.pending ? "triangle-alert" : "circle-check")} ${esc(syncLabel)}</span></div>
          <div class="system-summary-grid">
            ${metric("按摩師", stats.therapists)}
            ${metric("預約", stats.appointments, "text-teal-700")}
            ${metric("顧客", stats.customers, "text-indigo-700")}
            ${metric("班表人員", stats.schedules, "text-amber-700")}
          </div>
          <div class="mt-4 rounded-xl border bg-slate-50 p-4"><p class="text-xs font-black text-slate-500">上次成功更新</p><p class="mt-2 font-mono text-base font-black text-slate-800">${esc(lastSyncLabel)}</p></div>
        </div>
        <div class="card p-5">
          <div class="mb-4 border-b pb-4"><span class="badge bg-slate-100 text-slate-700">下一步</span><h3 class="mt-2 text-lg font-black">現在要做什麼</h3><p class="mt-1 text-xs font-bold text-slate-500">一般使用只需要重新讀取；備份與復原放在資料安全。</p></div>
          <div class="system-action-list">
            ${actionRow({ id: "systemRefreshDataBtn", title: "重新讀取雲端資料", desc: "放棄快取顯示，再抓一次最新資料。", icon: "refresh-cw" })}
            ${actionRow({ id: "systemGoDataBtn", title: "備份或復原資料", desc: "下載完整備份、查看快照與修改紀錄。", icon: "shield-check" })}
            ${actionRow({ id: "systemGoAuditBtn", title: "查看登入紀錄", desc: "確認後台管理員與前台師傅的登入來源。", icon: "scroll-text" })}
          </div>
        </div>
      </div>
      <div class="card p-5">
        <div class="mb-4 border-b pb-4"><span class="badge bg-amber-50 text-amber-700">Note</span><h3 class="mt-2 text-lg font-black">系統備忘</h3><p class="mt-1 text-xs font-bold text-slate-500">只放跨裝置需要共同知道的部署提醒、資料庫注意事項與交接內容。</p></div>
        <textarea id="systemNoteText" class="input min-h-40 resize-y leading-relaxed" placeholder="例如：下次部署後要測試前台登入、客選連結、預約狀態回寫...">${esc(noteStore.notes || "")}</textarea>
        <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><p class="text-xs font-bold text-slate-500">儲存成功後會寫入雲端，其他裝置重新讀取即可看到。</p><button id="systemSaveNoteBtn" class="btn-teal shrink-0">儲存備忘</button></div>
        ${noteRecordHtml}
      </div>`;
  }

  section.innerHTML = `<div class="system-page">
    <div class="card system-command">
      <div class="system-command-copy"><span class="badge bg-slate-100 text-slate-700">系統維護</span><h3>系統與資料管理</h3><p>日常先看狀態；備份、稽核與測試各自收進獨立工作區。</p></div>
      <div class="system-status-line"><span class="system-status-chip ${syncTone}">${iconHtml(meta.pending ? "triangle-alert" : "circle-check")} ${esc(syncLabel)}</span><span class="system-status-chip">${iconHtml("clock-3")} ${esc(lastSyncLabel)}</span><span class="system-status-chip">${esc(APP_VERSION)}</span></div>
    </div>
    <nav class="system-tabs" role="tablist" aria-label="系統工作區">${systemTabsHtml}</nav>
    <div role="tabpanel">${panelHtml}</div>
  </div>`;

  const bindClick = (id, handler) => {
    const element = $(id);
    if (element) element.onclick = handler;
  };
  section.querySelectorAll("[data-system-panel]").forEach((button) => {
    button.onclick = () => {
      activeSystemPanel = button.dataset.systemPanel;
      renderSystem();
    };
  });
  bindClick("systemRefreshDataBtn", refreshDashboardData);
  bindClick("systemGoDataBtn", () => { activeSystemPanel = "data"; renderSystem(); });
  bindClick("systemGoAuditBtn", () => { activeSystemPanel = "audit"; renderSystem(); });
  bindClick("systemGoBookingBtn", () => switchTab("dispatch", { focus: "query" }));
  bindClick("systemUploadLocalBtn", () => confirmAction("強制回寫雲端", "此操作可能覆蓋其他裝置的新資料。請確認已先下載完整備份。", uploadLocalDbToCloud));
  bindClick("systemOpenHistoryBtn", openChangeHistoryModal);
  bindClick("systemDownloadBackupBtn", downloadCurrentBackup);
  bindClick("systemSaveNoteBtn", saveSystemNote);
  bindClick("openLineTrialBtn", openLineTrialModal);
  section.querySelectorAll("[data-download-backup]").forEach((button) => button.onclick = () => downloadBackupEntry(button.dataset.downloadBackup));
  hydrateResponsiveTables(section);
  refreshIcons();
}

function renderPortal() {
  const section = $("view-portal");
  if (!currentUser) {
    section.innerHTML = `<div class="card p-8 text-center font-bold text-slate-500">請以按摩師帳號登入。</div>`;
    return;
  }
  const activeWeek = monthWeeks.find((week) => week.some((d) => d.key === todayKey())) || monthWeeks[0] || [];
  const monthKeys = new Set(monthDates.map((d) => d.key));
  const appts = Object.values(db.appointments).filter((a) => a.therapistId === currentUser.id && monthKeys.has(a.date)).sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date));
  section.innerHTML = `
    <div class="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div class="card overflow-hidden">
        <div class="flex flex-col justify-between gap-4 border-b bg-white px-5 py-4 sm:flex-row sm:items-center">
          <div><p class="text-xs font-black uppercase tracking-widest text-slate-500">個人中樞</p><h3 class="text-2xl font-black">${esc(currentUser.nickname || currentUser.name)}</h3></div>
          <span class="badge bg-teal-50 text-teal-700">${appts.length} 筆本月預約</span>
        </div>
        <div class="divide-y divide-slate-100">
          ${appts.length ? appts.map((a) => `<div class="grid gap-3 p-4 md:grid-cols-[120px_1fr_auto] md:items-center">
            <button data-open-appt="${esc(a.id)}" class="text-left font-mono text-sm font-black text-teal-700 hover:text-teal-900">${esc(a.date)}<br><span class="text-slate-900">${esc(a.time)}</span></button>
            <div><button data-open-appt="${esc(a.id)}" class="text-left font-black hover:text-teal-700">${esc(customerDisplay(a.phone, a.customerName))}</button><p class="mt-1 text-sm font-bold text-slate-500">${esc(courseName(a.service))} · ${roomBadge(a.room)}</p></div>
            <button class="btn-light px-3 py-2 text-xs" data-complete="${esc(a.id)}">回報</button>
          </div>`).join("") : `<p class="p-8 text-center font-bold text-slate-400">本月無排程</p>`}
        </div>
      </div>
      <div class="card p-5">
        <div class="mb-4 flex items-center justify-between gap-3"><div><h4 class="font-black">本週排班</h4><p class="text-xs font-bold text-slate-500">填寫後同步後台班表</p></div><button id="savePortalScheduleBtn" class="btn-teal px-3 py-2 text-xs">儲存</button></div>
        <div id="portalScheduleInputs" class="space-y-3">${activeWeek.map((d) => `<label class="block rounded-xl border bg-slate-50 p-3"><span class="label">${esc(d.displayFull)}</span><input class="input py-2" data-portal-shift="${d.key}" value="${esc((db.schedules[currentUser.id] || {})[d.key] || "")}"></label>`).join("")}</div>
      </div>
    </div>`;
  $("savePortalScheduleBtn").onclick = async () => {
    const snapshot = snapshotDatabase();
    db.schedules[currentUser.id] ||= {};
    document.querySelectorAll("[data-portal-shift]").forEach((input) => db.schedules[currentUser.id][input.dataset.portalShift] = normalizeShift(input.value));
    const saved = await saveCloudActions([{ action: "saveSchedule", data: { id: currentUser.id, schedule: db.schedules[currentUser.id] } }], "班表已寫入雲端");
    if (!saved) {
      restoreDatabase(snapshot, "班表未獲雲端確認，已還原");
      return;
    }
    renderAll();
  };
  section.querySelectorAll("[data-complete]").forEach((btn) => btn.onclick = () => openTherapistReport(btn.dataset.complete));
  section.querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
}

function openTherapistReport(id) {
  const a = db.appointments[id];
  showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">填寫服務紀錄與回款</h3><form id="therapistReportForm" class="space-y-4"><div class="rounded-xl border bg-slate-50 p-4"><b>${esc(customerDisplay(a.phone, a.customerName))}</b><p class="text-sm font-bold text-teal-700">${esc(a.date)} / ${esc(a.time)} - ${esc(courseName(a.service))}</p></div><input name="collectedPrice" class="input" type="number" placeholder="實際回款金額" value="${esc(a.collectedPrice || "")}"><textarea name="notes" class="input min-h-28" placeholder="服務細節與顧客反饋">${esc(findRecord(a)?.notes || "")}</textarea><label class="flex items-center gap-3 rounded-xl border p-3 font-black"><input name="isCompleted" type="checkbox" ${String(a.isCompleted) === "true" ? "checked" : ""}> 標記為已完成</label><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">儲存入檔</button></div></form></div>`);
  $("therapistReportForm").onsubmit = async (event) => {
    event.preventDefault();
    const snapshot = snapshotDatabase();
    setFormBusy(event.currentTarget, true);
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    a.collectedPrice = data.collectedPrice || "";
    a.isCompleted = data.isCompleted === "on";
    a.bookingStage = a.isCompleted ? "completed" : (a.bookingStage === "completed" ? "pre_notice" : normalizeBookingStage(a.bookingStage, a));
    const customer = db.customers[a.phone] || { name: a.customerName || "", notes: "", records: [] };
    if (!customer.code) {
      db.customers[a.phone] = customer;
      assignCustomerCodes(db);
    }
    customer.records ||= [];
    const idx = customer.records.findIndex((r) => r.id === a.id);
    const record = { id: a.id, date: a.date, therapistId: a.therapistId, therapistName: therapistName(a.therapistId), service: a.service, collectedPrice: a.collectedPrice, notes: data.notes || "" };
    if (idx >= 0) customer.records[idx] = { ...customer.records[idx], ...record };
    else customer.records.push(record);
    db.customers[a.phone] = customer;
    const saved = await saveCloudActions([
      { action: "addAppointment", data: a },
      { action: "saveCustomer", data: { phone: a.phone, ...customer } },
      syncAppointmentMeta(a)
    ].filter(Boolean), "服務紀錄已寫入雲端");
    setFormBusy(event.currentTarget, false);
    if (!saved) {
      restoreDatabase(snapshot, "服務回報未獲雲端確認，已還原");
      return;
    }
    closeModal();
    renderAll();
  };
}

function findRecord(appt) {
  return db.customers[appt.phone]?.records?.find((r) => r.id === appt.id);
}

function isWorking(shift) {
  return Boolean(shift && !String(shift).includes("休") && shift !== "尚未排班");
}

function sortByTime(a, b) {
  return String(a.time || "").localeCompare(String(b.time || ""));
}

function showModal(html) {
  $("modalRoot").innerHTML = `<div class="modal-backdrop">${html}</div>`;
  $("modalRoot").querySelectorAll("[data-close-modal]").forEach((el) => el.onclick = closeModal);
  hydrateResponsiveTables($("modalRoot"));
  refreshIcons();
}

function closeModal() {
  $("modalRoot").innerHTML = "";
}

function confirmAction(title, description, onConfirm, confirmText = "確認執行") {
  showModal(`<div class="modal max-w-sm text-center"><div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-2xl text-rose-600">!</div><h3 class="mb-2 text-xl font-black">${esc(title)}</h3><p class="mb-6 whitespace-pre-wrap text-sm font-bold leading-relaxed text-slate-600">${esc(description)}</p><div class="flex gap-3"><button class="btn-light w-full" data-close-modal>取消</button><button id="confirmActionBtn" class="w-full rounded-xl bg-rose-600 px-5 py-3 font-black text-white">${esc(confirmText)}</button></div></div>`);
  $("confirmActionBtn").onclick = async () => {
    closeModal();
    try {
      await Promise.resolve(onConfirm?.());
    } catch (error) {
      console.error(error);
      showSnackbar("動作失敗，請再試一次");
    }
  };
}

function downloadCSV(csv, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
  showSnackbar("CSV 已匯出");
}

async function handleLogin() {
  const id = $("adminId").value.trim();
  const pin = $("adminPin").value.trim();
  const err = $("loginErrorMsg");
  const finishLogin = () => {
    if (pinMatches(db.admins[id]?.pin, pin)) {
      currentUser = { id, name: db.admins[id].name, role: "admin" };
      $("adminNav").classList.remove("hidden");
      $("therapistNav").classList.add("hidden");
      $("roleLabel").textContent = "管理員";
      enterDashboard("overview");
      recordAdminLogin(id);
      if (cleanPin(db.admins[id]?.pin) !== cleanPin(pin)) showSnackbar("已用舊格式密碼登入，請至人事頁編輯後重新儲存 PIN");
      return true;
    }
    if (pinMatches(db.therapists[id]?.pin, pin)) {
      currentUser = { id, name: therapistName(id), role: "therapist" };
      $("adminNav").classList.add("hidden");
      $("therapistNav").classList.remove("hidden");
      $("roleLabel").textContent = "按摩師";
      enterDashboard("portal");
      if (cleanPin(db.therapists[id]?.pin) !== cleanPin(pin)) showSnackbar("已用舊格式密碼登入，請管理員重新儲存您的 PIN");
      return true;
    }
    return false;
  };
  err.classList.add("hidden");
  if (!id || !pin) {
    err.textContent = "請輸入完整帳號密碼。";
    err.classList.remove("hidden");
    return;
  }
  $("loginBtn").disabled = true;
  $("loginBtnText").textContent = "連線中...";
  $("loginLoader").classList.remove("hidden");
  const synced = await tryCloudSync();
  if (synced) await ensureCloudSyncMeta("登入後讀取雲端資料");
  if (!finishLogin() && effectiveSyncMeta().pending) {
    $("loginBtnText").textContent = "重抓雲端...";
    const forceSynced = await tryCloudSync({ force: true });
    if (forceSynced) await ensureCloudSyncMeta("登入後重抓雲端資料");
    if (finishLogin()) showSnackbar("已改用最新資料登入");
  }
  if (!currentUser) {
    err.textContent = "帳號或密碼錯誤。";
    err.classList.remove("hidden");
  }
  $("loginBtn").disabled = false;
  $("loginBtnText").textContent = "授權登入";
  $("loginLoader").classList.add("hidden");
}

function enterDashboard(tab) {
  $("loginView").classList.add("hidden");
  $("adminDashboard").classList.remove("hidden");
  renderAll();
  switchTab(tab);
  clearInterval(liveTimer);
  liveTimer = setInterval(renderLiveStatus, 60000);
}

function logout() {
  currentUser = null;
  syncMobileBottomNav();
  clearInterval(liveTimer);
  $("adminDashboard").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("adminPin").value = "";
}

function changeMonth(offset) {
  currentMonth += offset;
  if (currentMonth > 11) { currentMonth = 0; currentYear += 1; }
  if (currentMonth < 0) { currentMonth = 11; currentYear -= 1; }
  renderAll();
}

function bindEvents() {
  renderAppShellNavigation();
  $("loginBtn").addEventListener("click", handleLogin);
  $("adminPin").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });
  $("logoutBtn").addEventListener("click", logout);
  $("prevMonthBtn").addEventListener("click", () => changeMonth(-1));
  $("nextMonthBtn").addEventListener("click", () => changeMonth(1));
  $("openSidebarBtn").addEventListener("click", showSidebar);
  $("closeSidebarBtn").addEventListener("click", hideSidebar);
  $("sidebarOverlay").addEventListener("click", hideSidebar);
  document.addEventListener("click", (event) => {
    const tabButton = closestFromEvent(event, "[data-tab]");
    if (tabButton) {
      event.preventDefault();
      switchTab(tabButton.dataset.tab, { clearAppointment: tabButton.dataset.tab === "dispatch" });
      return;
    }
    const mobileTabButton = closestFromEvent(event, "[data-mobile-tab]");
    if (mobileTabButton) {
      event.preventDefault();
      switchTab(mobileTabButton.dataset.mobileTab, { clearAppointment: mobileTabButton.dataset.mobileTab === "dispatch" });
      return;
    }
    const jumpButton = closestFromEvent(event, "[data-jump-tab]");
    if (jumpButton) {
      event.preventDefault();
      if (jumpButton.dataset.personnelPanel) activePersonnelPanel = jumpButton.dataset.personnelPanel;
      if (jumpButton.dataset.reportPanel) activeReportPanel = jumpButton.dataset.reportPanel;
      switchTab(jumpButton.dataset.jumpTab, { clearAppointment: jumpButton.dataset.jumpTab === "dispatch", focus: jumpButton.dataset.dispatchFocus || "" });
      return;
    }
    const approveButton = closestFromEvent(event, "[data-approve-request]");
    if (approveButton) {
      event.preventDefault();
      handleApprovalAction(approveButton, "approve");
      return;
    }
    const rejectButton = closestFromEvent(event, "[data-reject-request]");
    if (rejectButton) {
      event.preventDefault();
      handleApprovalAction(rejectButton, "reject");
      return;
    }
    const dismissApprovalButton = closestFromEvent(event, "[data-dismiss-approval]");
    if (dismissApprovalButton) {
      event.preventDefault();
      handleApprovalAction(dismissApprovalButton, "dismiss");
      return;
    }
    const addButton = closestFromEvent(event, "[data-add-appointment]");
    if (!addButton) return;
    event.preventDefault();
    openAppointmentModal({ therapistId: addButton.dataset.therapist, date: addButton.dataset.date, time: addButton.dataset.time || "" });
  });
}

window.handleLogin = handleLogin;
window.handleAdminLogin = handleLogin;
window.switchTab = switchTab;
window.logout = logout;

bindEvents();
renderAll();
