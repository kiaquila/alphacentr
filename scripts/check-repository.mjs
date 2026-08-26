#!/usr/bin/env node
/* Repository safety guard. Adapted from the kiaquila/web-design template at
   ea8501fdb90236fcb891e97b15f7a42a62f76ff1.

   It checks the things a static-site repository can get wrong by accident:
   tracked build output or dependencies, committed secrets and personal paths,
   symlinks, and workflows that grant more than they need. It deliberately does
   not try to reason about shell text inside workflow steps — the previous
   2251-line attempt did, and every review finding against it was a gap in that
   parsing. This repository has one workflow, no write-capable job, and no
   actor-controlled input, so the property is enforced structurally below. */

import { basename, join, resolve, sep } from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

/* Permissions a pull-request workflow must never grant itself. Validation runs
   on proposed code, so anything beyond reading the repository would let a
   branch mint its own approval or publish from an unreviewed commit. */
const WRITE_SCOPES = [
  "actions", "attestations", "checks", "contents", "deployments", "discussions",
  "id-token", "issues", "packages", "pages", "pull-requests", "repository-projects",
  "security-events", "statuses"
];

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

  const path = join(root, file);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    failures.push(`Symbolic links are not allowed: ${normalized}`);
    return;
  }
  if (!stat.isFile() || stat.size > 2_000_000) return;

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

/* The guard reads permissions and action refs, both of which are plain YAML
   scalars. It does not interpret `run:` bodies: a job that cannot obtain a
   write token and cannot be handed an actor-controlled value has nothing to
   escalate to, so the token grant is the property worth checking. */
function checkWorkflow(workflow) {
  const text = readFileSync(join(root, workflow), "utf8");

  if (/\bpull_request_target\b/.test(text)) {
    failures.push(`High-risk pull_request_target trigger in ${workflow}`);
  }
  if (/^\s*workflow_run:/m.test(text)) {
    failures.push(`workflow_run runs privileged against proposed code in ${workflow}`);
  }
  if (!/^permissions:\s*(?:\n|$)/m.test(text)) {
    failures.push(`Workflow must declare top-level permissions: ${workflow}`);
  }
  if (/^permissions:\s*["']?write-all["']?\s*$/m.test(text)) {
    failures.push(`Workflow may not use write-all: ${workflow}`);
  }
  for (const match of text.matchAll(/^\s*(?:[a-z-]+|["'][a-z-]+["']):\s*write\s*(?:#.*)?$/gm)) {
    const scope = match[0].trim().split(":")[0].replaceAll(/["']/g, "");
    if (WRITE_SCOPES.includes(scope)) {
      failures.push(`Workflow may not grant ${scope}: write in ${workflow}`);
    }
  }
  if (/\bsecrets\.(?!GITHUB_TOKEN\b)[A-Za-z_][A-Za-z0-9_]*/.test(text)) {
    failures.push(`Workflow may not consume repository secrets in ${workflow}`);
  }
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*["']?([^\s"']+)["']?\s*(?:#.*)?$/gm)) {
    const action = match[1];
    if (action.startsWith("./") || action.startsWith("docker://")) continue;
    const ref = action.slice(action.lastIndexOf("@") + 1);
    if (!/^[a-f0-9]{40}$/.test(ref)) {
      failures.push(`Action is not pinned to a full SHA in ${workflow}: ${action}`);
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
for (const workflow of files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))) {
  checkWorkflow(workflow);
}

if (failures.length) {
  console.error([...new Set(failures)].map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Repository guard passed (${files.length} paths).`);
