#!/usr/bin/env node
/*
 * Dependency audit gate for CI: fails when `npm audit` reports a HIGH or CRITICAL advisory in production
 * dependencies, except for packages listed (with a reason and an expiry date) in audit-allowlist.json.
 * An allowlist entry that has expired, or that does not document the advisory, the affected versions, the rationale and the
 * approval date, fails the gate too, so exceptions cannot be forgotten or left undocumented.
 *
 * Usage: npm run audit:prod
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const allowlist = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'audit-allowlist.json'), 'utf8'));
const now = new Date();

// Every exception must be documented, otherwise it is refused (and the gate fails).
const REQUIRED = ['package', 'advisory', 'advisoryUrl', 'affected', 'rationale', 'approvedOn', 'expires'];
const incomplete = allowlist.flatMap((a) => REQUIRED.filter((f) => !a[f]).map((f) => `allowlist entry "${a.package ?? '?'}" is missing "${f}"`));
if (incomplete.length > 0) {
  incomplete.forEach((m) => console.error('FAIL: ' + m));
  process.exit(1);
}

let raw;
try {
  raw = execSync('npm audit --omit=dev --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (err) {
  raw = err.stdout; // npm audit exits non-zero when it finds something; the JSON is still on stdout
}
if (!raw) {
  console.error('audit-gate: npm audit produced no output (registry unreachable?)');
  process.exit(2);
}

const vulnerabilities = JSON.parse(raw).vulnerabilities ?? {};
const failures = [];
const accepted = [];

for (const [name, v] of Object.entries(vulnerabilities)) {
  if (!['high', 'critical'].includes(v.severity)) continue;
  const rule = allowlist.find((a) => a.package === name);
  if (!rule) failures.push(`${name} (${v.severity}) has no allowlist entry`);
  else if (new Date(rule.expires) < now) failures.push(`${name}: allowlist entry expired on ${rule.expires} (${rule.advisory})`);
  else accepted.push(`${name} (${v.severity}) accepted until ${rule.expires}: ${rule.advisory}, affected ${rule.affected}`);
}

accepted.forEach((a) => console.log('accepted: ' + a));
if (failures.length > 0) {
  failures.forEach((f) => console.error('FAIL: ' + f));
  process.exit(1);
}
console.log('audit-gate: no unaccepted high or critical advisories in production dependencies');
