"use strict";

const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const roots = ["api", "scripts", "tests"];
const files = ["app.js", "drizzle.config.js"];

function collect(path) {
  for (const entry of readdirSync(path)) {
    const target = join(path, entry);
    if (statSync(target).isDirectory()) collect(target);
    else if (target.endsWith(".js")) files.push(target);
  }
}

roots.forEach(collect);
for (const file of [...new Set(files)].sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${new Set(files).size} JavaScript files.`);
