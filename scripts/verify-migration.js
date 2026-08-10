"use strict";

const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { neon } = require("@neondatabase/serverless");
const { transform, hash } = require("./_lib/transform-sheets");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
function numeric(value) { return value === null || value === undefined ? null : String(value).replace(/\.00$/, ""); }
function dateOnly(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const raw = String(value || "");
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : raw;
}

const input = arg("--input");
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (!input) throw new Error("--input /secure/path/snapshot.json is required");
if (!databaseUrl) throw new Error("DATABASE_URL is required");

async function main() {
  const source = transform(JSON.parse(readFileSync(resolve(input), "utf8")));
  const sql = neon(databaseUrl);
  const [appointmentRows, customerRows, serviceRows, countRows] = await sql.transaction([
    sql`SELECT id, date, time, therapist_id, customer_key_legacy, customer_name, service, duration, room,
               price, collected_price, is_completed, notes, booking_stage, remittance_due, remittance_paid, remittance_method
        FROM appointments`,
    sql`SELECT customer_key_legacy, name, notes FROM customers`,
    sql`SELECT record_id, appointment_id, customer_key_legacy, date, therapist_id, service, collected_price, notes
        FROM service_records`,
    sql`SELECT (SELECT count(*) FROM therapists WHERE active = true)::int AS therapists,
               (SELECT count(*) FROM schedules)::int AS schedules,
               (SELECT count(*) FROM customers)::int AS customers,
               (SELECT count(*) FROM appointments)::int AS appointments,
               (SELECT count(*) FROM service_records)::int AS "serviceRecords",
               (SELECT count(*) FROM system_records)::int AS "systemRecords"`
  ], { readOnly: true });

  const sqlAppointments = appointmentRows.map((item) => ({
    id: String(item.id), date: dateOnly(item.date), time: String(item.time).slice(0, 5), therapistId: String(item.therapist_id),
    customerKeyLegacy: String(item.customer_key_legacy), customerName: String(item.customer_name), service: String(item.service),
    duration: Number(item.duration), room: String(item.room), price: numeric(item.price), collectedPrice: numeric(item.collected_price),
    isCompleted: item.is_completed === true, notes: String(item.notes), bookingStage: String(item.booking_stage),
    remittanceDue: numeric(item.remittance_due), remittancePaid: item.remittance_paid === true, remittanceMethod: String(item.remittance_method)
  }));
  const sqlCustomers = customerRows.map((item) => ({ customerKeyLegacy: String(item.customer_key_legacy), name: String(item.name), notes: String(item.notes) }));
  const sqlServiceRecords = serviceRows.map((item) => ({
    recordId: String(item.record_id), appointmentId: item.appointment_id ? String(item.appointment_id) : null,
    customerKeyLegacy: String(item.customer_key_legacy), date: dateOnly(item.date), therapistId: item.therapist_id ? String(item.therapist_id) : null,
    service: String(item.service), collectedPrice: numeric(item.collected_price), notes: String(item.notes)
  }));
  const actualHashes = {
    appointments: hash(sqlAppointments.sort((a, b) => a.id.localeCompare(b.id))),
    customers: hash(sqlCustomers.sort((a, b) => a.customerKeyLegacy.localeCompare(b.customerKeyLegacy))),
    serviceRecords: hash(sqlServiceRecords.sort((a, b) => a.recordId.localeCompare(b.recordId)))
  };
  const countDiffs = {};
  for (const [key, expected] of Object.entries(source.counts)) {
    if (["users"].includes(key)) continue;
    const actual = Number(countRows[0][key] || 0);
    if (actual !== expected) countDiffs[key] = { expected, actual };
  }
  const hashDiffs = {};
  for (const key of Object.keys(source.hashes)) {
    if (source.hashes[key] !== actualHashes[key]) hashDiffs[key] = { expected: source.hashes[key], actual: actualHashes[key] };
  }
  const differingFields = (expectedRows, actualRows, key) => {
    const actualByKey = new Map(actualRows.map((row) => [row[key], row]));
    return expectedRows.flatMap((expected) => {
      const actual = actualByKey.get(expected[key]);
      if (!actual) return [{ key: expected[key], fields: ["missing"] }];
      const fields = Object.keys(expected).filter((field) => JSON.stringify(expected[field]) !== JSON.stringify(actual[field]));
      return fields.length ? [{ key: expected[key], fields }] : [];
    }).slice(0, 20);
  };
  const diagnostics = {};
  if (hashDiffs.appointments) diagnostics.appointments = differingFields(source.appointments, sqlAppointments, "id");
  if (hashDiffs.serviceRecords) {
    const expected = source.serviceRecords.map(({ recordId, appointmentId, customerKeyLegacy, date: day, therapistId, service, collectedPrice, notes }) => ({ recordId, appointmentId, customerKeyLegacy, date: day, therapistId, service, collectedPrice, notes }));
    diagnostics.serviceRecords = differingFields(expected, sqlServiceRecords, "recordId");
  }
  const result = { success: !Object.keys(countDiffs).length && !Object.keys(hashDiffs).length, countDiffs, hashDiffs, diagnostics };
  const run = await sql`SELECT id FROM migration_runs ORDER BY created_at DESC LIMIT 1`;
  if (run[0]) await sql`UPDATE migration_runs SET verification = ${JSON.stringify(result)}::jsonb,
                         status = ${result.success ? "verified" : "mismatch"}, completed_at = now() WHERE id = ${run[0].id}`;
  console.log(JSON.stringify(result));
  if (!result.success) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`Verification failed: ${String(error.message || error)}`);
  process.exitCode = 1;
});
