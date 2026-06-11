"use strict";

const API_URL = "https://script.google.com/macros/s/AKfycbxC4Pk1v6rkdmd96cR_2r_xPhbcNjrQ0bNdikGKyqbR9OMMeCwN9L5t9mE1j-AoS-ie/exec";
const STORAGE_KEY = "morgan-ops-hub-v2";
const SYNC_META_KEY = `${STORAGE_KEY}-sync-meta`;
const LOCAL_BACKUP_PREFIX = `${STORAGE_KEY}-backup`;

const COURSE_CATALOG = {
  A60: { name: "A課程 60分", duration: 60, price: 1800, therapistCut: 1000 },
  C120: { name: "C課程 120分", duration: 120, price: 2800, therapistCut: 1600 },
  C90: { name: "C課程 90分", duration: 90, price: 2500, therapistCut: 1400 },
  D120: { name: "D課程 120分", duration: 120, price: 2400, therapistCut: 1400 },
  D90: { name: "D課程 90分", duration: 90, price: 2100, therapistCut: 1200 },
  OUT_DAY: { name: "外出 (22:00前)", duration: 120, price: 3200, therapistCut: 2000 },
  OUT_NIGHT: { name: "外出 (22:00後)", duration: 120, price: 3500, therapistCut: 2200 }
};

let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let monthDates = [];
let monthWeeks = [];
let currentUser = null;
let activeTab = "overview";
let activeAppointmentView = "card";
let activePersonnelPanel = "schedule";
let activeReportPanel = "revenue";
let currentScheduleViewDates = [];
let editingAppointmentId = null;
let activeAppointmentId = null;
let liveTimer = null;

const $ = (id) => document.getElementById(id);
const esc = (value = "") => String(value).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const todayKey = () => toDateKey(new Date());
const money = (n) => `$${(Number(n) || 0).toLocaleString()}`;
const courseName = (code) => COURSE_CATALOG[code]?.name || code || "自訂服務";
const therapistName = (id) => db.therapists[id]?.nickname || db.therapists[id]?.name || "未知";
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
  bio: ""
};

const therapistProfileKey = (id) => `SYS_THERAPIST_PROFILE_${id}`;
const APPROVAL_PREFIX = "SYS_APPROVAL_";
const approvalKey = (id) => `${APPROVAL_PREFIX}${id}`;
const approvalTypeLabel = (type) => ({ profile: "人事資料", schedule: "班表", password: "密碼" }[type] || type);
const approvalStatusLabel = (status) => ({ pending: "待審核", approved: "已核可", rejected: "已退回" }[status] || status);

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

let db = seedDatabase();
let syncMeta = loadSyncMeta();

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
  const now = new Date();
  const today = toDateKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowKey = toDateKey(tomorrow);
  const base = {
    therapists: {
      T001: { name: "小雅", pin: "1111" },
      T002: { name: "Mina", pin: "2222" },
      T003: { name: "Nora", pin: "3333" }
    },
    admins: { admin: { name: "系統總管理員", pin: "admin123", email: "" } },
    schedules: {
      T001: { [today]: "13:00-22:00", [tomorrowKey]: "15:00-23:00" },
      T002: { [today]: "12:00-20:00", [tomorrowKey]: "休假" },
      T003: { [today]: "18:00-02:00", [tomorrowKey]: "18:00-02:00" }
    },
    appointments: {
      "APT-demo-1": { id: "APT-demo-1", date: today, time: "14:00", duration: 90, therapistId: "T001", service: "C90", price: 2500, room: "R", customerName: "林小姐", phone: "line-lin", isCompleted: false, collectedPrice: "" },
      "APT-demo-2": { id: "APT-demo-2", date: today, time: "19:30", duration: 120, therapistId: "T003", service: "D120", price: 2400, room: "T", customerName: "陳先生", phone: "0912-000-123", isCompleted: false, collectedPrice: "" }
    },
    customers: {
      "line-lin": { name: "林小姐", notes: "偏好肩頸加強，怕冷。", records: [{ id: "APT-demo-1", date: today, therapistId: "T001", therapistName: "小雅", service: "C90", notes: "肩頸緊繃，左肩較明顯。", collectedPrice: "" }] },
      "0912-000-123": { name: "陳先生", notes: "熟客，習慣晚間預約。", records: [] },
      SYS_DOOR_PWD: { name: "設定", notes: "2580", records: [] }
    }
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.therapists && saved?.appointments) return normalizeDb(saved);
  } catch {}
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
  Object.keys(data.therapists).forEach((id) => {
    data.therapists[id] = normalizeTherapistProfile(data.therapists[id]);
  });
  Object.keys(data.admins).forEach((id) => {
    data.admins[id].pin = cleanPin(data.admins[id].pin);
  });
  Object.entries(data.appointments).forEach(([id, appt]) => {
    appt.id = appt.id || id;
    appt.date = normalizeDateField(appt.date);
    appt.time = normalizeTimeField(appt.time);
    appt.duration = Number(appt.duration || 60);
    appt.price = Number(appt.price || 0);
    appt.collectedPrice = cleanPin(appt.collectedPrice || "");
    appt.customerName = String(appt.customerName || "").trim();
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

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
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
  localStorage.setItem(SYNC_META_KEY, JSON.stringify(syncMeta));
}

function backupLocalDb(reason) {
  try {
    localStorage.setItem(`${LOCAL_BACKUP_PREFIX}-${Date.now()}`, JSON.stringify({
      reason,
      at: new Date().toISOString(),
      db
    }));
  } catch {}
}

function markSyncPending(isPending, reason = "") {
  syncMeta.pending = isPending;
  syncMeta.reason = reason;
  syncMeta.source = isPending ? "local" : "cloud";
  syncMeta.lastSync = isPending ? syncMeta.lastSync : new Date().toISOString();
  saveSyncMeta();
}

async function tryCloudSync() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_URL}?t=${Date.now()}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cloudDb = normalizeDb(await res.json());
    if (syncMeta.pending) {
      $("sysStatus").textContent = "雲端已連線；此裝置有未同步資料，暫保留本機版本";
      return;
    }
    backupLocalDb("before-cloud-authoritative-sync");
    db = cloudDb;
    persist();
    markSyncPending(false);
    $("sysStatus").textContent = "已連線雲端資料";
  } catch {
    $("sysStatus").textContent = "雲端未連線，使用本機測試資料";
  } finally {
    clearTimeout(timeout);
  }
}

async function postCloud(action, data) {
  persist();
  const hadFailedWrite = syncMeta.pending && syncMeta.reason === "last-write-failed";
  if (!hadFailedWrite) markSyncPending(true, "uploading");
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify({ action, data }),
      redirect: "manual"
    });
    const accepted = res.ok || res.status === 302 || res.type === "opaqueredirect" || (res.status >= 200 && res.status < 400);
    if (!accepted) throw new Error(`HTTP ${res.status}`);
    if (!hadFailedWrite) markSyncPending(false);
    return true;
  } catch {
    markSyncPending(true, "last-write-failed");
    showSnackbar("已先存於此瀏覽器；雲端寫入失敗，請檢查 Apps Script 權限");
    return false;
  }
}

async function saveCloudActions(actions, successMessage = "已儲存到雲端") {
  showSnackbar("正在寫入雲端...");
  const results = [];
  for (const item of actions) {
    results.push(await postCloud(item.action, item.data));
  }
  const ok = results.every(Boolean);
  showSnackbar(ok ? successMessage : "已保存在此裝置；雲端寫入失敗時，重新開啟會保留本機版本");
  return ok;
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
  const nowPercent = currentTimelinePercent();
  if (!segments.length) return `<div class="relative h-3 rounded-full bg-slate-100">${nowPercent === null ? "" : `<span class="schedule-now-line absolute -top-1 h-5 w-px bg-rose-500" style="left:${nowPercent}%"></span>`}</div>`;
  const total = SCHEDULE_WINDOW_END - SCHEDULE_WINDOW_START;
  const blocks = segments.map((seg) => {
    const start = normalizedTimelineMinute(seg.start);
    const end = normalizedTimelineMinute(seg.end);
    const left = Math.max(0, Math.min(total, start - SCHEDULE_WINDOW_START));
    const right = Math.max(0, Math.min(total, end - SCHEDULE_WINDOW_START));
    if (right <= 0 || left >= total) return "";
    const width = Math.max(3, right - left);
    return `<span class="absolute top-0 h-3 rounded-full bg-teal-500" title="${esc(seg.label)}" style="left:${(left / total) * 100}%;width:${(width / total) * 100}%"></span>`;
  }).join("");
  return `<div class="relative h-3 rounded-full bg-slate-100">${blocks}${nowPercent === null ? "" : `<span class="schedule-now-line absolute -top-1 h-5 w-px bg-rose-500" title="目前時間" style="left:${nowPercent}%"></span>`}</div>`;
}

function dailyScheduleBoardHtml(dateKey) {
  const working = Object.entries(db.therapists).map(([id, therapist]) => ({
    id,
    name: therapistName(id),
    shift: (db.schedules[id] || {})[dateKey] || "休假"
  })).filter((row) => isWorking(row.shift)).sort((a, b) => a.shift.localeCompare(b.shift));
  if (!working.length) return `<div class="rounded-xl bg-slate-50 p-6 text-center text-sm font-bold text-slate-400">今日尚無按摩師排班</div>`;
  return `<div class="space-y-3">
    <div class="grid grid-cols-[92px_1fr] gap-3 px-1 text-[10px] font-black text-slate-400">
      <span>按摩師</span>
      <div class="relative h-5">
        ${["11:00", "14:00", "17:00", "20:00", "23:00", "02:00"].map((label, index) => `<span class="absolute -translate-x-1/2" style="left:${(index / 5) * 100}%">${label}</span>`).join("")}
      </div>
    </div>
    ${working.map((row) => `<div class="grid grid-cols-[92px_1fr] items-center gap-3"><div><p class="truncate text-sm font-black">${esc(row.name)}</p><p class="text-[10px] font-bold text-teal-700">${esc(row.shift)}</p></div>${scheduleBarHtml(row.shift)}</div>`).join("")}
  </div>`;
}

function doorPasswordRecordHtml() {
  const records = db.customers.SYS_DOOR_PWD?.records || [];
  return records.length ? records.slice().reverse().map((r) => `<tr><td class="font-mono font-black">${esc(r.at || "")}</td><td class="font-black">${esc(r.value || "")}</td><td>${esc(r.reason || "手動更新")}</td></tr>`).join("") : `<tr><td colspan="3" class="py-8 text-center font-bold text-slate-400">尚無修改紀錄</td></tr>`;
}

function renderAll() {
  generateMonthData();
  renderOverview();
  renderAppointment();
  renderCustomers();
  renderPersonnel();
  renderReport();
  renderPortal();
}

function switchTab(tab) {
  if (tab === "schedule") {
    activePersonnelPanel = "schedule";
    tab = "personnel";
  }
  if (tab === "filter") tab = "appointment";
  if (tab === "appointmentDetail") tab = "appointment";
  activeTab = tab;
  document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
  $(`view-${tab}`)?.classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
  const titles = { overview: "總覽", appointment: "派班資料", customer: "顧客 CRM", personnel: "人事權限", report: "財務報表", portal: "個人中樞" };
  $("pageTitle").textContent = titles[tab] || "管理中樞";
  hideSidebar();
  renderAll();
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
  const thisWeekKeys = weekKeys(today, 0);
  const nextWeekScheduleKeys = weekKeys(today, 1);
  const thisWeekScheduled = Object.keys(db.therapists).filter((id) => thisWeekKeys.some((key) => isWorking((db.schedules[id] || {})[key]))).length;
  const nextWeekScheduled = Object.keys(db.therapists).filter((id) => nextWeekScheduleKeys.some((key) => isWorking((db.schedules[id] || {})[key]))).length;
  const now = new Date();
  const currentMins = now.getHours() * 60 + now.getMinutes();
  const todayRevenue = todayAppts.reduce((s, a) => s + Number(a.price || 0), 0);
  const todayCompanyCut = todayAppts.reduce((s, a) => s + companyCutFor(a), 0);
  const finishedToday = todayAppts.filter((a) => String(a.isCompleted) === "true").length;
  const ongoing = todayAppts.filter((a) => currentMins >= timeToMinutes(a.time) && currentMins < timeToMinutes(a.time) + Number(a.duration || 60));
  const upcoming = todayAppts.filter((a) => timeToMinutes(a.time) >= currentMins).slice(0, 4);
  const upcomingAll = todayAppts.filter((a) => timeToMinutes(a.time) >= currentMins);
  const nextAppt = upcoming[0];
  const pastUnfinished = appts.filter((a) => a.date < today && String(a.isCompleted) !== "true").sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  const needsCollection = appts.filter((a) => String(a.isCompleted) === "true" && !String(a.collectedPrice || "").trim()).slice(0, 5);
  const noRecordNotes = appts.filter((a) => {
    const record = appointmentRecord(a);
    return String(a.isCompleted) === "true" && !String(record?.notes || "").trim();
  }).slice(0, 5);
  const todayTimeline = todayAppts.length ? todayAppts.map((a) => {
    const start = timeToMinutes(a.time);
    const end = start + Number(a.duration || 60);
    const status = String(a.isCompleted) === "true" ? "已完成" : (currentMins >= start && currentMins < end ? "進行中" : (start > currentMins ? "待開始" : "待回報"));
    const statusClass = status === "進行中" ? "bg-teal-600 text-white" : status === "待回報" ? "bg-rose-100 text-rose-700" : status === "已完成" ? "bg-slate-200 text-slate-600" : "bg-amber-100 text-amber-700";
    return `<button data-open-appt="${esc(a.id)}" class="grid w-full grid-cols-[82px_1fr_auto] items-start gap-3 border-b border-slate-100 px-5 py-4 text-left last:border-b-0 hover:bg-teal-50/60">
      <div class="font-mono text-sm font-black text-slate-800">${esc(a.time)}<div class="mt-1 text-[11px] text-slate-400">${minsToTime(end)}</div></div>
      <div><div class="font-black">${esc(customerDisplay(a.phone, a.customerName))}</div><div class="mt-1 text-xs font-bold text-slate-500">${esc(therapistName(a.therapistId))} · ${esc(courseName(a.service))} · ${roomBadge(a.room)}</div>${a.notes ? `<div class="mt-2 line-clamp-1 text-xs font-bold text-slate-500">備註：${esc(a.notes)}</div>` : ""}</div>
      <span class="rounded-full px-2.5 py-1 text-xs font-black ${statusClass}">${status}</span>
    </button>`;
  }).join("") : `<div class="p-8 text-center font-bold text-slate-400">今日尚無預約</div>`;
  const taskCards = [
    { title: "逾期未完成", items: pastUnfinished, tone: "rose", empty: "沒有逾期未完成預約" },
    { title: "完成但未回款", items: needsCollection, tone: "amber", empty: "回款資料完整" },
    { title: "缺服務紀錄", items: noRecordNotes, tone: "slate", empty: "服務紀錄完整" }
  ].map((group) => `<div class="rounded-2xl border border-slate-200 bg-white p-4">
    <div class="mb-3 flex items-center justify-between"><h4 class="font-black">${group.title}</h4><span class="badge bg-slate-100 text-slate-600">${group.items.length}</span></div>
    <div class="space-y-2">${group.items.length ? group.items.map((a) => compactApptLine(a, group.tone)).join("") : `<p class="rounded-xl bg-slate-50 p-4 text-center text-sm font-bold text-slate-400">${group.empty}</p>`}</div>
  </div>`).join("");
  $("view-overview").innerHTML = `
    <div class="grid gap-5 xl:grid-cols-[1.35fr_.9fr]">
      <div class="card overflow-hidden">
        <div class="border-b bg-slate-950 p-6 text-white">
          <p class="text-xs font-black uppercase tracking-widest text-teal-300">今日營運指揮台</p>
          <div class="mt-2 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div><h3 class="text-2xl font-black">${today.replaceAll("-", "/")}</h3><p class="mt-1 text-sm font-bold text-slate-300">${nextAppt ? `下一筆 ${nextAppt.time} · ${customerDisplay(nextAppt.phone, nextAppt.customerName)}` : "今日沒有後續預約"}</p></div>
            <div class="flex flex-wrap gap-2"><button class="btn-teal" data-jump-tab="appointment">派班資料</button></div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-px bg-slate-200 xl:grid-cols-6">
          <div class="bg-white p-5"><p class="text-xs font-black text-slate-500">今日預約</p><p class="mt-1 text-3xl font-black text-teal-700">${todayAppts.length}</p><p class="mt-1 text-xs font-bold text-slate-400">完成 ${finishedToday} 筆</p></div>
          <div class="bg-white p-5"><p class="text-xs font-black text-slate-500">現場進行中</p><p class="mt-1 text-3xl font-black text-indigo-700">${ongoing.length}</p><p class="mt-1 text-xs font-bold text-slate-400">${ongoing[0] ? customerDisplay(ongoing[0].phone, ongoing[0].customerName) : "目前空檔"}</p></div>
          <div class="bg-white p-5"><p class="text-xs font-black text-slate-500">即將到來</p><p class="mt-1 text-3xl font-black text-amber-700">${upcomingAll.length}</p><p class="mt-1 text-xs font-bold text-slate-400">${nextAppt ? `${nextAppt.time} ${customerDisplay(nextAppt.phone, nextAppt.customerName)}` : "今日無後續"}</p></div>
          <div class="bg-white p-5"><p class="text-xs font-black text-slate-500">今日預估營收</p><p class="mt-1 text-3xl font-black text-rose-700">${money(todayRevenue)}</p><p class="mt-1 text-xs font-bold text-slate-400">平均 ${money(todayAppts.length ? Math.round(todayRevenue / todayAppts.length) : 0)}</p></div>
          <div class="bg-white p-5"><p class="text-xs font-black text-slate-500">今日預估店抽</p><p class="mt-1 text-3xl font-black text-slate-900">${money(todayCompanyCut)}</p><p class="mt-1 text-xs font-bold text-slate-400">師傅抽成 ${money(todayRevenue - todayCompanyCut)}</p></div>
          <div class="bg-white p-5">
            <div class="mb-2 flex items-center justify-between gap-2"><p class="text-xs font-black text-slate-500">大門密碼</p><span id="liveClock" class="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-700"></span></div>
            <input id="doorPassword" class="input py-2 text-2xl" value="${esc(db.customers.SYS_DOOR_PWD?.notes || "")}">
            <div class="mt-2 grid grid-cols-3 gap-1.5"><button id="randomDoorBtn" class="btn-light px-2 py-2 text-[11px]">隨機</button><button id="doorHistoryBtn" class="btn-light px-2 py-2 text-[11px]">紀錄</button><button id="saveDoorBtn" class="btn-teal px-2 py-2 text-[11px]">儲存</button></div>
          </div>
        </div>
      </div>
      <div class="grid gap-5">
        <div class="card p-5">
          <div class="mb-4 flex items-center justify-between gap-3">
            <div><h3 class="font-black">排班概況</h3><p class="text-xs font-bold text-slate-500">以有填班表的人員計算</p></div>
            <button class="btn-light px-3 py-2 text-xs" data-jump-tab="personnel" data-personnel-panel="schedule">班表</button>
          </div>
          <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-slate-200">
            <div class="bg-white p-4"><p class="text-xs font-black text-slate-500">本週</p><p class="mt-1 text-3xl font-black text-slate-900">${thisWeekScheduled}</p></div>
            <div class="bg-white p-4"><p class="text-xs font-black text-slate-500">下週</p><p class="mt-1 text-3xl font-black text-slate-900">${nextWeekScheduled}</p></div>
          </div>
        </div>
      </div>
    </div>
    <div class="card p-5">
      <div class="mb-4 flex items-center justify-between"><div><h3 class="font-black">當日排班按摩師</h3><p class="text-xs font-bold text-slate-500">11:00 到隔日 02:00，紅線為目前時間</p></div><span class="badge bg-teal-50 text-teal-700">${Object.keys(db.therapists).filter((id) => isWorking((db.schedules[id] || {})[today])).length} 人</span></div>
      ${dailyScheduleBoardHtml(today)}
    </div>
    <div class="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
      <div class="card overflow-hidden">
        <div class="flex items-center justify-between border-b bg-white px-5 py-4"><div><h3 class="font-black">今日流程</h3><p class="text-xs font-bold text-slate-500">點任一筆可在派班資料內編輯</p></div><span class="badge bg-teal-50 text-teal-700">${todayAppts.length} 筆</span></div>
        <div>${todayTimeline}</div>
      </div>
      <div class="space-y-5">${taskCards}</div>
    </div>
    `;
  $("saveDoorBtn").onclick = async () => {
    const previous = db.customers.SYS_DOOR_PWD || { name: "設定", notes: "", records: [] };
    const nextValue = $("doorPassword").value.trim();
    const records = previous.records || [];
    if (nextValue && nextValue !== previous.notes) {
      records.push({ at: new Date().toLocaleString("zh-TW", { hour12: false }), value: nextValue, reason: "手動更新" });
    }
    db.customers.SYS_DOOR_PWD = { name: "設定", notes: nextValue, records };
    await saveCloudActions([{ action: "saveCustomer", data: { phone: "SYS_DOOR_PWD", ...db.customers.SYS_DOOR_PWD } }], "大門密碼已更新到雲端");
  };
  $("randomDoorBtn").onclick = async () => {
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    $("doorPassword").value = code;
    const previous = db.customers.SYS_DOOR_PWD || { name: "設定", notes: "", records: [] };
    const records = previous.records || [];
    records.push({ at: new Date().toLocaleString("zh-TW", { hour12: false }), value: code, reason: "隨機四碼" });
    db.customers.SYS_DOOR_PWD = { name: "設定", notes: code, records };
    await saveCloudActions([{ action: "saveCustomer", data: { phone: "SYS_DOOR_PWD", ...db.customers.SYS_DOOR_PWD } }], "已產生並儲存隨機大門密碼");
  };
  $("doorHistoryBtn").onclick = () => {
    showModal(`<div class="modal max-w-2xl"><h3 class="mb-5 border-b pb-4 text-xl font-black">大門密碼修改紀錄</h3><div class="table-wrap"><table><thead><tr><th>時間</th><th>密碼</th><th>來源</th></tr></thead><tbody>${doorPasswordRecordHtml()}</tbody></table></div><div class="mt-5 flex justify-end border-t pt-4"><button class="btn-light" data-close-modal>關閉</button></div></div>`);
  };
  $("view-overview").querySelectorAll("[data-jump-tab]").forEach((btn) => btn.onclick = () => {
    if (btn.dataset.personnelPanel) activePersonnelPanel = btn.dataset.personnelPanel;
    switchTab(btn.dataset.jumpTab);
  });
  $("view-overview").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
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

function renderAppointment() {
  const section = $("view-appointment");
  const selectedDate = $("appointmentDate")?.value || todayKey();
  section.innerHTML = `
    <div class="card p-5">
      <div class="flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
        <div><h3 class="text-lg font-black">派班資料</h3><p class="text-sm font-bold text-slate-500">選日期後直接從師傅看板新增派班，並在同頁管理每筆派班資料。</p></div>
        <div class="flex flex-col gap-3 md:flex-row md:items-end">
          <div><label class="label">日期</label><input id="appointmentDate" type="date" class="input py-2" value="${selectedDate}"></div>
          <div class="flex rounded-xl bg-slate-100 p-1">
            <button id="apptCardBtn" class="rounded-lg px-4 py-2 text-sm font-black">師傅視角</button>
            <button id="apptTimelineBtn" class="rounded-lg px-4 py-2 text-sm font-black">房型時程</button>
          </div>
        </div>
      </div>
    </div>
    <div id="appointmentBoard" class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3"></div>
    <div id="appointmentTimeline" class="hidden overflow-x-auto"></div>
    <div id="appointmentDataPanel"></div>`;
  $("appointmentDate").onchange = renderAppointment;
  $("apptCardBtn").onclick = () => { activeAppointmentView = "card"; renderAppointmentBoard(selectedDate); };
  $("apptTimelineBtn").onclick = () => { activeAppointmentView = "timeline"; renderAppointmentBoard(selectedDate); };
  renderAppointmentBoard(selectedDate);
  renderAppointmentDetail();
}

function renderAppointmentBoard(date) {
  $("appointmentBoard").classList.toggle("hidden", activeAppointmentView !== "card");
  $("appointmentTimeline").classList.toggle("hidden", activeAppointmentView !== "timeline");
  $("apptCardBtn").className = activeAppointmentView === "card" ? "rounded-lg bg-white px-4 py-2 text-sm font-black text-teal-700 shadow" : "rounded-lg px-4 py-2 text-sm font-black text-slate-500";
  $("apptTimelineBtn").className = activeAppointmentView === "timeline" ? "rounded-lg bg-white px-4 py-2 text-sm font-black text-teal-700 shadow" : "rounded-lg px-4 py-2 text-sm font-black text-slate-500";
  const appts = Object.values(db.appointments).filter((a) => a.date === date).sort(sortByTime);
  const board = $("appointmentBoard");
  board.innerHTML = "";
  Object.entries(db.therapists).forEach(([id, therapist]) => {
    const shift = (db.schedules[id] || {})[date] || "休假";
    if (!isWorking(shift)) return;
    const mine = appts.filter((a) => a.therapistId === id);
    board.insertAdjacentHTML("beforeend", `
      <article class="card overflow-hidden">
        <div class="flex items-center justify-between border-b bg-teal-50 px-5 py-4">
          <div class="flex items-center gap-3"><div class="flex h-10 w-10 items-center justify-center rounded-full bg-teal-700 font-black text-white">${esc(therapistName(id).charAt(0) || "師")}</div><div><h4 class="font-black">${esc(therapistName(id))}</h4><p class="text-xs font-black text-teal-700">${esc(shift)}</p></div></div>
          <button class="btn-teal add-appt" data-therapist="${id}" data-date="${date}">新增</button>
        </div>
        <div class="space-y-3 bg-slate-50/60 p-4">${mine.length ? mine.map(apptCard).join("") : `<p class="py-8 text-center text-sm font-bold text-slate-400">目前無排程</p>`}</div>
      </article>`);
  });
  if (!board.innerHTML) board.innerHTML = `<div class="col-span-full rounded-2xl bg-white py-12 text-center font-bold text-slate-400">當日無排班</div>`;
  board.querySelectorAll(".add-appt").forEach((btn) => btn.onclick = () => openAppointmentModal({ therapistId: btn.dataset.therapist, date: btn.dataset.date }));
  board.querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
  board.querySelectorAll("[data-edit-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.editAppt));
  board.querySelectorAll("[data-delete-appt]").forEach((btn) => btn.onclick = () => confirmAction("刪除預約", "此動作會移除該筆預約與關聯紀錄。", () => deleteAppointment(btn.dataset.deleteAppt)));
  renderTimeline(date, appts);
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

function openAppointmentModal({ therapistId, date, appointmentId, time = "" }) {
  editingAppointmentId = appointmentId || null;
  const existing = appointmentId ? db.appointments[appointmentId] : null;
  const selectedTherapist = existing?.therapistId || therapistId;
  const selectedDate = existing?.date || date || $("appointmentDate")?.value || todayKey();
  const serviceOptions = [`<option value="">自訂/其他項目</option>`].concat(Object.entries(COURSE_CATALOG).map(([k, c]) => `<option value="${k}" ${existing?.service === k ? "selected" : ""}>${esc(c.name)} (${money(c.price)})</option>`)).join("");
  showModal(`
    <div class="modal max-w-xl">
      <h3 class="mb-5 border-b pb-4 text-xl font-black">${existing ? "修改預約" : "新增顧客預約"} <span class="ml-2 rounded-lg bg-teal-50 px-2 py-1 text-sm text-teal-700">${esc(selectedDate)}</span></h3>
      <form id="apptForm" class="space-y-4">
        <div><label class="label">指定按摩師</label><select name="therapistId" class="input">${Object.keys(db.therapists).map((id) => `<option value="${id}" ${id === selectedTherapist ? "selected" : ""}>${esc(therapistName(id))}</option>`).join("")}</select></div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div><label class="label">服務課程</label><select name="service" class="input">${serviceOptions}</select></div>
          <div><label class="label">應收金額</label><input name="price" type="number" class="input" value="${esc(existing?.price || "")}"></div>
          <div><label class="label">預約時間</label><input name="time" type="time" class="input" value="${esc(existing?.time || time || "")}"></div>
          <div><label class="label">預估時長</label><input name="duration" type="number" min="10" step="10" class="input" value="${esc(existing?.duration || 60)}"></div>
        </div>
        <div><label class="label">工作室安排</label><select name="room" class="input"><option value="R">Royal (R房)</option><option value="T">Tiffany (T房)</option><option value="OUT">外出</option></select><p id="roomHint" class="mt-2 hidden rounded-lg p-2 text-xs font-black"></p></div>
        <div><label class="label">聯絡方式</label><input name="phone" class="input" value="${esc(existing?.phone || "")}"></div>
        <div><label class="label">顧客姓名 <span class="text-slate-400">(選填)</span></label><input name="customerName" class="input" value="${esc(existing?.customerName || "")}" placeholder="未填則顯示顧客編碼"></div>
        <div><label class="label">備註</label><textarea name="notes" class="input min-h-24" placeholder="例如：客人偏好、特殊需求、櫃檯交接事項">${esc(existing?.notes || "")}</textarea></div>
        <p id="apptError" class="hidden text-sm font-black text-rose-600"></p>
        <div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">${existing ? "更新預約" : "儲存預約"}</button></div>
      </form>
    </div>`);
  const form = $("apptForm");
  form.room.value = existing?.room || "R";
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
  data.isCompleted = db.appointments[data.id]?.isCompleted || false;
  data.collectedPrice = db.appointments[data.id]?.collectedPrice || "";
  data.customerName = String(data.customerName || "").trim();
  data.phone = String(data.phone || "").trim();
  if (!data.time || !data.phone) {
    $("apptError").textContent = "時間與聯絡方式必填；顧客姓名可留空。";
    $("apptError").classList.remove("hidden");
    return;
  }
  const conflict = findAppointmentConflict(data);
  const commit = async () => {
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
    const record = { id: data.id, date: data.date, therapistId: data.therapistId, therapistName: therapistName(data.therapistId), service: data.service, notes: customer.records[recordIndex]?.notes || "", collectedPrice: data.collectedPrice || "" };
    if (recordIndex >= 0) customer.records[recordIndex] = record;
    else customer.records.push(record);
    db.customers[data.phone] = customer;
    await saveCloudActions([
      { action: "addAppointment", data },
      { action: "saveCustomer", data: { phone: data.phone, ...customer } }
    ], "預約已寫入雲端");
    setFormBusy(form, false);
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
  const appt = db.appointments[id];
  delete db.appointments[id];
  if (appt && db.customers[appt.phone]?.records) db.customers[appt.phone].records = db.customers[appt.phone].records.filter((r) => r.id !== id);
  if (activeAppointmentId === id) activeAppointmentId = null;
  await saveCloudActions([{ action: "deleteAppointment", data: { appId: id } }], "預約已刪除");
  renderAll();
}

function openAppointmentDetailPage(id) {
  activeAppointmentId = id || null;
  switchTab("appointment");
}

function appointmentRecord(appt) {
  return db.customers[appt.phone]?.records?.find((r) => r.id === appt.id);
}

function renderAppointmentDetail() {
  const section = $("appointmentDataPanel") || $("view-appointmentDetail");
  if (!section) return;
  const appts = Object.values(db.appointments).sort((a, b) => a.date === b.date ? sortByTime(a, b) : String(b.date).localeCompare(String(a.date)));
  const active = activeAppointmentId ? db.appointments[activeAppointmentId] : null;
  section.innerHTML = active ? renderAppointmentDetailForm(active, appts) : renderAppointmentListPage(appts);
  section.querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
  section.querySelectorAll("[data-delete-appt]").forEach((btn) => btn.onclick = () => confirmAction("刪除預約", "此動作會移除該筆預約與關聯紀錄。", () => deleteAppointment(btn.dataset.deleteAppt)));
  const backBtn = $("backToAppointmentListBtn");
  if (backBtn) backBtn.onclick = () => { activeAppointmentId = null; renderAppointmentDetail(); };
  const cancelBtn = $("cancelAppointmentDetailBtn");
  if (cancelBtn) cancelBtn.onclick = () => { activeAppointmentId = null; renderAppointmentDetail(); };
  section.querySelectorAll("[data-reset-appointment-data]").forEach((btn) => btn.onclick = () => { activeAppointmentId = null; renderAppointmentDetail(); });
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
}

function renderAppointmentListPage(appts) {
  const monthSet = new Set(monthDates.map((d) => d.key));
  const monthAppts = appts.filter((a) => monthSet.has(a.date));
  const rows = monthAppts.length ? monthAppts.map((a) => {
    const cut = COURSE_CATALOG[a.service]?.therapistCut || 0;
    return `<tr>
      <td><button data-open-appt="${esc(a.id)}" class="font-mono font-black text-teal-700 hover:text-teal-900">${esc(a.date)} ${esc(a.time)}</button></td>
      <td><button data-open-appt="${esc(a.id)}" class="text-left font-black hover:text-teal-700">${esc(customerDisplay(a.phone, a.customerName))}</button><div class="text-xs text-slate-500">${esc(a.phone || "")}</div></td>
      <td class="font-bold">${esc(therapistName(a.therapistId))}</td>
      <td>${roomBadge(a.room)}</td>
      <td>${esc(courseName(a.service))}</td>
      <td class="max-w-[220px] truncate text-slate-600">${esc(a.notes || "無")}</td>
      <td class="text-right font-black text-rose-600">${money(a.price)}</td>
      <td class="text-right font-black text-teal-700">${money(Number(a.price || 0) - cut)}</td>
      <td class="text-right"><button data-open-appt="${esc(a.id)}" class="btn-light px-3 py-1 text-xs">編輯</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="9" class="py-10 text-center font-bold text-slate-400">本月無派班資料</td></tr>`;
  return `<div class="card p-5">
    <div class="mb-5 flex flex-col justify-between gap-4 border-b pb-5 sm:flex-row sm:items-center">
      <div><h3 class="text-lg font-black">派班資料清單</h3><p class="text-sm font-bold text-slate-500">本月所有派班集中在同一頁管理，點任一筆即可在此編輯。</p></div>
      <button class="btn-light" data-reset-appointment-data>顯示清單</button>
    </div>
    <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
      ${metric("本月預約筆數", monthAppts.length)}
      ${metric("本月預估營業額", money(monthAppts.reduce((sum, a) => sum + Number(a.price || 0), 0)), "text-rose-700")}
      ${metric("已完成", monthAppts.filter((a) => String(a.isCompleted) === "true").length, "text-teal-700")}
      ${metric("待回報", monthAppts.filter((a) => String(a.isCompleted) !== "true").length, "text-indigo-700")}
    </div>
    <div class="table-wrap mt-5"><table><thead><tr><th>派班時間</th><th>顧客</th><th>師傅</th><th>空間</th><th>服務</th><th>備註</th><th class="text-right">金額</th><th class="text-right">店收</th><th class="text-right">操作</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

function renderAppointmentDetailForm(appt, allAppts) {
  const record = appointmentRecord(appt) || {};
  const cut = COURSE_CATALOG[appt.service]?.therapistCut || 0;
  const sameCustomer = allAppts.filter((a) => a.phone && a.phone === appt.phone).length;
  const serviceOptions = [`<option value="">自訂/其他項目</option>`].concat(Object.entries(COURSE_CATALOG).map(([key, course]) => `<option value="${key}" ${appt.service === key ? "selected" : ""}>${esc(course.name)} (${money(course.price)})</option>`)).join("");
  return `<div class="grid gap-5 xl:grid-cols-[1fr_360px]">
    <form id="appointmentDetailForm" class="card p-5">
      <div class="mb-5 flex flex-col justify-between gap-4 border-b pb-5 sm:flex-row sm:items-center">
        <div><p class="text-xs font-black uppercase tracking-widest text-slate-500">派班資料</p><h3 class="text-xl font-black">${esc(customerDisplay(appt.phone, appt.customerName))}</h3><p class="text-xs font-bold text-slate-500">ID：${esc(appt.id)}</p></div>
        <div class="flex gap-2"><button id="backToAppointmentListBtn" type="button" class="btn-light">返回清單</button><button data-delete-appt="${esc(appt.id)}" type="button" class="rounded-xl bg-rose-50 px-4 py-2 font-black text-rose-700">刪除</button></div>
      </div>
      <div class="grid gap-4 md:grid-cols-2">
        <div><label class="label">預約日期</label><input name="date" type="date" class="input" value="${esc(appt.date || todayKey())}"></div>
        <div><label class="label">預約時間</label><input name="time" type="time" class="input" value="${esc(appt.time || "")}"></div>
        <div><label class="label">指定按摩師</label><select name="therapistId" class="input">${Object.keys(db.therapists).map((id) => `<option value="${esc(id)}" ${id === appt.therapistId ? "selected" : ""}>${esc(therapistName(id))}</option>`).join("")}</select></div>
        <div><label class="label">工作室安排</label><select name="room" class="input"><option value="R" ${appt.room === "R" ? "selected" : ""}>Royal (R房)</option><option value="T" ${appt.room === "T" ? "selected" : ""}>Tiffany (T房)</option><option value="OUT" ${appt.room === "OUT" ? "selected" : ""}>外出</option></select></div>
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
      <div class="mt-5 flex justify-end gap-3 border-t pt-4"><button id="cancelAppointmentDetailBtn" type="button" class="btn-light">取消</button><button class="btn-teal">儲存派班資料</button></div>
    </form>
    <aside class="space-y-4">
      <div class="card p-5"><h4 class="mb-4 font-black">帳務摘要</h4><div class="space-y-3">${metric("應收金額", money(appt.price), "text-rose-700")}${metric("店家應收", money(Number(appt.price || 0) - cut), "text-teal-700")}${metric("師傅抽成", money(cut), "text-indigo-700")}</div></div>
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
    isCompleted: data.isCompleted === "on",
    collectedPrice: data.collectedPrice || "",
    phone: String(data.phone || "").trim(),
    customerName: String(data.customerName || "").trim(),
    notes: String(data.notes || "").trim()
  };
  const err = $("appointmentDetailError");
  if (!next.date || !next.time || !next.phone) {
    err.textContent = "日期、時間與聯絡方式必填；顧客姓名可留空。";
    err.classList.remove("hidden");
    return;
  }
  const commit = async () => {
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
    await saveCloudActions([
      { action: "addAppointment", data: next },
      { action: "saveCustomer", data: { phone: next.phone, ...customer } }
    ], "派班資料已寫入雲端");
    setFormBusy(form, false);
    renderAll();
    activeAppointmentId = next.id;
    switchTab("appointment");
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
      <input id="customerSearchInput" class="input mb-5" placeholder="搜尋顧客編碼、姓名或聯絡方式">
      <div class="table-wrap"><table><thead><tr><th>顧客編碼</th><th>聯絡方式</th><th>顧客姓名</th><th>累積預約</th><th>偏好備註</th><th class="text-right">操作</th></tr></thead><tbody id="customerRows"></tbody></table></div>
    </div>`;
  $("addCustomerBtn").onclick = () => openCustomerModal();
  $("customerSearchInput").oninput = drawCustomerRows;
  drawCustomerRows();
}

function drawCustomerRows() {
  const rows = $("customerRows");
  if (!rows) return;
  const q = ($("customerSearchInput")?.value || "").trim().toLowerCase();
  const html = Object.entries(db.customers).filter(([phone, c]) => !isSystemCustomerKey(phone) && (!q || phone.toLowerCase().includes(q) || String(c.code || "").toLowerCase().includes(q) || String(c.name || "").toLowerCase().includes(q))).map(([phone, c]) => {
    const count = Object.values(db.appointments).filter((a) => a.phone === phone).length;
    return `<tr><td class="font-mono font-black text-teal-700">${esc(c.code || "")}</td><td class="font-mono font-black text-indigo-700">${esc(phone)}</td><td class="font-black">${esc(c.name || "未填寫")}</td><td>${count <= 1 ? `<span class="badge border-emerald-200 bg-emerald-50 text-emerald-700">新客 (${count})</span>` : `<span class="badge border-amber-200 bg-amber-50 text-amber-800">熟客 (${count})</span>`}</td><td class="max-w-[280px] truncate">${esc(c.notes || "無")}</td><td class="text-right"><button class="btn-light px-3 py-1 text-xs" data-record="${esc(phone)}">檔案</button> <button class="rounded-lg bg-rose-50 px-3 py-1 text-xs font-black text-rose-700" data-delete-customer="${esc(phone)}">刪除</button></td></tr>`;
  }).join("");
  rows.innerHTML = html || `<tr><td colspan="6" class="py-8 text-center font-bold text-slate-400">無符合顧客</td></tr>`;
  rows.querySelectorAll("[data-record]").forEach((btn) => btn.onclick = () => openCustomerModal(btn.dataset.record, true));
  rows.querySelectorAll("[data-delete-customer]").forEach((btn) => btn.onclick = () => confirmAction("刪除 CRM 檔案", "顧客基本資料與服務紀錄將移除。", async () => {
    delete db.customers[btn.dataset.deleteCustomer];
    await saveCloudActions([{ action: "deleteCustomer", data: { phone: btn.dataset.deleteCustomer } }], "顧客檔案已刪除");
    renderAll();
  }));
}

function openCustomerModal(phone = "", recordsOpen = false) {
  const c = phone ? db.customers[phone] : null;
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
        <div><h4 class="mb-3 font-black">歷史紀錄 <span class="badge bg-indigo-50 text-indigo-700">${c?.records?.length || 0}</span></h4><div id="recordList" class="space-y-3">${renderRecordList(phone)}</div></div>` : ""}
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
    db.customers[data.phone] = { code: db.customers[data.phone]?.code, name: data.name.trim(), notes: data.notes.trim(), records: db.customers[data.phone]?.records || [] };
    assignCustomerCodes(db);
    setFormBusy(event.currentTarget, true);
    await saveCloudActions([{ action: "saveCustomer", data: { phone: data.phone, ...db.customers[data.phone] } }], "顧客資料已寫入雲端");
    setFormBusy(event.currentTarget, false);
    closeModal();
    renderAll();
  };
  if ($("addRecordBtn")) $("addRecordBtn").onclick = () => addCustomerRecord(phone);
  $("modalRoot").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => {
    closeModal();
    openAppointmentDetailPage(btn.dataset.openAppt);
  });
}

function renderRecordList(phone) {
  const records = [...(db.customers[phone]?.records || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return records.length ? records.map((r) => `<div class="rounded-xl border bg-white p-3"><div class="mb-1 flex justify-between gap-2"><b>${esc(r.date)}</b><span class="badge bg-slate-100 text-slate-600">${esc(courseName(r.service))}</span></div><p class="text-xs font-black text-teal-700">${esc(r.therapistName || therapistName(r.therapistId))}</p><p class="mt-1 whitespace-pre-wrap text-sm text-slate-600">${esc(r.notes || "尚未填寫細節")}</p>${db.appointments[r.id] ? `<button type="button" class="btn-light mt-3 px-3 py-1 text-xs" data-open-appt="${esc(r.id)}">開啟派班資料</button>` : ""}</div>`).join("") : `<div class="rounded-xl border border-dashed py-6 text-center text-sm font-bold text-slate-400">無紀錄</div>`;
}

async function addCustomerRecord(phone) {
  const therapistId = $("recordTherapist").value;
  const service = $("recordService").value.trim();
  const record = { id: `REC-${Date.now().toString(36)}`, date: $("recordDate").value, therapistId, therapistName: therapistName(therapistId), service, collectedPrice: $("recordCollectedPrice").value.trim(), notes: $("recordNotes").value.trim() };
  db.customers[phone].records ||= [];
  db.customers[phone].records.push(record);
  await saveCloudActions([{ action: "saveCustomer", data: { phone, ...db.customers[phone] } }], "服務紀錄已寫入雲端");
  $("recordList").innerHTML = renderRecordList(phone);
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
  currentScheduleViewDates = buildDateRange($("scheduleStartDate").value, $("scheduleEndDate").value);
  $("scheduleHeader").innerHTML = `<th class="sticky left-0 z-10 bg-slate-50">按摩師</th>` + currentScheduleViewDates.map((d) => `<th class="${d.isWeekend ? "text-rose-600" : ""}">${esc(d.displayShort)}</th>`).join("");
  $("scheduleRows").innerHTML = Object.keys(db.therapists).map((id) => `<tr><td class="sticky left-0 bg-white font-black">${esc(therapistName(id))} <button class="ml-2 rounded bg-slate-100 px-2 py-1 text-xs" data-edit-schedule="${id}">✎</button></td>${currentScheduleViewDates.map((d) => `<td class="${isWorking((db.schedules[id] || {})[d.key]) ? "font-bold text-slate-700" : "text-slate-400"}">${esc((db.schedules[id] || {})[d.key] || "休假")}</td>`).join("")}</tr>`).join("");
  $("scheduleRows").querySelectorAll("[data-edit-schedule]").forEach((btn) => btn.onclick = () => openScheduleModal(btn.dataset.editSchedule));
}

function openScheduleModal(id) {
  showModal(`<div class="modal max-w-4xl"><h3 class="mb-5 border-b pb-4 text-xl font-black">強制編輯：${esc(therapistName(id))}</h3><form id="scheduleForm" class="space-y-4"><div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${currentScheduleViewDates.map((d) => `<label class="rounded-xl border bg-slate-50 p-3"><span class="label ${d.isWeekend ? "text-rose-600" : ""}">${esc(d.displayFull)}</span><input class="input py-2" name="${d.key}" value="${esc((db.schedules[id] || {})[d.key] || "")}" placeholder="休假 / 13:00-22:00"></label>`).join("")}</div><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">覆寫紀錄</button></div></form></div>`);
  $("scheduleForm").onsubmit = async (event) => {
    event.preventDefault();
    setFormBusy(event.currentTarget, true);
    db.schedules[id] ||= {};
    Object.entries(Object.fromEntries(new FormData(event.currentTarget).entries())).forEach(([date, value]) => db.schedules[id][date] = normalizeShift(value));
    await saveCloudActions([{ action: "saveSchedule", data: { id, schedule: db.schedules[id] } }], "班表已寫入雲端");
    setFormBusy(event.currentTarget, false);
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
  downloadCSV(csv, `排班總表_${$("scheduleStartDate").value}_至_${$("scheduleEndDate").value}.csv`);
}

function therapistProfileFields(profile = {}) {
  return `
    <div><label class="label">暱稱</label><input name="nickname" class="input" value="${esc(profile.nickname || "")}" placeholder="例如：Noah"></div>
    <div><label class="label">姓名</label><input name="name" class="input" value="${esc(profile.name || "")}" placeholder="真實姓名"></div>
    <div><label class="label">聯絡方式</label><input name="contact" class="input" value="${esc(profile.contact || "")}" placeholder="電話 / Line ID"></div>
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
  const existing = db.therapists[data.id] || {};
  db.therapists[data.id] = normalizeTherapistProfile({ ...existing, ...data });
  db.schedules[data.id] ||= {};
  const { pin, ...profile } = db.therapists[data.id];
  db.customers[therapistProfileKey(data.id)] = { name: profile.nickname || profile.name || data.id, notes: JSON.stringify(profile), records: [] };
  return saveCloudActions([
    { action: "addTherapist", data: { ...db.therapists[data.id], id: data.id, pin: sheetText(data.pin) } },
    { action: "saveCustomer", data: { phone: therapistProfileKey(data.id), ...db.customers[therapistProfileKey(data.id)] } }
  ], "按摩師資料已寫入雲端");
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
    return `<div class="mt-3 rounded-xl bg-slate-50 p-3 text-sm font-bold text-slate-600">新 PIN 為 4 位數字，核可後才會更新登入密碼。</div>`;
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
  const next = { ...item, ...extra, status, updatedAt: new Date().toISOString(), reviewedBy: currentUser?.id || "" };
  db.approvals[next.id] = next;
  db.customers[approvalKey(next.id)] = {
    name: `${approvalStatusLabel(status)}-${approvalTypeLabel(next.type)}-${therapistName(next.therapistId)}`,
    notes: JSON.stringify(next),
    records: []
  };
  await saveCloudActions([{ action: "saveCustomer", data: { phone: approvalKey(next.id), ...db.customers[approvalKey(next.id)] } }], `申請已${approvalStatusLabel(status)}`);
}

async function approveRequest(id) {
  const item = db.approvals[id];
  if (!item || item.status !== "pending") return;
  const therapistId = item.therapistId;
  const therapist = db.therapists[therapistId] || { pin: "" };
  const actions = [];

  if (item.type === "profile") {
    db.therapists[therapistId] = normalizeTherapistProfile({ ...therapist, ...item.data, id: therapistId, pin: therapist.pin });
    const { pin, ...profile } = db.therapists[therapistId];
    db.customers[therapistProfileKey(therapistId)] = { name: profile.nickname || profile.name || therapistId, notes: JSON.stringify(profile), records: [] };
    actions.push(
      { action: "addTherapist", data: { ...db.therapists[therapistId], id: therapistId, pin: sheetText(pin) } },
      { action: "saveCustomer", data: { phone: therapistProfileKey(therapistId), ...db.customers[therapistProfileKey(therapistId)] } }
    );
  } else if (item.type === "password") {
    db.therapists[therapistId] = normalizeTherapistProfile({ ...therapist, pin: cleanPin(item.data?.pin) });
    actions.push({ action: "addTherapist", data: { ...db.therapists[therapistId], id: therapistId, pin: sheetText(db.therapists[therapistId].pin) } });
  } else if (item.type === "schedule") {
    db.schedules[therapistId] = { ...(db.schedules[therapistId] || {}), ...(item.data?.schedule || {}) };
    actions.push({ action: "saveSchedule", data: { id: therapistId, schedule: db.schedules[therapistId] } });
  }

  const next = { ...item, status: "approved", updatedAt: new Date().toISOString(), reviewedBy: currentUser?.id || "" };
  db.approvals[id] = next;
  db.customers[approvalKey(id)] = { name: `已核可-${approvalTypeLabel(item.type)}-${therapistName(therapistId)}`, notes: JSON.stringify(next), records: [] };
  actions.push({ action: "saveCustomer", data: { phone: approvalKey(id), ...db.customers[approvalKey(id)] } });
  await saveCloudActions(actions, "申請已核可並套用");
  renderAll();
}

async function rejectRequest(id) {
  const item = db.approvals[id];
  if (!item || item.status !== "pending") return;
  await updateApprovalRecord(item, "rejected");
  renderAll();
}

function renderPersonnel() {
  const section = $("view-personnel");
  const scheduleStart = $("scheduleStartDate")?.value || monthDates[0]?.key || todayKey();
  const scheduleEnd = $("scheduleEndDate")?.value || monthDates.at(-1)?.key || todayKey();
  const pendingCount = approvalsList("pending").length;
  const panelBtn = (panel, label) => `<button class="rounded-lg px-4 py-2 text-sm font-black ${activePersonnelPanel === panel ? "bg-white text-teal-700 shadow" : "text-slate-500"}" data-personnel-panel="${panel}">${label}${panel === "approvals" && pendingCount ? ` <span class="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">${pendingCount}</span>` : ""}</button>`;
  const approvalPanel = `
    <div class="card overflow-hidden">
      <div class="border-b bg-slate-50 p-5">
        <h3 class="font-black">前台變更審核</h3>
        <p class="mt-1 text-sm font-bold text-slate-500">師傅在前台提出的人事資料、密碼與班表變更，都需在此核可後才會套用。</p>
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
              ${item.status === "pending" ? `<div class="flex gap-2"><button class="btn-teal px-4 py-2 text-sm" data-approve-request="${esc(item.id)}">核可套用</button><button class="rounded-xl bg-rose-50 px-4 py-2 text-sm font-black text-rose-700" data-reject-request="${esc(item.id)}">退回</button></div>` : ""}
            </div>
            ${renderApprovalDetail(item)}
          </div>`;
        }).join("") : `<div class="p-10 text-center text-sm font-bold text-slate-400">目前沒有前台送審項目</div>`}
      </div>
    </div>`;
  const staffPanel = `
    <div class="card p-5">
      <div class="mb-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
        <div><h3 class="font-black">新增按摩師基本人事資料</h3><p class="text-sm font-bold text-slate-500">建立後即可使用編號與 PIN 登入師傅專屬中樞。</p></div>
      </div>
      <form id="therapistForm" class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div><label class="label">編號 (登入帳號)</label><input name="id" class="input" placeholder="例：T004"></div>
        <div><label class="label">密碼 PIN</label><input name="pin" class="input" inputmode="numeric" autocomplete="off" placeholder="可含開頭 0"></div>
        ${therapistProfileFields()}
        <div class="flex items-end xl:col-span-4"><button class="btn-teal w-full sm:w-auto">建立檔案並開通登入</button></div>
      </form>
    </div>
    <div class="card overflow-hidden">
      <div class="border-b bg-slate-50 p-5"><h3 class="font-black">在職人員資料庫</h3></div>
      <div class="table-wrap rounded-none border-0">
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
    <div class="card overflow-hidden">
      <div class="flex flex-col justify-between gap-4 border-b bg-slate-50 p-5 xl:flex-row xl:items-center">
        <div><h3 class="font-black">班表矩陣</h3><p class="mt-1 text-sm font-bold text-slate-500">排班直接掛在人事資料底下，方便從人員管理進入。</p></div>
        <div class="flex flex-col gap-2 sm:flex-row">
          <input id="scheduleStartDate" type="date" class="input py-2" value="${scheduleStart}">
          <input id="scheduleEndDate" type="date" class="input py-2" value="${scheduleEnd}">
          <button id="queryScheduleBtn" class="btn-light">查詢</button>
          <button id="exportScheduleBtn" class="btn-teal">匯出班表</button>
        </div>
      </div>
      <div class="table-wrap rounded-none border-0"><table><thead><tr id="scheduleHeader"></tr></thead><tbody id="scheduleRows"></tbody></table></div>
    </div>`;
  const adminPanel = `
    <div class="card overflow-hidden">
      <div class="border-b bg-slate-50 p-5"><h3 class="font-black">系統管理員</h3><p class="mt-1 text-sm font-bold text-slate-500">新增權限與名單管理整併於同一區塊。</p></div>
      <div class="border-b p-5"><form id="adminForm" class="grid gap-4 md:grid-cols-[1fr_1fr_1fr_1fr_auto] md:items-end"><input name="id" class="input" placeholder="帳號"><input name="name" class="input" placeholder="姓名"><input name="email" class="input" placeholder="Email"><input name="pin" class="input" inputmode="numeric" autocomplete="off" placeholder="密碼 PIN"><button class="btn-primary px-5 py-3">建立</button></form></div>
      <div class="table-wrap rounded-none border-0"><table><thead><tr><th>帳號</th><th>姓名</th><th>密碼</th><th>Email</th><th>操作</th></tr></thead><tbody>${Object.entries(db.admins).map(([id, a]) => `<tr><td class="font-black">${esc(id)}</td><td>${esc(a.name)}</td><td><span class="badge bg-slate-100 text-slate-700">${esc(cleanPin(a.pin))}</span></td><td>${esc(a.email || "無")}</td><td class="space-x-2"><button data-edit-admin="${esc(id)}" class="btn-light px-3 py-1 text-xs">編輯</button>${id === "admin" ? `<span class="text-xs font-bold text-slate-400">預設不可刪</span>` : `<button data-delete-admin="${esc(id)}" class="rounded-lg bg-rose-50 px-3 py-1 text-xs font-black text-rose-700">刪除</button>`}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
  section.innerHTML = `
    <div class="card p-5">
      <div class="flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
        <div><h3 class="text-lg font-black">人事權限</h3><p class="text-sm font-bold text-slate-500">人員資料、班表與登入權限集中管理。</p></div>
        <div class="flex flex-wrap rounded-xl bg-slate-100 p-1">${panelBtn("schedule", "班表矩陣")}${panelBtn("staff", "人事資料")}${panelBtn("approvals", "審核")}${panelBtn("admins", "管理員")}</div>
      </div>
    </div>
    ${activePersonnelPanel === "schedule" ? schedulePanel : activePersonnelPanel === "admins" ? adminPanel : activePersonnelPanel === "approvals" ? approvalPanel : staffPanel}`;
  section.querySelectorAll("[data-personnel-panel]").forEach((btn) => btn.onclick = () => {
    activePersonnelPanel = btn.dataset.personnelPanel;
    renderPersonnel();
  });
  if (activePersonnelPanel === "schedule") {
    $("queryScheduleBtn").onclick = drawScheduleTable;
    $("exportScheduleBtn").onclick = exportScheduleCSV;
    drawScheduleTable();
    return;
  }
  if (activePersonnelPanel === "staff") {
    $("therapistForm").onsubmit = async (e) => {
      e.preventDefault();
      const data = collectTherapistProfile(e.currentTarget);
      if (!data.id || !data.pin) return showSnackbar("編號與密碼 PIN 必填");
      setFormBusy(e.currentTarget, true);
      await saveTherapistProfile(data);
      setFormBusy(e.currentTarget, false);
      renderAll();
    };
    wireTherapistBioGenerator("therapistForm");
    section.querySelectorAll("[data-edit-therapist]").forEach((btn) => btn.onclick = () => openTherapistEditor(btn.dataset.editTherapist));
    section.querySelectorAll("[data-delete-therapist]").forEach((btn) => btn.onclick = () => confirmAction("刪除按摩師", "排班資料會保留於本機資料中，但人員不再顯示。", async () => {
      const id = btn.dataset.deleteTherapist;
      delete db.therapists[id];
      delete db.customers[therapistProfileKey(id)];
      await saveCloudActions([{ action: "deleteCustomer", data: { phone: therapistProfileKey(id) } }], "按摩師資料已刪除");
      renderAll();
      persist();
    }));
    return;
  }
  if (activePersonnelPanel === "approvals") {
    section.querySelectorAll("[data-approve-request]").forEach((btn) => btn.onclick = () => approveRequest(btn.dataset.approveRequest));
    section.querySelectorAll("[data-reject-request]").forEach((btn) => btn.onclick = () => rejectRequest(btn.dataset.rejectRequest));
    return;
  }
  if (activePersonnelPanel === "admins") {
    $("adminForm").onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.currentTarget).entries());
      data.id = String(data.id || "").trim();
      data.name = String(data.name || "").trim();
      data.email = String(data.email || "").trim();
      data.pin = cleanPin(data.pin);
      if (!data.id || !data.name || !data.pin) return showSnackbar("管理員資料必填");
      setFormBusy(e.currentTarget, true);
      db.admins[data.id] = { name: data.name, pin: data.pin, email: data.email };
      await saveCloudActions([{ action: "saveCustomer", data: { phone: `SYS_ADMIN_${data.id}`, name: data.name, notes: sheetText(data.pin), records: [{ email: data.email }] } }], "管理員權限已寫入雲端");
      setFormBusy(e.currentTarget, false);
      renderAll();
    };
    section.querySelectorAll("[data-edit-admin]").forEach((btn) => btn.onclick = () => openAdminEditor(btn.dataset.editAdmin));
    section.querySelectorAll("[data-delete-admin]").forEach((btn) => btn.onclick = () => confirmAction("刪除管理員", "此帳號將無法登入。", async () => {
      const id = btn.dataset.deleteAdmin;
      delete db.admins[id];
      await saveCloudActions([{ action: "deleteCustomer", data: { phone: `SYS_ADMIN_${id}` } }], "管理員權限已刪除");
      renderAll();
    }));
  }
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
    await saveTherapistProfile(data);
    setFormBusy(event.currentTarget, false);
    closeModal();
    renderAll();
  };
  wireTherapistBioGenerator("therapistEditForm");
}

function openAdminEditor(id) {
  const admin = db.admins[id];
  if (!admin) return;
  showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">編輯管理員權限</h3><form id="adminEditForm" class="space-y-4"><div><label class="label">帳號</label><input name="id" class="input bg-slate-100" readonly value="${esc(id)}"></div><div><label class="label">姓名</label><input name="name" class="input" value="${esc(admin.name || "")}"></div><div><label class="label">Email</label><input name="email" class="input" value="${esc(admin.email || "")}"></div><div><label class="label">密碼 PIN</label><input name="pin" class="input" inputmode="numeric" autocomplete="off" value="${esc(cleanPin(admin.pin))}"><p class="mt-2 text-xs font-bold text-slate-500">PIN 會以文字保存，開頭 0 不會被移除。</p></div><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">儲存修改</button></div></form></div>`);
  $("adminEditForm").onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    data.id = String(data.id || "").trim();
    data.name = String(data.name || "").trim();
    data.email = String(data.email || "").trim();
    data.pin = cleanPin(data.pin);
    if (!data.name || !data.pin) return showSnackbar("姓名與密碼必填");
    setFormBusy(event.currentTarget, true);
    db.admins[data.id] = { name: data.name, pin: data.pin, email: data.email };
    if (data.id !== "admin") {
      await saveCloudActions([{ action: "saveCustomer", data: { phone: `SYS_ADMIN_${data.id}`, name: data.name, notes: sheetText(data.pin), records: [{ email: data.email }] } }], "管理員登入資料已寫入雲端");
    } else {
      persist();
      showSnackbar("預設管理員資料已保存在此裝置");
    }
    setFormBusy(event.currentTarget, false);
    closeModal();
    renderAll();
  };
}

function renderReport() {
  const start = $("reportStartDate")?.value || todayKey();
  const end = $("reportEndDate")?.value || todayKey();
  const rows = Object.values(db.appointments).filter((a) => a.date >= start && a.date <= end).sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date));
  const total = rows.reduce((s, a) => s + Number(a.price || 0), 0);
  const therapistCut = rows.reduce((s, a) => s + Number(COURSE_CATALOG[a.service]?.therapistCut || 0), 0);
  const collected = rows.reduce((s, a) => s + Number(a.collectedPrice || 0), 0);
  const reportTab = (panel, label) => `<button class="rounded-lg px-4 py-2 text-sm font-black ${activeReportPanel === panel ? "bg-white text-amber-700 shadow" : "text-slate-500"}" data-report-panel="${panel}">${label}</button>`;
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
  $("view-report").innerHTML = `
    <div class="card p-5">
      <div class="mb-5 flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
        <div><h3 class="text-lg font-black">財務報表</h3><p class="text-sm font-bold text-slate-500">同一區間內切換營收、來客、回客與回帳分析。</p></div>
        <div class="flex flex-col gap-2 sm:flex-row"><input id="reportStartDate" type="date" class="input py-2" value="${start}"><input id="reportEndDate" type="date" class="input py-2" value="${end}"><button id="queryReportBtn" class="btn-primary px-5 py-3">查詢</button><button id="exportReportBtn" class="btn-teal">輸出報表</button></div>
      </div>
      <div class="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">${metric("來客數", rows.length)}${metric("總營業額", money(total))}${metric("已回帳", money(collected), "text-emerald-700")}${metric("師傅抽成", money(therapistCut), "text-indigo-700")}</div>
      <div class="mb-5 flex flex-wrap rounded-xl bg-slate-100 p-1">${reportTab("revenue", "營收明細")}${reportTab("guests", "來客數")}${reportTab("retention", "師傅回客率")}${reportTab("commission", "抽成回帳")}</div>
      ${panelContent}
    </div>`;
  $("queryReportBtn").onclick = renderReport;
  $("exportReportBtn").onclick = exportReportCSV;
  $("view-report").querySelectorAll("[data-report-panel]").forEach((btn) => btn.onclick = () => {
    activeReportPanel = btn.dataset.reportPanel;
    renderReport();
  });
  $("view-report").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
}

function exportReportCSV() {
  const start = $("reportStartDate").value;
  const end = $("reportEndDate").value;
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

function renderPortal() {
  const section = $("view-portal");
  if (!currentUser) {
    section.innerHTML = `<div class="card p-8 text-center font-bold text-slate-500">請以按摩師帳號登入。</div>`;
    return;
  }
  const monthKeys = new Set(monthDates.map((d) => d.key));
  const appts = Object.values(db.appointments).filter((a) => a.therapistId === currentUser.id && monthKeys.has(a.date)).sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date));
  section.innerHTML = `
    <div class="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div class="card overflow-hidden">
        <div class="flex flex-col justify-between gap-4 border-b bg-white px-5 py-4 sm:flex-row sm:items-center">
          <div><p class="text-xs font-black uppercase tracking-widest text-slate-500">個人中樞</p><h3 class="text-2xl font-black">${esc(currentUser.nickname || currentUser.name)}</h3></div>
          <span class="badge bg-teal-50 text-teal-700">${appts.length} 筆本月派單</span>
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
        <div id="portalScheduleInputs" class="space-y-3">${(monthWeeks[0] || []).map((d) => `<label class="block rounded-xl border bg-slate-50 p-3"><span class="label">${esc(d.displayFull)}</span><input class="input py-2" data-portal-shift="${d.key}" value="${esc((db.schedules[currentUser.id] || {})[d.key] || "")}"></label>`).join("")}</div>
      </div>
    </div>`;
  $("savePortalScheduleBtn").onclick = async () => {
    db.schedules[currentUser.id] ||= {};
    document.querySelectorAll("[data-portal-shift]").forEach((input) => db.schedules[currentUser.id][input.dataset.portalShift] = normalizeShift(input.value));
    await saveCloudActions([{ action: "saveSchedule", data: { id: currentUser.id, schedule: db.schedules[currentUser.id] } }], "班表已寫入雲端");
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
    setFormBusy(event.currentTarget, true);
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    a.collectedPrice = data.collectedPrice || "";
    a.isCompleted = data.isCompleted === "on";
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
    await saveCloudActions([
      { action: "addAppointment", data: a },
      { action: "saveCustomer", data: { phone: a.phone, ...customer } }
    ], "服務紀錄已寫入雲端");
    setFormBusy(event.currentTarget, false);
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
}

function closeModal() {
  $("modalRoot").innerHTML = "";
}

function confirmAction(title, description, onConfirm, confirmText = "確認執行") {
  showModal(`<div class="modal max-w-sm text-center"><div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-2xl text-rose-600">!</div><h3 class="mb-2 text-xl font-black">${esc(title)}</h3><p class="mb-6 whitespace-pre-wrap text-sm font-bold leading-relaxed text-slate-600">${esc(description)}</p><div class="flex gap-3"><button class="btn-light w-full" data-close-modal>取消</button><button id="confirmActionBtn" class="w-full rounded-xl bg-rose-600 px-5 py-3 font-black text-white">${esc(confirmText)}</button></div></div>`);
  $("confirmActionBtn").onclick = () => {
    closeModal();
    onConfirm();
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
  err.classList.add("hidden");
  if (!id || !pin) {
    err.textContent = "請輸入完整帳號密碼。";
    err.classList.remove("hidden");
    return;
  }
  $("loginBtn").disabled = true;
  $("loginBtnText").textContent = "連線中...";
  $("loginLoader").classList.remove("hidden");
  await tryCloudSync();
  if (pinMatches(db.admins[id]?.pin, pin)) {
    currentUser = { id, name: db.admins[id].name, role: "admin" };
    $("adminNav").classList.remove("hidden");
    $("therapistNav").classList.add("hidden");
    $("roleLabel").textContent = "管理員";
    enterDashboard("overview");
    if (cleanPin(db.admins[id]?.pin) !== cleanPin(pin)) showSnackbar("已用舊格式密碼登入，請至人事頁編輯後重新儲存 PIN");
  } else if (pinMatches(db.therapists[id]?.pin, pin)) {
    currentUser = { id, name: therapistName(id), role: "therapist" };
    $("adminNav").classList.add("hidden");
    $("therapistNav").classList.remove("hidden");
    $("roleLabel").textContent = "按摩師";
    enterDashboard("portal");
    if (cleanPin(db.therapists[id]?.pin) !== cleanPin(pin)) showSnackbar("已用舊格式密碼登入，請管理員重新儲存您的 PIN");
  } else {
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
  $("loginBtn").addEventListener("click", handleLogin);
  $("adminPin").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });
  $("logoutBtn").addEventListener("click", logout);
  $("prevMonthBtn").addEventListener("click", () => changeMonth(-1));
  $("nextMonthBtn").addEventListener("click", () => changeMonth(1));
  $("openSidebarBtn").addEventListener("click", showSidebar);
  $("closeSidebarBtn").addEventListener("click", hideSidebar);
  $("sidebarOverlay").addEventListener("click", hideSidebar);
  document.querySelectorAll("[data-tab]").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
}

window.handleLogin = handleLogin;
window.handleAdminLogin = handleLogin;
window.logout = logout;

bindEvents();
renderAll();
