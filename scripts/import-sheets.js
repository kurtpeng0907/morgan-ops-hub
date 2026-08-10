"use strict";

const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { neon } = require("@neondatabase/serverless");
const { hashPin } = require("../api/_lib/pin");
const { transform } = require("./_lib/transform-sheets");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const input = arg("--input");
const sync = process.argv.includes("--sync");
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (!input) throw new Error("--input /secure/path/snapshot.json is required");
if (!databaseUrl) throw new Error("DATABASE_URL is required");

async function runBatch(sql, queries, size = 100) {
  for (let index = 0; index < queries.length; index += size) {
    await sql.transaction(queries.slice(index, index + size));
  }
}

async function main() {
  const raw = readFileSync(resolve(input), "utf8");
  const sourceSha256 = createHash("sha256").update(raw).digest("hex");
  const data = transform(JSON.parse(raw));
  const sql = neon(databaseUrl);
  const occupancy = await sql`
    SELECT (SELECT count(*) FROM users)::int AS users,
           (SELECT count(*) FROM appointments)::int AS appointments,
           (SELECT count(*) FROM customers)::int AS customers
  `;
  if (!sync && Object.values(occupancy[0]).some((count) => Number(count) > 0)) {
    throw new Error("Target database is not empty; refusing to overwrite existing SQL data");
  }

  const knownUserIds = new Set(data.users.map((user) => user.accountId));
  const referencedTherapists = new Set([
    ...data.appointments.map((item) => item.therapistId),
    ...data.serviceRecords.map((item) => item.therapistId),
    ...data.schedules.map((item) => item.therapistId)
  ].filter(Boolean));
  for (const therapistId of referencedTherapists) {
    if (knownUserIds.has(therapistId)) continue;
    data.users.push({ accountId: therapistId, displayName: therapistId, role: "therapist", pin: randomUUID(), active: false });
    data.therapists.push({ therapistId, displayName: therapistId, active: false });
    knownUserIds.add(therapistId);
  }

  const users = new Map();
  for (const user of data.users) {
    const previous = users.get(user.accountId);
    if (!previous || user.role === "admin") users.set(user.accountId, user);
  }
  const preparedUsers = [];
  for (const user of users.values()) {
    if (!user.pin) throw new Error(`Missing PIN for ${user.role} account ${user.accountId}`);
    preparedUsers.push({ ...user, pinHash: await hashPin(user.pin) });
  }

  const runRows = await sql`
    INSERT INTO migration_runs(source_sha256, source_counts, status)
    VALUES (${sourceSha256}, ${JSON.stringify(data.counts)}::jsonb, 'importing')
    RETURNING id
  `;
  const runId = runRows[0].id;

  try {
    await runBatch(sql, preparedUsers.map((item) => sql`
      INSERT INTO users(account_id, display_name, role, pin_hash, active)
      VALUES (${item.accountId}, ${item.displayName}, ${item.role}, ${item.pinHash}, ${item.active !== false})
      ON CONFLICT (account_id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role,
        pin_hash = EXCLUDED.pin_hash, active = EXCLUDED.active, updated_at = now()
    `));
    await runBatch(sql, data.therapists.map((item) => sql`
      INSERT INTO therapists(therapist_id, display_name, active)
      VALUES (${item.therapistId}, ${item.displayName}, ${item.active !== false})
      ON CONFLICT (therapist_id) DO UPDATE SET display_name = EXCLUDED.display_name, active = EXCLUDED.active
    `));
    await runBatch(sql, data.schedules.map((item) => sql`
      INSERT INTO schedules(therapist_id, date, shift)
      VALUES (${item.therapistId}, ${item.date}::date, ${item.shift})
      ON CONFLICT (therapist_id, date) DO UPDATE SET shift = EXCLUDED.shift, updated_at = now()
    `));
    await runBatch(sql, data.customers.map((item) => sql`
      INSERT INTO customers(customer_key_legacy, name, notes)
      VALUES (${item.customerKeyLegacy}, ${item.name}, ${item.notes})
      ON CONFLICT (customer_key_legacy) DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes, updated_at = now()
    `));
    await runBatch(sql, data.systemRecords.map((item) => sql`
      INSERT INTO system_records(key, name, notes, records)
      VALUES (${item.key}, ${item.name}, ${item.notes}, ${JSON.stringify(item.records)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes, records = EXCLUDED.records, updated_at = now()
    `));
    await runBatch(sql, data.appointments.map((item) => sql`
      INSERT INTO appointments(
        id, date, time, therapist_id, customer_id, customer_key_legacy, customer_name, service,
        duration, room, price, collected_price, is_completed, notes, booking_stage,
        remittance_due, remittance_paid, remittance_method
      ) VALUES (
        ${item.id}, ${item.date}::date, ${item.time}::time, ${item.therapistId},
        (SELECT id FROM customers WHERE customer_key_legacy = ${item.customerKeyLegacy}),
        ${item.customerKeyLegacy}, ${item.customerName}, ${item.service}, ${item.duration}, ${item.room},
        ${item.price}::numeric, ${item.collectedPrice}::numeric, ${item.isCompleted}, ${item.notes},
        ${item.bookingStage}, ${item.remittanceDue}::numeric, ${item.remittancePaid}, ${item.remittanceMethod}
      )
      ON CONFLICT (id) DO UPDATE SET
        date = EXCLUDED.date, time = EXCLUDED.time, therapist_id = EXCLUDED.therapist_id,
        customer_id = EXCLUDED.customer_id, customer_key_legacy = EXCLUDED.customer_key_legacy,
        customer_name = EXCLUDED.customer_name, service = EXCLUDED.service, duration = EXCLUDED.duration,
        room = EXCLUDED.room, price = EXCLUDED.price, collected_price = EXCLUDED.collected_price,
        is_completed = EXCLUDED.is_completed, notes = EXCLUDED.notes, booking_stage = EXCLUDED.booking_stage,
        remittance_due = EXCLUDED.remittance_due, remittance_paid = EXCLUDED.remittance_paid,
        remittance_method = EXCLUDED.remittance_method, updated_at = now()
    `));
    await runBatch(sql, data.serviceRecords.map((item) => sql`
      INSERT INTO service_records(
        record_id, appointment_id, customer_id, customer_key_legacy, date, therapist_id,
        therapist_name, service, collected_price, notes, created_at, updated_at, schema_version
      ) VALUES (
        ${item.recordId}, ${item.appointmentId},
        (SELECT id FROM customers WHERE customer_key_legacy = ${item.customerKeyLegacy}),
        ${item.customerKeyLegacy}, ${item.date}::date, ${item.therapistId}, ${item.therapistName},
        ${item.service}, ${item.collectedPrice}::numeric, ${item.notes},
        coalesce(${item.createdAt}::timestamptz, now()), coalesce(${item.updatedAt}::timestamptz, now()), 'service-record-v2'
      ) ON CONFLICT (record_id) DO UPDATE SET
        appointment_id = EXCLUDED.appointment_id, customer_id = EXCLUDED.customer_id,
        customer_key_legacy = EXCLUDED.customer_key_legacy, date = EXCLUDED.date,
        therapist_id = EXCLUDED.therapist_id, therapist_name = EXCLUDED.therapist_name,
        service = EXCLUDED.service, collected_price = EXCLUDED.collected_price,
        notes = EXCLUDED.notes, updated_at = EXCLUDED.updated_at, schema_version = 'service-record-v2'
    `));

    const imported = await sql`
      SELECT (SELECT count(*) FROM users)::int AS users,
             (SELECT count(*) FROM therapists)::int AS therapists,
             (SELECT count(*) FROM schedules)::int AS schedules,
             (SELECT count(*) FROM customers)::int AS customers,
             (SELECT count(*) FROM appointments)::int AS appointments,
             (SELECT count(*) FROM service_records)::int AS "serviceRecords",
             (SELECT count(*) FROM system_records)::int AS "systemRecords"
    `;
    await sql`UPDATE migration_runs SET imported_counts = ${JSON.stringify(imported[0])}::jsonb,
              status = 'imported', completed_at = now() WHERE id = ${runId}`;
    console.log(JSON.stringify({ success: true, migrationRunId: runId, sourceSha256, counts: imported[0] }));
  } catch (error) {
    await sql`UPDATE migration_runs SET status = 'failed', verification = ${JSON.stringify({ error: String(error.message || error).slice(0, 300) })}::jsonb,
              completed_at = now() WHERE id = ${runId}`;
    throw error;
  }
}

main().catch((error) => {
  console.error(`Import failed: ${String(error.message || error)}`);
  process.exitCode = 1;
});
