"use strict";

const { readFileSync, readdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { Client } = require("pg");

const url = String(process.env.DATABASE_URL || "").trim();
if (!url) throw new Error("DATABASE_URL is required");

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS drizzle_migrations_local (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
    const files = readdirSync(resolve("drizzle")).filter((name) => name.endsWith(".sql")).sort();
    for (const filename of files) {
      const found = await client.query("SELECT 1 FROM drizzle_migrations_local WHERE filename = $1", [filename]);
      if (found.rowCount) continue;
      const migration = readFileSync(resolve("drizzle", filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(migration);
        await client.query("INSERT INTO drizzle_migrations_local(filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      console.log(`Applied ${filename}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${String(error.message || error)}`);
  process.exitCode = 1;
});
