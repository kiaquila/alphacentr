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

const PERMISSIONS_KEY = /^([ \t]*)(?:permissions|"permissions"|'permissions')[ \t]*:[ \t]*(.*)$/;
const READ_VALUES = new Set(["read", "none"]);

/* This guard reads raw workflow text rather than a parsed YAML document, which
   is only sound while a scalar's text and its decoded value agree. The
   double-quoted style is the one YAML style that decodes escapes, so
   "permissio\u006es" parses as the key `permissions` and
   "${{ \x73ecrets.X }}" parses as a secrets expression — in both cases the
   raw text hides what GitHub actually sees. Every double-quoted scalar
   containing a backslash is therefore refused, key or value alike.

   The remaining indirections are refused for the same reason: an explicit
   `? key`, and anchors, aliases and merge keys, which move a mapping's content
   somewhere the line-by-line reading never looks. Plain and single-quoted
   scalars read identically parsed and unparsed — single quotes have no escape
   but '' — so those stay. Nothing in a GitHub workflow needs the refused
   forms, and refusing them is what keeps this text reading equivalent to the
   parsed one rather than merely close to it. */
const UNREADABLE_YAML = [
  [/"[^"\n]*\\[^"\n]*"/, "an escaped double-quoted scalar"],
  [/^[ \t]*\?(?:[ \t]|$)/m, "an explicit key"],
  [/^[ \t]*(?:<<|"<<"|'<<')[ \t]*:/m, "a merge key"],
  [/:[ \t]+[&*][A-Za-z_][\w-]*(?=[ \t]|$)/m, "a YAML anchor or alias"],
  [/^[ \t]*-[ \t]+[&*][A-Za-z_][\w-]*(?=[ \t]|$)/m, "a YAML anchor or alias"]
];

function unquote(value) {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2].trim() : trimmed;
}

/* Every `permissions:` declaration must be provably read-only, and anything
   this cannot read is rejected rather than assumed safe.

   That direction matters. Hunting for write grants needs a new pattern for
   every way YAML can spell one — bare, quoted value, quoted key, flow mapping,
   trailing comment — and each missed spelling silently grants a token. Asking
   instead whether every entry is `read` or `none` has one answer, and an
   unfamiliar shape fails the build instead of passing it. */
function permissionFailures(text) {
  const lines = text.split("\n");
  const failures = [];

  const checkEntry = (entry) => {
    const separator = entry.indexOf(":");
    const value = separator === -1 ? "" : unquote(entry.slice(separator + 1));
    if (separator === -1 || !READ_VALUES.has(value)) failures.push(entry.trim());
  };

  for (const [index, line] of lines.entries()) {
    const declaration = line.match(PERMISSIONS_KEY);
    if (!declaration) continue;
    const [, indent, rest] = declaration;
    const inline = rest.replace(/\s#.*$/, "").trim();

    if (inline) {
      const value = unquote(inline);
      if (!value.startsWith("{")) {
        if (value !== "read-all") failures.push(inline);
      } else if (!value.endsWith("}")) {
        failures.push(inline);
      } else {
        const inner = value.slice(1, -1).trim();
        if (inner) inner.split(",").forEach(checkEntry);
      }
      continue;
    }

    for (const nested of lines.slice(index + 1)) {
      if (!nested.trim() || nested.trim().startsWith("#")) continue;
      if (nested.match(/^[ \t]*/)[0].length <= indent.length) break;
      checkEntry(nested.replace(/\s#.*$/, ""));
    }
  }
  return failures;
}

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
  const declaresTopLevel = text
    .split("\n")
    .some((line) => !/^[ \t]/.test(line) && PERMISSIONS_KEY.test(line));
  if (!declaresTopLevel) {
    failures.push(`Workflow must declare top-level permissions: ${workflow}`);
  }
  for (const [pattern, description] of UNREADABLE_YAML) {
    if (pattern.test(text)) {
      failures.push(`Workflow uses ${description}, which this guard does not decode: ${workflow}`);
    }
  }
  /* Validation runs on proposed code, so a write token anywhere in the file —
     top-level or on any job, which overrides it — would let a branch mint its
     own approval or publish from an unreviewed commit. */
  for (const entry of permissionFailures(text)) {
    failures.push(`Workflow may not grant write permissions (${entry}) in ${workflow}`);
  }
  /* A workflow that validates proposed code has no business reading a
     repository secret. Only `secrets.GITHUB_TOKEN` — the automatic,
     permission-scoped token this file already constrains to read — is allowed;
     every other way of naming the context is refused, including the bracket
     form `secrets['NAME']` and `secrets: inherit` on a reusable workflow. */
  for (const match of text.matchAll(/\bsecrets[ \t]*[.[:]/g)) {
    if (/^secrets[ \t]*\.[ \t]*GITHUB_TOKEN\b/.test(text.slice(match.index))) continue;
    failures.push(`Workflow may not consume repository secrets in ${workflow}: ${match[0]}`);
  }
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*["']?([^\s"']+)["']?\s*(?:#.*)?$/gm)) {
    const action = match[1];
    if (action.startsWith("./")) continue;
    /* A container tag is mutable, so its publisher can change what CI runs
       without any commit here. Only a digest names fixed bytes. */
    if (action.startsWith("docker://")) {
      if (!/@sha256:[a-f0-9]{64}$/.test(action)) {
        failures.push(`Container action is not pinned to a digest in ${workflow}: ${action}`);
      }
      continue;
    }
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
