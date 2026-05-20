"use strict";

const API_URL = "https://script.google.com/macros/s/AKfycbxC4Pk1v6rkdmd96cR_2r_xPhbcNjrQ0bNdikGKyqbR9OMMeCwN9L5t9mE1j-AoS-ie/exec";
const STORAGE_KEY = "morgan-ops-hub-v2";

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
  Object.values(data.appointments).forEach((appt) => {
    if (!appt.phone || isSystemCustomerKey(appt.phone)) return;
    data.customers[appt.phone] ||= { name: appt.customerName || "", notes: "", records: [] };
    if (!data.customers[appt.phone].name && appt.customerName) data.customers[appt.phone].name = appt.customerName;
  });
  Object.keys(data.customers).forEach((key) => {
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
  Object.keys(data.therapists).forEach((id) => {
    data.therapists[id] = normalizeTherapistProfile(data.therapists[id]);
  });
  Object.keys(data.admins).forEach((id) => {
    data.admins[id].pin = cleanPin(data.admins[id].pin);
  });
  Object.entries(data.appointments).forEach(([id, appt]) => {
    appt.id = appt.id || id;
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

function mergeCloudWithLocal(cloudData, localData) {
  const cloud = normalizeDb(cloudData || {});
  const local = normalizeDb(localData || {});
  return normalizeDb({
    ...cloud,
    therapists: { ...cloud.therapists, ...local.therapists },
    schedules: { ...cloud.schedules, ...local.schedules },
    admins: { ...cloud.admins, ...local.admins },
    appointments: { ...cloud.appointments, ...local.appointments },
    customers: { ...cloud.customers, ...local.customers }
  });
}

async function tryCloudSync() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5500);
  try {
    const res = await fetch(`${API_URL}?t=${Date.now()}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    db = mergeCloudWithLocal(await res.json(), db);
    persist();
    $("sysStatus").textContent = "已連線雲端資料，本機異動已保留";
  } catch {
    $("sysStatus").textContent = "雲端未連線，使用本機測試資料";
  } finally {
    clearTimeout(timeout);
  }
}

async function postCloud(action, data) {
  persist();
  try {
    const res = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action, data }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch {
    showSnackbar("已先存於此瀏覽器；雲端寫入失敗，請檢查 Apps Script 權限");
    return false;
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
  renderAppointmentDetail();
  renderCustomers();
  renderSchedule();
  renderFilter();
  renderPersonnel();
  renderReport();
  renderPortal();
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
  $(`view-${tab}`)?.classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
  const titles = { overview: "總覽", appointment: "預約派班", appointmentDetail: "預約資料", customer: "顧客 CRM", schedule: "班表矩陣", filter: "可用人力", personnel: "人事權限", report: "財務報表", portal: "個人中樞" };
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
            <div class="flex flex-wrap gap-2"><button class="btn-teal" data-jump-tab="appointment">派班看板</button><button class="rounded-xl bg-white/10 px-4 py-2 font-black text-white" data-jump-tab="appointmentDetail">預約資料</button></div>
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
            <button class="btn-light px-3 py-2 text-xs" data-jump-tab="schedule">班表</button>
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
        <div class="flex items-center justify-between border-b bg-white px-5 py-4"><div><h3 class="font-black">今日流程</h3><p class="text-xs font-bold text-slate-500">點任一筆可開啟預約資料頁</p></div><span class="badge bg-teal-50 text-teal-700">${todayAppts.length} 筆</span></div>
        <div>${todayTimeline}</div>
      </div>
      <div class="space-y-5">${taskCards}</div>
    </div>
    `;
  $("saveDoorBtn").onclick = () => {
    const previous = db.customers.SYS_DOOR_PWD || { name: "設定", notes: "", records: [] };
    const nextValue = $("doorPassword").value.trim();
    const records = previous.records || [];
    if (nextValue && nextValue !== previous.notes) {
      records.push({ at: new Date().toLocaleString("zh-TW", { hour12: false }), value: nextValue, reason: "手動更新" });
    }
    db.customers.SYS_DOOR_PWD = { name: "設定", notes: nextValue, records };
    postCloud("saveCustomer", { phone: "SYS_DOOR_PWD", ...db.customers.SYS_DOOR_PWD });
    showSnackbar("大門密碼已更新");
  };
  $("randomDoorBtn").onclick = () => {
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    $("doorPassword").value = code;
    const previous = db.customers.SYS_DOOR_PWD || { name: "設定", notes: "", records: [] };
    const records = previous.records || [];
    records.push({ at: new Date().toLocaleString("zh-TW", { hour12: false }), value: code, reason: "隨機四碼" });
    db.customers.SYS_DOOR_PWD = { name: "設定", notes: code, records };
    postCloud("saveCustomer", { phone: "SYS_DOOR_PWD", ...db.customers.SYS_DOOR_PWD });
    showSnackbar("已產生並儲存隨機大門密碼");
  };
  $("doorHistoryBtn").onclick = () => {
    showModal(`<div class="modal max-w-2xl"><h3 class="mb-5 border-b pb-4 text-xl font-black">大門密碼修改紀錄</h3><div class="table-wrap"><table><thead><tr><th>時間</th><th>密碼</th><th>來源</th></tr></thead><tbody>${doorPasswordRecordHtml()}</tbody></table></div><div class="mt-5 flex justify-end border-t pt-4"><button class="btn-light" data-close-modal>關閉</button></div></div>`);
  };
  $("view-overview").querySelectorAll("[data-jump-tab]").forEach((btn) => btn.onclick = () => switchTab(btn.dataset.jumpTab));
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
        <div><h3 class="text-lg font-black">預約派班</h3><p class="text-sm font-bold text-slate-500">以師傅或房型時程檢視當日預約。</p></div>
        <div class="flex flex-col gap-3 sm:flex-row">
          <div class="flex rounded-xl bg-slate-100 p-1">
            <button id="apptCardBtn" class="rounded-lg px-4 py-2 text-sm font-black">師傅視角</button>
            <button id="apptTimelineBtn" class="rounded-lg px-4 py-2 text-sm font-black">房型時程</button>
          </div>
          <input id="appointmentDate" type="date" class="input py-2" value="${selectedDate}">
        </div>
      </div>
    </div>
    <div id="appointmentBoard" class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3"></div>
    <div id="appointmentTimeline" class="hidden overflow-x-auto"></div>`;
  $("appointmentDate").onchange = renderAppointment;
  $("apptCardBtn").onclick = () => { activeAppointmentView = "card"; renderAppointmentBoard(selectedDate); };
  $("apptTimelineBtn").onclick = () => { activeAppointmentView = "timeline"; renderAppointmentBoard(selectedDate); };
  renderAppointmentBoard(selectedDate);
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

function openAppointmentModal({ therapistId, date, appointmentId }) {
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
          <div><label class="label">預約時間</label><input name="time" type="time" class="input" value="${esc(existing?.time || "")}"></div>
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

function saveAppointmentFromForm(form, date) {
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
  const commit = () => {
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
    postCloud("addAppointment", data);
    closeModal();
    renderAll();
    showSnackbar("預約已儲存");
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

function deleteAppointment(id) {
  const appt = db.appointments[id];
  delete db.appointments[id];
  if (appt && db.customers[appt.phone]?.records) db.customers[appt.phone].records = db.customers[appt.phone].records.filter((r) => r.id !== id);
  if (activeAppointmentId === id) activeAppointmentId = null;
  postCloud("deleteAppointment", { appId: id });
  renderAll();
  showSnackbar("預約已刪除");
}

function openAppointmentDetailPage(id) {
  activeAppointmentId = id || null;
  switchTab("appointmentDetail");
}

function appointmentRecord(appt) {
  return db.customers[appt.phone]?.records?.find((r) => r.id === appt.id);
}

function renderAppointmentDetail() {
  const section = $("view-appointmentDetail");
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
  section.querySelectorAll("[data-tab-jump-appointment]").forEach((btn) => btn.onclick = () => switchTab("appointment"));
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
  }).join("") : `<tr><td colspan="9" class="py-10 text-center font-bold text-slate-400">本月無預約資料</td></tr>`;
  return `<div class="card p-5">
    <div class="mb-5 flex flex-col justify-between gap-4 border-b pb-5 sm:flex-row sm:items-center">
      <div><h3 class="text-lg font-black">預約資料管理</h3><p class="text-sm font-bold text-slate-500">每筆預約都有獨立資訊頁，可由各頁面連結進入編輯。</p></div>
      <button class="btn-teal" data-tab-jump-appointment>回到派班看板</button>
    </div>
    <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
      ${metric("本月預約筆數", monthAppts.length)}
      ${metric("本月預估營業額", money(monthAppts.reduce((sum, a) => sum + Number(a.price || 0), 0)), "text-rose-700")}
      ${metric("已完成", monthAppts.filter((a) => String(a.isCompleted) === "true").length, "text-teal-700")}
      ${metric("待回報", monthAppts.filter((a) => String(a.isCompleted) !== "true").length, "text-indigo-700")}
    </div>
    <div class="table-wrap mt-5"><table><thead><tr><th>預約時間</th><th>顧客</th><th>師傅</th><th>空間</th><th>服務</th><th>備註</th><th class="text-right">金額</th><th class="text-right">店收</th><th class="text-right">操作</th></tr></thead><tbody>${rows}</tbody></table></div>
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
        <div><p class="text-xs font-black uppercase tracking-widest text-slate-500">預約資訊</p><h3 class="text-xl font-black">${esc(customerDisplay(appt.phone, appt.customerName))}</h3><p class="text-xs font-bold text-slate-500">ID：${esc(appt.id)}</p></div>
        <div class="flex gap-2"><button id="backToAppointmentListBtn" type="button" class="btn-light">返回列表</button><button data-delete-appt="${esc(appt.id)}" type="button" class="rounded-xl bg-rose-50 px-4 py-2 font-black text-rose-700">刪除</button></div>
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
      <div class="mt-5 flex justify-end gap-3 border-t pt-4"><button id="cancelAppointmentDetailBtn" type="button" class="btn-light">取消</button><button class="btn-teal">儲存預約資訊</button></div>
    </form>
    <aside class="space-y-4">
      <div class="card p-5"><h4 class="mb-4 font-black">帳務摘要</h4><div class="space-y-3">${metric("應收金額", money(appt.price), "text-rose-700")}${metric("店家應收", money(Number(appt.price || 0) - cut), "text-teal-700")}${metric("師傅抽成", money(cut), "text-indigo-700")}</div></div>
      <div class="card p-5"><h4 class="mb-3 font-black">顧客摘要</h4><p class="font-black">${esc(customerDisplay(appt.phone, appt.customerName))}</p><p class="text-sm font-bold text-slate-500">${esc(appt.phone || "無聯絡方式")}</p><p class="mt-3 text-sm text-slate-600">累積預約：<b>${sameCustomer}</b> 筆</p><p class="mt-3 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm text-slate-600">${esc(db.customers[appt.phone]?.notes || "尚無顧客備註")}</p></div>
    </aside>
  </div>`;
}

function saveAppointmentDetailForm(form) {
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
  const commit = () => {
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
    postCloud("addAppointment", next);
    postCloud("saveCustomer", { phone: next.phone, ...customer });
    renderAll();
    activeAppointmentId = next.id;
    switchTab("appointmentDetail");
    showSnackbar("預約資訊已更新");
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
  rows.querySelectorAll("[data-delete-customer]").forEach((btn) => btn.onclick = () => confirmAction("刪除 CRM 檔案", "顧客基本資料與服務紀錄將移除。", () => {
    delete db.customers[btn.dataset.deleteCustomer];
    postCloud("deleteCustomer", { phone: btn.dataset.deleteCustomer });
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
  $("customerForm").onsubmit = (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!data.phone.trim()) {
      $("customerError").textContent = "聯絡方式必填；顧客姓名可留空。";
      $("customerError").classList.remove("hidden");
      return;
    }
    db.customers[data.phone] = { code: db.customers[data.phone]?.code, name: data.name.trim(), notes: data.notes.trim(), records: db.customers[data.phone]?.records || [] };
    assignCustomerCodes(db);
    postCloud("saveCustomer", { phone: data.phone, ...db.customers[data.phone] });
    closeModal();
    renderAll();
    showSnackbar("顧客資料已更新");
  };
  if ($("addRecordBtn")) $("addRecordBtn").onclick = () => addCustomerRecord(phone);
  $("modalRoot").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => {
    closeModal();
    openAppointmentDetailPage(btn.dataset.openAppt);
  });
}

function renderRecordList(phone) {
  const records = [...(db.customers[phone]?.records || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return records.length ? records.map((r) => `<div class="rounded-xl border bg-white p-3"><div class="mb-1 flex justify-between gap-2"><b>${esc(r.date)}</b><span class="badge bg-slate-100 text-slate-600">${esc(courseName(r.service))}</span></div><p class="text-xs font-black text-teal-700">${esc(r.therapistName || therapistName(r.therapistId))}</p><p class="mt-1 whitespace-pre-wrap text-sm text-slate-600">${esc(r.notes || "尚未填寫細節")}</p>${db.appointments[r.id] ? `<button type="button" class="btn-light mt-3 px-3 py-1 text-xs" data-open-appt="${esc(r.id)}">開啟預約資訊</button>` : ""}</div>`).join("") : `<div class="rounded-xl border border-dashed py-6 text-center text-sm font-bold text-slate-400">無紀錄</div>`;
}

function addCustomerRecord(phone) {
  const therapistId = $("recordTherapist").value;
  const service = $("recordService").value.trim();
  const record = { id: `REC-${Date.now().toString(36)}`, date: $("recordDate").value, therapistId, therapistName: therapistName(therapistId), service, collectedPrice: $("recordCollectedPrice").value.trim(), notes: $("recordNotes").value.trim() };
  db.customers[phone].records ||= [];
  db.customers[phone].records.push(record);
  postCloud("saveCustomer", { phone, ...db.customers[phone] });
  $("recordList").innerHTML = renderRecordList(phone);
  showSnackbar("服務紀錄已新增");
}

function renderSchedule() {
  const start = $("scheduleStartDate")?.value || monthDates[0]?.key || todayKey();
  const end = $("scheduleEndDate")?.value || monthDates.at(-1)?.key || todayKey();
  $("view-schedule").innerHTML = `
    <div class="card overflow-hidden">
      <div class="flex flex-col justify-between gap-4 border-b bg-slate-50 p-5 xl:flex-row xl:items-center">
        <h3 class="font-black">全體人員排班矩陣</h3>
        <div class="flex flex-col gap-2 sm:flex-row">
          <input id="scheduleStartDate" type="date" class="input py-2" value="${start}">
          <input id="scheduleEndDate" type="date" class="input py-2" value="${end}">
          <button id="queryScheduleBtn" class="btn-light">查詢</button>
          <button id="exportScheduleBtn" class="btn-teal">匯出班表</button>
        </div>
      </div>
      <div class="table-wrap rounded-none border-0"><table><thead><tr id="scheduleHeader"></tr></thead><tbody id="scheduleRows"></tbody></table></div>
    </div>`;
  $("queryScheduleBtn").onclick = drawScheduleTable;
  $("exportScheduleBtn").onclick = exportScheduleCSV;
  drawScheduleTable();
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
  $("scheduleForm").onsubmit = (event) => {
    event.preventDefault();
    db.schedules[id] ||= {};
    Object.entries(Object.fromEntries(new FormData(event.currentTarget).entries())).forEach(([date, value]) => db.schedules[id][date] = normalizeShift(value));
    postCloud("saveSchedule", { id, schedule: db.schedules[id] });
    closeModal();
    renderAll();
    showSnackbar("班表已更新");
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

function renderFilter() {
  $("view-filter").innerHTML = `
    <div class="card p-5">
      <div class="mb-5 flex flex-col justify-between gap-4 border-b pb-5 xl:flex-row xl:items-end">
        <div><h3 class="text-lg font-black">可用人力</h3><p class="text-sm font-bold text-slate-500">依日期與時段快速查詢可排師傅。</p></div>
        <div class="grid gap-3 md:grid-cols-[220px_220px_auto] md:items-end">
          <div><label class="label">日期</label><select id="searchDateSelect" class="input py-2">${monthDates.map((d) => `<option value="${d.key}">${esc(d.displayFull)}</option>`).join("")}</select></div>
          <div><label class="label">時段</label><input id="searchTimeKeyword" class="input py-2" placeholder="例：14:00"></div>
          <button id="executeFilterBtn" class="btn-primary px-6 py-3">查詢</button>
        </div>
      </div>
      <div id="filterResultContainer" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"></div>
    </div>`;
  $("executeFilterBtn").onclick = executeFilter;
  executeFilter();
}

function executeFilter() {
  const date = $("searchDateSelect").value;
  const kw = normalizeShift($("searchTimeKeyword").value).replace("休假", "");
  const target = kw ? timeToMinutes(kw) : null;
  const cards = Object.entries(db.therapists).filter(([id]) => {
    const shift = (db.schedules[id] || {})[date] || "休假";
    if (!isWorking(shift)) return false;
    if (!kw) return true;
    return shift.split(/[,\s]+/).some((part) => {
      const [s, e] = part.split("-");
      return s && e && target >= timeToMinutes(s) && target <= timeToMinutes(e);
    });
  }).map(([id, t]) => {
    const shift = (db.schedules[id] || {})[date];
    const busy = target == null ? null : Object.values(db.appointments).find((a) => a.therapistId === id && a.date === date && target >= timeToMinutes(a.time) && target < timeToMinutes(a.time) + Number(a.duration || 60));
    return `<div class="rounded-xl border bg-white p-4"><div class="flex items-start justify-between gap-3"><div><h4 class="font-black">${esc(therapistName(id))}</h4><p class="mt-1 text-xs font-black text-teal-700">${esc(shift)}</p></div><span class="badge bg-teal-50 text-teal-700">可用</span></div>${busy ? `<button class="mt-3 rounded-lg bg-rose-50 px-2 py-1 text-left text-xs font-black text-rose-700 hover:bg-rose-100" data-open-appt="${esc(busy.id)}">預約：${esc(busy.time)} ${esc(courseName(busy.service))}</button>` : ""}</div>`;
  });
  $("filterResultContainer").innerHTML = cards.join("") || `<p class="font-bold text-slate-400">查無可用人員。</p>`;
  $("filterResultContainer").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
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

function saveTherapistProfile(data) {
  const existing = db.therapists[data.id] || {};
  db.therapists[data.id] = normalizeTherapistProfile({ ...existing, ...data });
  db.schedules[data.id] ||= {};
  postCloud("addTherapist", { ...db.therapists[data.id], id: data.id, pin: sheetText(data.pin) });
  const { pin, ...profile } = db.therapists[data.id];
  db.customers[therapistProfileKey(data.id)] = { name: profile.nickname || profile.name || data.id, notes: JSON.stringify(profile), records: [] };
  postCloud("saveCustomer", { phone: therapistProfileKey(data.id), ...db.customers[therapistProfileKey(data.id)] });
}

function renderPersonnel() {
  $("view-personnel").innerHTML = `
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
          <thead><tr><th>編號</th><th>暱稱 / 姓名</th><th>聯絡與體態</th><th>專長</th><th>密碼</th><th>操作</th></tr></thead>
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
    </div>
    <div class="card overflow-hidden">
      <div class="border-b bg-slate-50 p-5"><h3 class="font-black">系統管理員</h3><p class="mt-1 text-sm font-bold text-slate-500">新增權限與名單管理整併於同一區塊。</p></div>
      <div class="border-b p-5"><form id="adminForm" class="grid gap-4 md:grid-cols-[1fr_1fr_1fr_1fr_auto] md:items-end"><input name="id" class="input" placeholder="帳號"><input name="name" class="input" placeholder="姓名"><input name="email" class="input" placeholder="Email"><input name="pin" class="input" inputmode="numeric" autocomplete="off" placeholder="密碼 PIN"><button class="btn-primary px-5 py-3">建立</button></form></div>
      <div class="table-wrap rounded-none border-0"><table><thead><tr><th>帳號</th><th>姓名</th><th>密碼</th><th>Email</th><th>操作</th></tr></thead><tbody>${Object.entries(db.admins).map(([id, a]) => `<tr><td class="font-black">${esc(id)}</td><td>${esc(a.name)}</td><td><span class="badge bg-slate-100 text-slate-700">${esc(cleanPin(a.pin))}</span></td><td>${esc(a.email || "無")}</td><td class="space-x-2"><button data-edit-admin="${esc(id)}" class="btn-light px-3 py-1 text-xs">編輯</button>${id === "admin" ? `<span class="text-xs font-bold text-slate-400">預設不可刪</span>` : `<button data-delete-admin="${esc(id)}" class="rounded-lg bg-rose-50 px-3 py-1 text-xs font-black text-rose-700">刪除</button>`}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
  $("therapistForm").onsubmit = (e) => {
    e.preventDefault();
    const data = collectTherapistProfile(e.currentTarget);
    if (!data.id || !data.pin) return showSnackbar("編號與密碼 PIN 必填");
    saveTherapistProfile(data);
    renderAll();
    showSnackbar("按摩師已建立，可用新帳密登入");
  };
  wireTherapistBioGenerator("therapistForm");
  $("adminForm").onsubmit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    data.id = String(data.id || "").trim();
    data.name = String(data.name || "").trim();
    data.email = String(data.email || "").trim();
    data.pin = cleanPin(data.pin);
    if (!data.id || !data.name || !data.pin) return showSnackbar("管理員資料必填");
    db.admins[data.id] = { name: data.name, pin: data.pin, email: data.email };
    postCloud("saveCustomer", { phone: `SYS_ADMIN_${data.id}`, name: data.name, notes: sheetText(data.pin), records: [{ email: data.email }] });
    renderAll();
    showSnackbar("管理員權限已建立");
  };
  document.querySelectorAll("[data-edit-therapist]").forEach((btn) => btn.onclick = () => openTherapistEditor(btn.dataset.editTherapist));
  document.querySelectorAll("[data-edit-admin]").forEach((btn) => btn.onclick = () => openAdminEditor(btn.dataset.editAdmin));
  document.querySelectorAll("[data-delete-therapist]").forEach((btn) => btn.onclick = () => confirmAction("刪除按摩師", "排班資料會保留於本機資料中，但人員不再顯示。", () => {
    const id = btn.dataset.deleteTherapist;
    delete db.therapists[id];
    delete db.customers[therapistProfileKey(id)];
    postCloud("deleteCustomer", { phone: therapistProfileKey(id) });
    renderAll();
    persist();
  }));
  document.querySelectorAll("[data-delete-admin]").forEach((btn) => btn.onclick = () => confirmAction("刪除管理員", "此帳號將無法登入。", () => { delete db.admins[btn.dataset.deleteAdmin]; renderAll(); persist(); }));
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
  $("therapistEditForm").onsubmit = (event) => {
    event.preventDefault();
    const data = collectTherapistProfile(event.currentTarget);
    if (!data.pin) return showSnackbar("密碼 PIN 必填");
    saveTherapistProfile(data);
    closeModal();
    renderAll();
    showSnackbar("按摩師人事資料已更新");
  };
  wireTherapistBioGenerator("therapistEditForm");
}

function openAdminEditor(id) {
  const admin = db.admins[id];
  if (!admin) return;
  showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">編輯管理員權限</h3><form id="adminEditForm" class="space-y-4"><div><label class="label">帳號</label><input name="id" class="input bg-slate-100" readonly value="${esc(id)}"></div><div><label class="label">姓名</label><input name="name" class="input" value="${esc(admin.name || "")}"></div><div><label class="label">Email</label><input name="email" class="input" value="${esc(admin.email || "")}"></div><div><label class="label">密碼 PIN</label><input name="pin" class="input" inputmode="numeric" autocomplete="off" value="${esc(cleanPin(admin.pin))}"><p class="mt-2 text-xs font-bold text-slate-500">PIN 會以文字保存，開頭 0 不會被移除。</p></div><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">儲存修改</button></div></form></div>`);
  $("adminEditForm").onsubmit = (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    data.id = String(data.id || "").trim();
    data.name = String(data.name || "").trim();
    data.email = String(data.email || "").trim();
    data.pin = cleanPin(data.pin);
    if (!data.name || !data.pin) return showSnackbar("姓名與密碼必填");
    db.admins[data.id] = { name: data.name, pin: data.pin, email: data.email };
    if (data.id !== "admin") {
      postCloud("saveCustomer", { phone: `SYS_ADMIN_${data.id}`, name: data.name, notes: sheetText(data.pin), records: [{ email: data.email }] });
    } else {
      persist();
    }
    closeModal();
    renderAll();
    showSnackbar("管理員登入資料已更新");
  };
}

function renderReport() {
  const start = $("reportStartDate")?.value || todayKey();
  const end = $("reportEndDate")?.value || todayKey();
  const rows = Object.values(db.appointments).filter((a) => a.date >= start && a.date <= end).sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date));
  const total = rows.reduce((s, a) => s + Number(a.price || 0), 0);
  const therapistCut = rows.reduce((s, a) => s + Number(COURSE_CATALOG[a.service]?.therapistCut || 0), 0);
  $("view-report").innerHTML = `
    <div class="card p-5">
      <div class="mb-5 flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
        <div><h3 class="text-lg font-black">營運財務與業績報表</h3><p class="text-sm font-bold text-slate-500">檢視營業額、店家應收與師傅抽成</p></div>
        <div class="flex flex-col gap-2 sm:flex-row"><input id="reportStartDate" type="date" class="input py-2" value="${start}"><input id="reportEndDate" type="date" class="input py-2" value="${end}"><button id="queryReportBtn" class="btn-primary px-5 py-3">查詢</button><button id="exportReportBtn" class="btn-teal">輸出報表</button></div>
      </div>
      <div class="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">${metric("來客數", rows.length)}${metric("總營業額", money(total))}${metric("店家應收", money(total - therapistCut), "text-teal-700")}${metric("師傅抽成", money(therapistCut), "text-indigo-700")}</div>
      <div class="table-wrap"><table><thead><tr><th>預約日期時間</th><th>顧客</th><th>師傅</th><th>服務</th><th class="text-right">總金額</th><th class="text-right">店家應收</th><th class="text-right">師傅抽成</th></tr></thead><tbody>${rows.length ? rows.map((a) => {
        const tc = COURSE_CATALOG[a.service]?.therapistCut || 0;
        return `<tr><td><button data-open-appt="${esc(a.id)}" class="font-mono font-black text-teal-700 hover:text-teal-900">${esc(a.date)} ${esc(a.time)}</button></td><td><button data-open-appt="${esc(a.id)}" class="font-black hover:text-teal-700">${esc(customerDisplay(a.phone, a.customerName))}</button></td><td>${esc(therapistName(a.therapistId))}</td><td>${esc(courseName(a.service))}</td><td class="text-right font-black text-rose-600">${money(a.price)}</td><td class="text-right font-black text-teal-700">${money(Number(a.price || 0) - tc)}</td><td class="text-right font-black text-indigo-700">${money(tc)}</td></tr>`;
      }).join("") : `<tr><td colspan="7" class="py-10 text-center font-bold text-slate-400">該區間無預約</td></tr>`}</tbody></table></div>
    </div>`;
  $("queryReportBtn").onclick = renderReport;
  $("exportReportBtn").onclick = exportReportCSV;
  $("view-report").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
}

function exportReportCSV() {
  const start = $("reportStartDate").value;
  const end = $("reportEndDate").value;
  const rows = Object.values(db.appointments).filter((a) => a.date >= start && a.date <= end).sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date));
  let csv = "\uFEFF日期,時間,顧客編碼,顧客姓名,聯絡方式,負責師傅,服務項目,總金額,店家應收,師傅抽成\n";
  rows.forEach((a) => {
    const tc = COURSE_CATALOG[a.service]?.therapistCut || 0;
    csv += `${a.date},${a.time},"${customerCode(a.phone)}","${a.customerName || db.customers[a.phone]?.name || ""}","${a.phone}","${therapistName(a.therapistId)}","${courseName(a.service)}",${a.price},${Number(a.price || 0) - tc},${tc}\n`;
  });
  downloadCSV(csv, `報表_${start}_至_${end}.csv`);
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
  $("savePortalScheduleBtn").onclick = () => {
    db.schedules[currentUser.id] ||= {};
    document.querySelectorAll("[data-portal-shift]").forEach((input) => db.schedules[currentUser.id][input.dataset.portalShift] = normalizeShift(input.value));
    postCloud("saveSchedule", { id: currentUser.id, schedule: db.schedules[currentUser.id] });
    renderAll();
    showSnackbar("班表已儲存");
  };
  section.querySelectorAll("[data-complete]").forEach((btn) => btn.onclick = () => openTherapistReport(btn.dataset.complete));
  section.querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
}

function openTherapistReport(id) {
  const a = db.appointments[id];
  showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">填寫服務紀錄與回款</h3><form id="therapistReportForm" class="space-y-4"><div class="rounded-xl border bg-slate-50 p-4"><b>${esc(customerDisplay(a.phone, a.customerName))}</b><p class="text-sm font-bold text-teal-700">${esc(a.date)} / ${esc(a.time)} - ${esc(courseName(a.service))}</p></div><input name="collectedPrice" class="input" type="number" placeholder="實際回款金額" value="${esc(a.collectedPrice || "")}"><textarea name="notes" class="input min-h-28" placeholder="服務細節與顧客反饋">${esc(findRecord(a)?.notes || "")}</textarea><label class="flex items-center gap-3 rounded-xl border p-3 font-black"><input name="isCompleted" type="checkbox" ${String(a.isCompleted) === "true" ? "checked" : ""}> 標記為已完成</label><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">儲存入檔</button></div></form></div>`);
  $("therapistReportForm").onsubmit = (event) => {
    event.preventDefault();
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
    postCloud("addAppointment", a);
    closeModal();
    renderAll();
    showSnackbar("服務紀錄已同步");
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
