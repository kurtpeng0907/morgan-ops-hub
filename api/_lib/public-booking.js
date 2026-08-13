"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLIENT_SELECTION_PREFIX = "SYS_CLIENT_SELECTION_";
const OPERATIONS_CONFIG_KEY = "SYS_OPERATIONS_CONFIG";
const DEFAULT_COURSES = {
  A60: { name: "A課程 60分", duration: 60, price: 1800 }, C120: { name: "C課程 120分", duration: 120, price: 2800 },
  C90: { name: "C課程 90分", duration: 90, price: 2500 }, D120: { name: "D課程 120分", duration: 120, price: 2400 },
  D90: { name: "D課程 90分", duration: 90, price: 2100 }, OUT_DAY: { name: "外出 (22:00前)", duration: 120, price: 3200 }, OUT_NIGHT: { name: "外出 (22:00後)", duration: 120, price: 3500 }
};
const DEFAULT_ROOMS = { R: { name: "Royal (R房)", enabled: true }, T: { name: "Tiffany (T房)", enabled: true }, OUT: { name: "外出", enabled: true, external: true } };
const minutes = (time = "") => { const [h, m] = String(time).slice(0, 5).split(":").map(Number); return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : NaN; };
const dateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
const timeKey = (value) => /^\d{2}:\d{2}$/.test(String(value || "")) ? String(value) : "";
const normalizePoint = (value) => value < 5 * 60 ? value + 24 * 60 : value;

function configFrom(data = {}) {
  let saved = {};
  try { saved = JSON.parse(data.customers?.[OPERATIONS_CONFIG_KEY]?.notes || data.operationsConfig?.notes || "{}"); } catch {}
  const courses = Array.isArray(saved.courses) ? saved.courses : Object.entries(DEFAULT_COURSES).map(([code, item], order) => ({ code, ...item, enabled: true, order }));
  const rooms = Array.isArray(saved.rooms) ? saved.rooms : Object.entries(DEFAULT_ROOMS).map(([code, item], order) => ({ code, ...item, order }));
  return {
    courses: courses.filter((item) => item && item.enabled !== false).map((item) => ({ code: String(item.code), name: String(item.name || item.code), duration: Math.max(10, Number(item.duration || 60)), price: Math.max(0, Number(item.price || 0)), order: Number(item.order || 0) })).sort((a, b) => a.order - b.order),
    rooms: rooms.filter((item) => item && item.enabled !== false).map((item) => ({ code: String(item.code), external: item.external === true || String(item.code) === "OUT" }))
  };
}

function shiftSegments(shift = "") {
  if (!shift || /休|尚未|行政/.test(String(shift))) return [];
  return String(shift).split(/[\s,、，]+/).map((part) => {
    const [startText, endText] = part.split("-"); let start = minutes(startText); let end = minutes(endText);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end <= start) end += 24 * 60;
    return { start: normalizePoint(start), end: normalizePoint(end) };
  }).filter(Boolean);
}

function isAvailable(data, input) {
  const date = dateKey(input.date); const time = timeKey(input.time); const course = configFrom(data).courses.find((item) => item.code === String(input.service));
  if (!date || !time || !course) return [];
  const start = normalizePoint(minutes(time)); const end = start + course.duration;
  const activeRooms = configFrom(data).rooms.filter((room) => !room.external).map((room) => room.code);
  const appointments = Object.values(data.appointments || {}).filter((item) => String(item.date) === date);
  const pendingSelections = Object.values(data.customers || {}).map((item) => {
    try { return JSON.parse(item?.notes || ""); } catch { return null; }
  }).filter((item) => item && item.source === "public-booking" && item.status === "pending" && String(item.date) === date);
  return Object.entries(data.therapists || {}).map(([id, profile]) => {
    const inShift = shiftSegments(data.schedules?.[id]?.[date]).some((segment) => start >= segment.start && end <= segment.end);
    const therapistBusy = appointments.some((item) => String(item.therapistId) === String(id) && start < normalizePoint(minutes(item.time)) + Number(item.duration || 60) && end > normalizePoint(minutes(item.time)));
    const roomFree = activeRooms.some((room) => !appointments.some((item) => String(item.room) === room && start < normalizePoint(minutes(item.time)) + Number(item.duration || 60) + 10 && end + 10 > normalizePoint(minutes(item.time))));
    const publicRequestBusy = pendingSelections.some((item) => String(item.selectedTherapistId) === String(id) && start < normalizePoint(minutes(item.time)) + Number(item.duration || 60) && end > normalizePoint(minutes(item.time)));
    if (!inShift || therapistBusy || publicRequestBusy || !roomFree) return null;
    return { id: String(id), name: String(profile.nickname || profile.name || id), photoUrl: String(profile.photoUrl || ""), specialties: String(profile.specialties || profile.bio || "").slice(0, 180) };
  }).filter(Boolean);
}

function slotsFor(data, date, service) {
  const selectedDate = dateKey(date); if (!selectedDate || !configFrom(data).courses.some((item) => item.code === String(service))) return [];
  const now = new Date(); const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; const isToday = selectedDate === localToday; const current = now.getHours() * 60 + now.getMinutes();
  const slots = [];
  for (let point = 11 * 60; point <= 25 * 60; point += 30) {
    if (isToday && point % (24 * 60) <= current) continue;
    const time = `${String(Math.floor(point / 60) % 24).padStart(2, "0")}:${String(point % 60).padStart(2, "0")}`;
    if (isAvailable(data, { date: selectedDate, time, service }).length) slots.push(time);
  }
  return slots;
}

function publicSnapshot(data, query = {}) {
  const config = configFrom(data);
  const date = dateKey(query.date);
  const service = String(query.service || "");
  const time = timeKey(query.time);
  return { courses: config.courses, date, service, time, slots: date && service ? slotsFor(data, date, service) : [], therapists: date && service && time ? isAvailable(data, { date, service, time }) : [] };
}

function validateSubmission(data, body = {}) {
  const date = dateKey(body.date); const time = timeKey(body.time); const service = String(body.service || ""); const therapistId = String(body.therapistId || "");
  const contact = String(body.customerContact || "").trim().slice(0, 120);
  const nowLimit = new Date(); nowLimit.setHours(0, 0, 0, 0); const max = new Date(nowLimit.getTime() + 30 * DAY_MS);
  const scheduled = new Date(`${date}T${time}:00`);
  const id = String(body.requestId || "").trim();
  if (!/^PUB-[A-Za-z0-9_-]{8,100}$/.test(id)) throw Object.assign(new Error("invalid_request_id"), { code: "validation_error" });
  if (!date || !time || !service || !therapistId || !contact) throw Object.assign(new Error("invalid_public_booking"), { code: "validation_error" });
  if (!Number.isFinite(scheduled.getTime()) || scheduled <= new Date() || scheduled < nowLimit || scheduled > max) throw Object.assign(new Error("booking_time_unavailable"), { code: "booking_conflict" });
  const course = configFrom(data).courses.find((item) => item.code === service);
  const available = isAvailable(data, { date, time, service });
  if (!course || !available.some((item) => item.id === therapistId)) throw Object.assign(new Error("booking_time_unavailable"), { code: "booking_conflict" });
  const therapist = available.find((item) => item.id === therapistId);
  return { id, status: "pending", source: "public-booking", actorType: "customer_public", internalReminderStatus: "not_configured", date, time, service, duration: course.duration, therapistIds: [therapistId], selectedTherapistId: therapistId, selectedTherapistName: therapist.name, customerName: String(body.customerName || "").trim().slice(0, 80), customerContact: contact, customerNote: String(body.customerNote || "").trim().slice(0, 1000), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function selectionRecord(selection) { return { phone: `${CLIENT_SELECTION_PREFIX}${selection.id}`, name: `pending-${selection.customerName || selection.customerContact}-${selection.selectedTherapistName}`, notes: JSON.stringify(selection), records: [] }; }

module.exports = { CLIENT_SELECTION_PREFIX, publicSnapshot, validateSubmission, selectionRecord, configFrom, isAvailable, slotsFor };
