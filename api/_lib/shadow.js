"use strict";

const crypto = require("node:crypto");

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function projectSelectedDay(data = {}, date, identity = {}) {
  const role = identity.role === "admin" ? "admin" : "therapist";
  const actorId = String(identity.id || identity.sub || "");
  const appointments = Object.fromEntries(Object.entries(data.appointments || {}).filter(([, item]) => String(item?.date || "") === date));
  const appointmentIds = new Set(Object.keys(appointments));
  const phones = new Set(Object.values(appointments).map((item) => String(item?.phone || "")).filter(Boolean));
  const therapists = role === "admin"
    ? (data.therapists || {})
    : Object.fromEntries(Object.entries(data.therapists || {}).filter(([key]) => key === actorId));
  const center = new Date(`${date}T12:00:00Z`);
  const from = new Date(center); from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date(center); to.setUTCDate(to.getUTCDate() + 7);
  const fromKey = from.toISOString().slice(0, 10);
  const toKey = to.toISOString().slice(0, 10);
  const scheduleSource = role === "admin"
    ? (data.schedules || {})
    : Object.fromEntries(Object.entries(data.schedules || {}).filter(([key]) => key === actorId));
  const schedules = Object.fromEntries(Object.entries(scheduleSource).flatMap(([id, days]) => {
    const selected = Object.fromEntries(Object.entries(days || {}).filter(([day]) => day >= fromKey && day <= toKey));
    return Object.keys(selected).length ? [[id, selected]] : [];
  }));
  const customers = {};
  for (const [key, item] of Object.entries(data.customers || {})) {
    if (!key.startsWith("SYS_") && phones.has(key)) customers[key] = { ...item, records: [] };
    else if (key.startsWith("SYS_APPT_META_") && appointmentIds.has(key.slice(14))) customers[key] = item;
    else if (role === "admin" && (key.startsWith("SYS_THERAPIST_PROFILE_") || key.startsWith("SYS_APPROVAL_"))) customers[key] = item;
    else if (role === "therapist" && key === `SYS_THERAPIST_PROFILE_${actorId}`) customers[key] = item;
  }
  return { therapists, schedules, admins: role === "admin" ? (data.admins || {}) : {}, appointments, customers };
}

function summarize(data = {}) {
  const identityDirectory = (directory) => Object.fromEntries(Object.entries(directory || {}).map(([id, item]) => [id, {
    name: String(item?.name || item?.nickname || "")
  }]));
  const clean = {
    therapists: identityDirectory(data.therapists),
    schedules: data.schedules || {},
    appointments: data.appointments || {},
    customers: data.customers || {},
    admins: identityDirectory(data.admins)
  };
  return {
    counts: Object.fromEntries(Object.entries(clean).map(([key, value]) => [key, Object.keys(value).length])),
    sha256: digest(clean)
  };
}

function logShadow(route, requestId, sqlData, sheetsData) {
  const sql = summarize(sqlData);
  const sheets = summarize(sheetsData);
  console.log(JSON.stringify({
    event: "morgan_sql_shadow",
    requestId,
    route,
    match: sql.sha256 === sheets.sha256,
    sql,
    sheets
  }));
}

module.exports = { digest, summarize, logShadow, projectSelectedDay, canonical };
