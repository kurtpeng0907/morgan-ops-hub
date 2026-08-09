"use strict";

const { createHash, randomUUID } = require("node:crypto");

function text(value) { return value === null || value === undefined ? "" : String(value); }
function date(value) { return /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : "1970-01-01"; }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function canonicalRecord(record, customerKey) {
  const appointmentId = text(record.appointment_id || record.appointmentId || record.id);
  return {
    recordId: text(record.record_id || record.recordId || appointmentId || randomUUID()),
    appointmentId: appointmentId || null,
    customerKeyLegacy: text(record.customer_key_legacy || record.customerKey || customerKey),
    date: date(record.date),
    therapistId: text(record.therapist_id || record.therapistId) || null,
    therapistName: text(record.therapist_name || record.therapistName),
    service: text(record.service),
    collectedPrice: text(record.collected_price ?? record.collectedPrice) || null,
    notes: text(record.notes),
    createdAt: text(record.created_at || record.createdAt) || null,
    updatedAt: text(record.updated_at || record.updatedAt) || null,
    schemaVersion: "service-record-v2"
  };
}

function newerRecord(previous, candidate) {
  const previousTime = Date.parse(previous.updatedAt || previous.createdAt || 0) || 0;
  const candidateTime = Date.parse(candidate.updatedAt || candidate.createdAt || 0) || 0;
  return candidateTime >= previousTime ? candidate : previous;
}

function transform(source) {
  const db = source?.data && source.data.therapists ? source.data : source;
  if (!db || typeof db !== "object") throw new Error("invalid Sheets snapshot");
  const users = [];
  const therapists = [];
  const schedules = [];
  const customers = [];
  const appointments = [];
  const systemRecords = [];
  const recordMap = new Map();
  const appointmentRecordMap = new Map();

  for (const [id, item] of Object.entries(db.therapists || {})) {
    if (!id || id === "編號") continue;
    const name = text(item.name || item.nickname || id);
    users.push({ accountId: text(id), displayName: name, role: "therapist", pin: text(item.pin), active: true });
    therapists.push({ therapistId: text(id), displayName: name, active: true });
  }
  for (const [id, values] of Object.entries(db.schedules || {})) {
    for (const [day, shift] of Object.entries(values || {})) schedules.push({ therapistId: text(id), date: date(day), shift: text(shift) });
  }
  for (const [id, item] of Object.entries(db.appointments || {})) {
    appointments.push({
      id: text(item.id || id), date: date(item.date), time: text(item.time || "00:00").slice(0, 5),
      therapistId: text(item.therapistId), customerKeyLegacy: text(item.phone), customerName: text(item.customerName),
      service: text(item.service), duration: Number(item.duration || 60), room: text(item.room || "R"),
      price: text(item.price) || null, collectedPrice: text(item.collectedPrice) || null,
      isCompleted: item.isCompleted === true || text(item.isCompleted) === "true", notes: text(item.notes),
      bookingStage: text(item.bookingStage), remittanceDue: text(item.remittanceDue) || null,
      remittancePaid: item.remittancePaid === true || text(item.remittancePaid) === "true",
      remittanceMethod: text(item.remittanceMethod)
    });
  }
  for (const [key, item] of Object.entries(db.customers || {})) {
    if (key.startsWith("SYS_ADMIN_") && key !== "SYS_ADMIN_LOGIN_LOG") {
      users.push({ accountId: key.slice(10), displayName: text(item.name || key.slice(10)), role: "admin", pin: text(item.notes), active: true });
      continue;
    }
    if (key.startsWith("SYS_")) {
      systemRecords.push({ key, name: text(item.name), notes: text(item.notes), records: Array.isArray(item.records) ? item.records : [] });
      continue;
    }
    customers.push({ customerKeyLegacy: text(key), name: text(item.name), notes: text(item.notes) });
    for (const raw of Array.isArray(item.records) ? item.records : []) {
      const record = canonicalRecord(raw, key);
      if (!record.recordId) continue;
      const selected = recordMap.has(record.recordId) ? newerRecord(recordMap.get(record.recordId), record) : record;
      recordMap.set(record.recordId, selected);
      if (selected.appointmentId) appointmentRecordMap.set(selected.appointmentId, appointmentRecordMap.has(selected.appointmentId) ? newerRecord(appointmentRecordMap.get(selected.appointmentId), selected) : selected);
    }
  }
  for (const raw of Array.isArray(db.serviceRecords) ? db.serviceRecords : []) {
    if (text(raw.customer_key_legacy).startsWith("SYS_")) continue;
    const record = canonicalRecord(raw, raw.customer_key_legacy);
    const selected = recordMap.has(record.recordId) ? newerRecord(recordMap.get(record.recordId), record) : record;
    recordMap.set(record.recordId, selected);
    if (selected.appointmentId) appointmentRecordMap.set(selected.appointmentId, appointmentRecordMap.has(selected.appointmentId) ? newerRecord(appointmentRecordMap.get(selected.appointmentId), selected) : selected);
  }
  const appointmentWinners = new Set([...appointmentRecordMap.values()].map((record) => record.recordId));
  const serviceRecords = [...recordMap.values()].filter((record) => !record.appointmentId || appointmentWinners.has(record.recordId));
  const counts = Object.fromEntries(Object.entries({ users, therapists, schedules, customers, appointments, serviceRecords, systemRecords }).map(([key, value]) => [key, value.length]));
  const hashes = {
    appointments: hash(appointments.slice().sort((a, b) => a.id.localeCompare(b.id))),
    customers: hash(customers.slice().sort((a, b) => a.customerKeyLegacy.localeCompare(b.customerKeyLegacy))),
    serviceRecords: hash(serviceRecords.slice().sort((a, b) => a.recordId.localeCompare(b.recordId)).map(({ recordId, appointmentId, customerKeyLegacy, date: day, therapistId, service, collectedPrice, notes }) => ({ recordId, appointmentId, customerKeyLegacy, date: day, therapistId, service, collectedPrice, notes })))
  };
  return { users, therapists, schedules, customers, appointments, serviceRecords, systemRecords, counts, hashes };
}

module.exports = { transform, canonicalRecord, hash };
