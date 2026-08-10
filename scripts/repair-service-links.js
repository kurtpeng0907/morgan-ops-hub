"use strict";

const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { neon } = require("@neondatabase/serverless");
const { transform } = require("./_lib/transform-sheets");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const input = arg("--input");
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (!input) throw new Error("--input /secure/path/snapshot.json is required");
if (!databaseUrl) throw new Error("DATABASE_URL is required");

async function main() {
  const source = transform(JSON.parse(readFileSync(resolve(input), "utf8")));
  const sql = neon(databaseUrl);
  let changed = 0;
  for (let index = 0; index < source.serviceRecords.length; index += 100) {
    const batch = source.serviceRecords.slice(index, index + 100);
    const results = await sql.transaction(batch.map((item) => sql`
      UPDATE service_records
      SET appointment_id = ${item.appointmentId}
      WHERE record_id = ${item.recordId}
        AND appointment_id IS DISTINCT FROM ${item.appointmentId}
      RETURNING record_id
    `));
    changed += results.reduce((total, rows) => total + rows.length, 0);
  }
  console.log(JSON.stringify({ success: true, changed }));
}

main().catch((error) => {
  console.error(`Repair failed: ${String(error.message || error)}`);
  process.exitCode = 1;
});
