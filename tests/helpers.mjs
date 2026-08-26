/* Shared fixtures for the harness tests. Each test builds a throwaway repository from this one's
   harness files plus a tiny fake build output, so the tests never depend on the
   real 828-page build and stay fast. */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const repositoryRoot = resolve(import.meta.dirname, "..");

const HARNESS_FILES = [
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

/* The fixture's fake output only has to satisfy the paths the config names, so
   the budget config is rewritten to point at one page and one shared asset. */
const FIXTURE_CONFIG = {
  schemaVersion: 1,
  projectSlug: "alphacentr",
  projectChecks: [{ name: "fixture smoke", command: ["node", "-e", "process.exit(0)"] }],
  performance: {
    outputDirectory: "site/dist",
    allowedExtensions: [".css", ".html", ".js", ".webp"],
    pageFamilies: [
      {
        name: "home",
        pattern: "^index\\.html$",
        measuredGzipBytes: 60,
        gzipBytes: 4096,
        measuredMediaRawBytes: 0,
        mediaRawBytes: 4096
      },
      {
        name: "other pages",
        pattern: "^.+/index\\.html$",
        measuredGzipBytes: 60,
        gzipBytes: 4096,
        measuredMediaRawBytes: 0,
        mediaRawBytes: 4096
      }
    ],
    sharedAssets: [
      { name: "stylesheet", files: ["assets/styles.css"], measuredGzipBytes: 40, gzipBytes: 2048 },
      { name: "client script", files: ["assets/nav.js"], measuredRawBytes: 40, rawBytes: 2048 }
    ],
    perFileLimits: [
      { name: "cover image", extension: ".webp", measuredMaxRawBytes: 1024, maxRawBytes: 8192 }
    ],
    unreferencedMedia: ["assets/media/cover.webp"]
  }
};

export function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

/* Run this repository's script against the fixture through --root, rather than
   the copy inside it, so `yaml` resolves from the repository's node_modules.
   The script under test is the same either way; only resolution differs. */
export function run(root, script) {
  return spawnSync(process.execPath, [join(repositoryRoot, "scripts", script), "--root", root], {
    cwd: root,
    encoding: "utf8"
  });
}

export function readConfig(root) {
  return JSON.parse(readFileSync(join(root, "web-design.config.json"), "utf8"));
}

export function writeConfig(root, config) {
  writeFileSync(join(root, "web-design.config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

export function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "alphacentr-harness-"));
  for (const file of HARNESS_FILES) {
    const target = join(root, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    cpSync(join(repositoryRoot, file), target);
  }
  writeConfig(root, FIXTURE_CONFIG);

  const git = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const add = spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);

  write(root, "site/dist/index.html", "<!doctype html><title>Alpha Lumen</title>\n");
  /* A second page so both fixture families match something, the way every
     family in the real config covers at least one built route. */
  write(root, "site/dist/other/index.html", "<!doctype html><title>Other</title>\n");
  write(root, "site/dist/assets/styles.css", ":root { color: #1b2a24; }\n");
  write(root, "site/dist/assets/nav.js", "document.documentElement.dataset.ready = 'true';\n");
  write(root, "site/dist/assets/media/cover.webp", randomBytes(512));
  return root;
}

export function withFixture(callback) {
  const root = makeFixture();
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* Most workflow tests differ only in what they splice into ci.yml, so they
   share one helper: patch the workflow, run the guard, assert the outcome. */
export function withWorkflow(root, replacements) {
  const path = join(root, ".github/workflows/ci.yml");
  let workflow = readFileSync(path, "utf8");
  for (const [from, to] of replacements) {
    assert.ok(workflow.includes(from), `fixture workflow has no anchor: ${from}`);
    workflow = workflow.replace(from, to);
  }
  writeFileSync(path, workflow);
  return run(root, "check-repository.mjs");
}

export function assertWorkflowRejected(replacements, expected, label) {
  withFixture((root) => {
    const result = withWorkflow(root, replacements);
    assert.equal(result.status, 1, `accepted: ${label}\n${result.stdout}`);
    assert.match(result.stderr, expected);
  });
}

export function assertWorkflowAccepted(replacements, label) {
  withFixture((root) => {
    const result = withWorkflow(root, replacements);
    assert.equal(result.status, 0, `rejected: ${label}\n${result.stderr}`);
  });
}

export const JOB = "    runs-on: ubuntu-latest";
export const STEP = "      - name: Setup Node";


export const SITE_PACKAGE = JSON.stringify({
  name: "site",
  private: true,
  scripts: {
    build: "node scripts/build.mjs",
    test: 'node --test "tests/*.test.mjs"',
    check: "npm run build && npm test"
  }
}, null, 2);

