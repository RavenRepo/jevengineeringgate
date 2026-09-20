#!/usr/bin/env node
// Registers (or removes) the jev hooks in ~/.claude/settings.json.
//   node bin/install-hooks.cjs [--remove] [--settings PATH]
// Appends alongside existing hooks rather than replacing them, backs up first,
// and is idempotent. Claude Code runs every matching hook and any deny wins, so
// this composes with whatever else is already registered.
const { readFileSync, writeFileSync, copyFileSync, existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const idx = args.indexOf("--settings");
const SETTINGS = idx >= 0 && args[idx + 1] ? args[idx + 1] : join(homedir(), ".claude", "settings.json");
const REPO = join(__dirname, "..");
const ENTRIES = [
  ["PreToolUse", "jev-pretooluse", { matcher: "*", hooks: [{ type: "command", command: `node ${REPO}/hooks/jev-pretooluse.cjs`, timeout: 10 }] }],
  ["UserPromptSubmit", "jev-intake", { hooks: [{ type: "command", command: `node ${REPO}/hooks/jev-intake.cjs`, timeout: 10 }] }],
];

if (!existsSync(SETTINGS)) {
  console.error(`no settings file at ${SETTINGS}`);
  process.exit(1);
}
let d;
try {
  d = JSON.parse(readFileSync(SETTINGS, "utf8"));
} catch (e) {
  console.error(`${SETTINGS} is not valid JSON; refusing to touch it. ${e.message}`);
  process.exit(1);
}

const backup = `${SETTINGS}.bak.jev-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(SETTINGS, backup);

const hooks = (d.hooks = d.hooks || {});
let changed = 0;
for (const [event, needle, entry] of ENTRIES) {
  const list = (hooks[event] = hooks[event] || []);
  const has = (e) => (e.hooks || []).some((h) => String(h.command || "").includes(needle));
  const present = list.some(has);
  if (remove) {
    const before = list.length;
    hooks[event] = list.filter((e) => !has(e));
    if (hooks[event].length !== before) { changed++; console.log(`removed ${needle} from ${event}`); }
  } else if (!present) {
    list.push(entry);
    changed++;
    console.log(`registered ${needle} on ${event}`);
  } else {
    console.log(`${needle} already registered on ${event}`);
  }
}

if (!changed) {
  console.log("nothing to change.");
  process.exit(0);
}
const out = JSON.stringify(d, null, 2) + "\n";
JSON.parse(out); // never write something that will not parse back
writeFileSync(SETTINGS, out);
console.log(`\nwrote ${SETTINGS}\nbackup ${backup}\nRestart Claude Code (or start a new session) for hooks to take effect.`);
