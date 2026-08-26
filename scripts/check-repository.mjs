#!/usr/bin/env node
/* Repository safety guard. Adapted from the kiaquila/web-design template at
   ea8501fdb90236fcb891e97b15f7a42a62f76ff1.

   It checks the things a static-site repository can get wrong: tracked build
   output or dependencies, committed secrets and personal paths, symlinks, and
   workflows that grant more than they need.

   Two deliberate choices, both learned from the 2251-line guard this replaced
   and from the review of its replacement:

   - It does not reason about shell text inside workflow steps. Every review
     finding against the old guard was a gap in that parsing. A job that cannot
     obtain a write token and cannot read a secret has nothing to escalate to,
     so those are the properties worth checking.
   - It reads workflows through a YAML parser rather than as text. Reading text
     meant re-deriving YAML one spelling at a time — quoted keys, escaped
     scalars, flow collections, anchors, merge keys, comments that look like
     block scalars — and every spelling missed was a silent bypass. The parser
     decides what the document says; this file only decides what is allowed. */

import { basename, join, resolve, sep } from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { loadConfig } from "./config.mjs";

const rootIndex = process.argv.indexOf("--root");
const root = resolve(
  rootIndex === -1 ? import.meta.dirname : process.argv[rootIndex + 1],
  rootIndex === -1 ? ".." : "."
);
const failures = [];

const REQUIRED = [
  ".github/CODEOWNERS",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  "scripts/check-performance-budget.mjs",
  "scripts/check-repository.mjs",
  "scripts/config.mjs",
  "scripts/run-project-checks.mjs",
  "web-design.config.json"
];

const FORBIDDEN_SEGMENTS = new Set([".next", ".wrangler", "build", "coverage", "dist", "node_modules"]);
const FORBIDDEN_NAMES = [/^\.DS_Store$/, /^\.env(?:\..+)?$/, /\.(?:key|p12|pfx|pem|session)$/i];
const SECRETS = [
  ["private key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["API key", /sk-[A-Za-z0-9_-]{32,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/]
];
const PERSONAL_PATHS = [/\/Users\/[A-Za-z0-9._-]+\//, /\/home\/[A-Za-z0-9._-]+\//, /[A-Za-z]:\\Users\\/];
const MAX_SCANNED_BYTES = 64_000_000;

/* Validation runs on proposed code. A write token would let a branch mint its
   own approval or publish from an unreviewed commit, and a manual or
   workflow_run trigger would let it supply the workflow itself. */
const READ_VALUES = new Set(["read", "none"]);
const FORBIDDEN_TRIGGERS = new Set(["pull_request_target", "workflow_run", "workflow_dispatch"]);

function listTrackedFiles() {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8"
  });
  if (listed.status !== 0) throw new Error(listed.stderr.trim() || "git ls-files failed");
  return listed.stdout.split("\0").filter(Boolean);
}

function checkFileContents(file) {
  const normalized = file.split(sep).join("/");
  const name = basename(normalized);
  if (normalized.split("/").some((part) => FORBIDDEN_SEGMENTS.has(part))) {
    failures.push(`Generated or dependency directory is tracked: ${normalized}`);
  }
  if (FORBIDDEN_NAMES.some((pattern) => pattern.test(name)) && name !== ".env.example") {
    failures.push(`Sensitive or local-only file is tracked: ${normalized}`);
  }

  /* lstat before any existence test: a symlink whose target is missing makes
     existsSync false, so checking that first would skip the entry entirely and
     let a dangling link through the no-symlink rule. */
  const path = join(root, file);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    failures.push(`Symbolic links are not allowed: ${normalized}`);
    return;
  }
  if (!stat.isFile()) return;
  /* Size does not exempt a file from the secret scan — a growing content
     export is exactly where a key would hide unnoticed. Only genuinely huge
     files are refused, and refused rather than skipped. */
  if (stat.size > MAX_SCANNED_BYTES) {
    failures.push(`Tracked file is too large to scan (${stat.size} B): ${normalized}`);
    return;
  }

  const buffer = readFileSync(path);
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return;
  const text = buffer.toString("utf8");
  for (const [label, pattern] of SECRETS) {
    if (pattern.test(text)) failures.push(`Possible ${label} in ${normalized}`);
  }
  if (PERSONAL_PATHS.some((pattern) => pattern.test(text))) {
    failures.push(`Personal absolute path in ${normalized}`);
  }
}

/* Every mapping entry anywhere in the parsed document. Keys arrive decoded, so
   every way YAML can spell one collapses to a single case here. */
function* entries(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* entries(item);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      yield { key, value };
      yield* entries(value);
    }
  }
}

function* strings(node) {
  if (typeof node === "string") yield node;
  else if (Array.isArray(node)) for (const item of node) yield* strings(item);
  else if (node && typeof node === "object") for (const value of Object.values(node)) yield* strings(value);
}

/* Accept only what is provably read-only, so an unrecognised grant fails
   rather than passes. An empty mapping grants nothing and is fine; `write-all`,
   any write scope, and anything unreadable are not. */
function permissionFailures(value) {
  if (value === "read-all") return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [String(value)];
  return Object.entries(value)
    .filter(([, granted]) => !READ_VALUES.has(granted))
    .map(([scope, granted]) => `${scope}: ${granted}`);
}

function triggerNames(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((item) => typeof item === "string");
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

function checkActionPin(action, workflow) {
  if (typeof action !== "string" || action.startsWith("./")) return;
  /* A container tag is mutable, so its publisher can change what CI runs
     without any commit here. Only a digest names fixed bytes. */
  if (action.startsWith("docker://")) {
    if (!/@sha256:[a-f0-9]{64}$/.test(action)) {
      failures.push(`Container action is not pinned to a digest in ${workflow}: ${action}`);
    }
    return;
  }
  const ref = action.slice(action.lastIndexOf("@") + 1);
  if (!/^[a-f0-9]{40}$/.test(ref)) {
    failures.push(`Action is not pinned to a full SHA in ${workflow}: ${action}`);
  }
}

function checkWorkflow(workflow) {
  let document;
  try {
    document = parse(readFileSync(join(root, workflow), "utf8"));
  } catch (error) {
    failures.push(`Workflow is not valid YAML: ${workflow}: ${error.message}`);
    return;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    failures.push(`Workflow must be a mapping: ${workflow}`);
    return;
  }

  for (const trigger of triggerNames(document.on)) {
    if (FORBIDDEN_TRIGGERS.has(trigger)) {
      failures.push(`Trigger ${trigger} lets a branch supply its own workflow in ${workflow}`);
    }
  }
  if (document.permissions === undefined) {
    failures.push(`Workflow must declare top-level permissions: ${workflow}`);
  }

  for (const { key, value } of entries(document)) {
    /* A job-level declaration overrides the top-level one, so every
       `permissions` in the document is held to the same rule. */
    if (key === "permissions") {
      for (const entry of permissionFailures(value)) {
        failures.push(`Workflow may not grant write permissions (${entry}) in ${workflow}`);
      }
    }
    /* `secrets: inherit` on a reusable workflow passes credentials on without
       ever naming one. */
    if (key === "secrets") {
      failures.push(`Workflow may not consume repository secrets in ${workflow}: secrets: ${value}`);
    }
    if (key === "uses") checkActionPin(value, workflow);
  }

  /* Only the automatic, permission-scoped token is allowed. Every other use of
     the context is refused, including `secrets['NAME']` and bare uses such as
     `toJSON(secrets)` that name no key at all. Escapes are already decoded. */
  for (const value of strings(document)) {
    for (const match of value.matchAll(/\bsecrets\b/g)) {
      if (/^secrets[ \t]*\.[ \t]*GITHUB_TOKEN\b/.test(value.slice(match.index))) continue;
      failures.push(`Workflow may not consume repository secrets in ${workflow}: ${value.trim().slice(0, 60)}`);
    }
  }
}

for (const path of REQUIRED) {
  if (!existsSync(join(root, path))) failures.push(`Missing harness file: ${path}`);
}

try {
  loadConfig(root);
} catch (error) {
  failures.push(...error.message.split("\n"));
}

const codeowners = join(root, ".github/CODEOWNERS");
if (existsSync(codeowners) && readFileSync(codeowners, "utf8").includes("replace-with-owner")) {
  failures.push("Replace the CODEOWNERS placeholder with the repository owner");
}

const files = listTrackedFiles();
for (const file of files) checkFileContents(file);

/* npm config can replace the shell that runs the package scripts, so a tracked
   .npmrc could redirect `npm run preflight` before the guard ever starts.
   CODEOWNERS puts these files behind review; this refuses the setting outright. */
for (const npmrc of files.filter((file) => /(?:^|\/)\.npmrc$/.test(file))) {
  const text = readFileSync(join(root, npmrc), "utf8");
  for (const setting of ["script-shell", "ignore-scripts", "unsafe-perm"]) {
    if (new RegExp(`^\\s*${setting}\\s*=`, "m").test(text)) {
      failures.push(`${npmrc} may not set ${setting}`);
    }
  }
}
for (const workflow of files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))) {
  checkWorkflow(workflow);
}

if (failures.length) {
  console.error([...new Set(failures)].map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Repository guard passed (${files.length} paths).`);
