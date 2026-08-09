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
        FROM appointments ORDER BY id`,
    sql`SELECT customer_key_legacy, name, notes FROM customers ORDER BY customer_key_legacy`,
    sql`SELECT record_id, appointment_id, customer_key_legacy, date, therapist_id, service, collected_price, notes
        FROM service_records ORDER BY record_id`,
    sql`SELECT (SELECT count(*) FROM therapists)::int AS therapists,
               (SELECT count(*) FROM schedules)::int AS schedules,
               (SELECT count(*) FROM customers)::int AS customers,
               (SELECT count(*) FROM appointments)::int AS appointments,
               (SELECT count(*) FROM service_records)::int AS "serviceRecords",
               (SELECT count(*) FROM system_records)::int AS "systemRecords"`
  ], { readOnly: true });

  const sqlAppointments = appointmentRows.map((item) => ({
    id: String(item.id), date: String(item.date), time: String(item.time).slice(0, 5), therapistId: String(item.therapist_id),
    customerKeyLegacy: String(item.customer_key_legacy), customerName: String(item.customer_name), service: String(item.service),
    duration: Number(item.duration), room: String(item.room), price: numeric(item.price), collectedPrice: numeric(item.collected_price),
    isCompleted: item.is_completed === true, notes: String(item.notes), bookingStage: String(item.booking_stage),
    remittanceDue: numeric(item.remittance_due), remittancePaid: item.remittance_paid === true, remittanceMethod: String(item.remittance_method)
  }));
  const sqlCustomers = customerRows.map((item) => ({ customerKeyLegacy: String(item.customer_key_legacy), name: String(item.name), notes: String(item.notes) }));
  const sqlServiceRecords = serviceRows.map((item) => ({
    recordId: String(item.record_id), appointmentId: item.appointment_id ? String(item.appointment_id) : null,
    customerKeyLegacy: String(item.customer_key_legacy), date: String(item.date), therapistId: item.therapist_id ? String(item.therapist_id) : null,
    service: String(item.service), collectedPrice: numeric(item.collected_price), notes: String(item.notes)
  }));
  const actualHashes = {
    appointments: hash(sqlAppointments),
    customers: hash(sqlCustomers),
    serviceRecords: hash(sqlServiceRecords)
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
  const result = { success: !Object.keys(countDiffs).length && !Object.keys(hashDiffs).length, countDiffs, hashDiffs };
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
