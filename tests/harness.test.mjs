/* Regression tests for the repository guard, the project-check runner, and the
   payload budget. Each test builds a throwaway repository from this one's
   harness files plus a tiny fake build output, so the tests never depend on the
   real 828-page build and stay fast. */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

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
    representativePages: [
      { name: "home", file: "index.html", measuredGzipBytes: 60, gzipBytes: 4096 }
    ],
    sharedAssets: [
      { name: "stylesheet", files: ["assets/styles.css"], measuredGzipBytes: 40, gzipBytes: 2048 },
      { name: "client script", files: ["assets/nav.js"], measuredRawBytes: 40, rawBytes: 2048 }
    ],
    perFileLimits: [
      { name: "cover image", extension: ".webp", measuredMaxRawBytes: 1024, maxRawBytes: 8192 }
    ]
  }
};

function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

function run(root, script) {
  return spawnSync(process.execPath, [join(root, "scripts", script), "--root", root], {
    cwd: root,
    encoding: "utf8"
  });
}

function readConfig(root) {
  return JSON.parse(readFileSync(join(root, "web-design.config.json"), "utf8"));
}

function writeConfig(root, config) {
  writeFileSync(join(root, "web-design.config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function makeFixture() {
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
  write(root, "site/dist/assets/styles.css", ":root { color: #1b2a24; }\n");
  write(root, "site/dist/assets/nav.js", "document.documentElement.dataset.ready = 'true';\n");
  write(root, "site/dist/assets/media/cover.webp", randomBytes(512));
  return root;
}

function withFixture(callback) {
  const root = makeFixture();
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the harness passes on a well-formed repository", () => {
  withFixture((root) => {
    for (const script of ["check-repository.mjs", "run-project-checks.mjs", "check-performance-budget.mjs"]) {
      const result = run(root, script);
      assert.equal(result.status, 0, `${script}\n${result.stdout}\n${result.stderr}`);
    }
  });
});

test("this repository's own guard, config and budget hold", () => {
  for (const script of ["check-repository.mjs"]) {
    const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts", script)], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, `${script}\n${result.stdout}\n${result.stderr}`);
  }
});

test("the guard is small enough to review", () => {
  /* AGENTS.md caps a code file at 600 lines. The guard this replaced was
     2251 lines, and every review finding against it was a parsing gap. */
  for (const script of ["check-repository.mjs", "check-performance-budget.mjs", "config.mjs"]) {
    const lines = readFileSync(join(repositoryRoot, "scripts", script), "utf8").split("\n").length;
    assert.ok(lines <= 600, `scripts/${script} is ${lines} lines, over the 600-line cap`);
  }
  const testLines = readFileSync(join(repositoryRoot, "tests/harness.test.mjs"), "utf8").split("\n").length;
  assert.ok(testLines <= 600, `tests/harness.test.mjs is ${testLines} lines, over the 600-line cap`);
});

test("project commands run directly and failures propagate", () => {
  withFixture((root) => {
    const config = readConfig(root);
    config.projectChecks = [{ name: "failing test", command: ["node", "-e", "process.exit(7)"] }];
    writeConfig(root, config);
    assert.equal(run(root, "run-project-checks.mjs").status, 7);
  });
});

test("critical HTML over its per-page budget fails", () => {
  withFixture((root) => {
    write(root, "site/dist/index.html", randomBytes(8 * 1024).toString("hex"));
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Critical HTML of home: \d+ B exceeds 4096 B/);
  });
});

test("shared assets are budgeted separately from the pages", () => {
  withFixture((root) => {
    write(root, "site/dist/assets/styles.css", randomBytes(4 * 1024).toString("hex"));
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Shared stylesheet \(gzip\): \d+ B exceeds 2048 B/);
  });
});

test("one oversized image fails even though no aggregate total is enforced", () => {
  withFixture((root) => {
    write(root, "site/dist/assets/media/cover.webp", randomBytes(16 * 1024));
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Largest cover image .*: \d+ B exceeds 8192 B/);
  });
});

test("many pages within budget do not fail on their total", () => {
  /* The point of dropping the template's aggregate budget: 828 pages that are
     each small must pass, even though their sum is large. */
  withFixture((root) => {
    for (let index = 0; index < 400; index += 1) {
      write(root, `site/dist/page-${index}/index.html`, `<!doctype html><title>Page ${index}</title>\n`);
    }
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("unexpected deployable file types fail", () => {
  withFixture((root) => {
    write(root, "site/dist/video.mp4", "not really a video\n");
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unexpected deployable file type \.mp4/);
  });
});

test("a budget below its own recorded measurement is rejected", () => {
  withFixture((root) => {
    const config = readConfig(root);
    config.performance.representativePages[0].measuredGzipBytes = 9000;
    writeConfig(root, config);
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gzipBytes is below its own recorded measurement/);
  });
});

test("repository policy rejects unpinned actions", () => {
  withFixture((root) => {
    const path = join(root, ".github/workflows/ci.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace(/actions\/checkout@[a-f0-9]{40}/, "actions/checkout@v4"));
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not pinned to a full SHA/);
  });
});

test("repository policy rejects a write-capable workflow", () => {
  withFixture((root) => {
    const path = join(root, ".github/workflows/ci.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace("  contents: read", "  contents: write"));
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /may not grant write permissions/);
  });
});

test("repository policy rejects job-level permission overrides", () => {
  /* A job-level `permissions:` overrides the top-level grant, so checking only
     the column-zero declaration would let a job become write-capable while the
     file still reads `permissions: contents: read` at the top. */
  for (const override of [
    "    permissions: write-all",
    '    permissions: "write-all"',
    "    permissions: {contents: write}",
    "    permissions:\n      contents: write",
    '    permissions:\n      contents: "write"',
    "    permissions:\n      contents: 'write'",
    "    permissions:\n      contents: read\n      id-token: write",
    "    permissions:\n      contents: write # needed for the release",
    /* Quoted keys parse as the normal key, so they must be read too. */
    "    'permissions': write-all",
    '    "permissions": write-all',
    "    permissions:\n      'contents': write",
    "    permissions:\n      \"contents\": 'write'",
    "    permissions: {contents: read, id-token: write}",
    /* Fail closed: a shape the guard cannot read is rejected, not assumed safe. */
    "    permissions: {contents: write",
    "    permissions: something-unexpected"
  ]) {
    withFixture((root) => {
      const path = join(root, ".github/workflows/ci.yml");
      const workflow = readFileSync(path, "utf8")
        .replace("    runs-on: ubuntu-latest", `${override}\n    runs-on: ubuntu-latest`);
      writeFileSync(path, workflow);
      const result = run(root, "check-repository.mjs");
      assert.equal(result.status, 1, `accepted job override: ${override}`);
      assert.match(result.stderr, /may not grant write permissions/);
    });
  }
});

test("read-only permission declarations still pass", () => {
  for (const override of [
    "    permissions:\n      contents: read",
    '    permissions:\n      contents: "read"',
    "    permissions:\n      'contents': 'read'",
    "    permissions:\n      contents: read # only reads the checkout",
    "    permissions:\n      contents: read\n      id-token: none",
    "    permissions: read-all",
    '    "permissions": read-all',
    "    permissions: {}",
    "    permissions: {contents: read, id-token: none}"
  ]) {
    withFixture((root) => {
      const path = join(root, ".github/workflows/ci.yml");
      const workflow = readFileSync(path, "utf8")
        .replace("    runs-on: ubuntu-latest", `${override}\n    runs-on: ubuntu-latest`);
      writeFileSync(path, workflow);
      const result = run(root, "check-repository.mjs");
      assert.equal(result.status, 0, `rejected read-only override: ${override}\n${result.stderr}`);
    });
  }
});

test("repository policy rejects YAML the guard does not decode", () => {
  /* The guard reads raw text, so key syntax whose text and decoded value can
     differ is refused rather than read approximately. `\\u006e` decodes to `n`,
     which would otherwise spell `permissions` past a text-only match. */
  for (const [override, expected] of [
    ['    "permissio\\u006es": write-all', /escaped double-quoted scalar/],
    ["    ? permissions\\n    : write-all", /explicit key/],
    ["    <<: *defaults", /merge key|anchor or alias/],
    ["    permissions: &perms write-all", /anchor or alias/],
    /* The same escape decoding hides a secrets expression in a value. */
    ['    env:\\n      TOKEN: "${{ \\x73ecrets.DEPLOY_TOKEN }}"', /escaped double-quoted scalar/]
  ]) {
    withFixture((root) => {
      const path = join(root, ".github/workflows/ci.yml");
      const workflow = readFileSync(path, "utf8")
        .replace("    runs-on: ubuntu-latest", `${override.replaceAll("\\n", "\n")}\n    runs-on: ubuntu-latest`);
      writeFileSync(path, workflow);
      const result = run(root, "check-repository.mjs");
      assert.equal(result.status, 1, `accepted undecodable YAML: ${override}`);
      assert.match(result.stderr, expected);
    });
  }
});

test("repository policy rejects secrets and unsafe triggers", () => {
  withFixture((root) => {
    const path = join(root, ".github/workflows/ci.yml");
    const workflow = readFileSync(path, "utf8")
      .replace("on:\n  pull_request:", "on:\n  pull_request_target:")
      .replace("      - name: Setup Node", "      - run: echo ${{ secrets.DEPLOY_TOKEN }}\n      - name: Setup Node");
    writeFileSync(path, workflow);
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pull_request_target/);
    assert.match(result.stderr, /may not consume repository secrets/);
  });
});

test("repository policy rejects every secrets access form", () => {
  for (const step of [
    "      - run: echo ${{ secrets.DEPLOY_TOKEN }}",
    "      - run: echo ${{ secrets['DEPLOY_TOKEN'] }}",
    '      - run: echo ${{ secrets["DEPLOY_TOKEN"] }}',
    "      - uses: ./local\n        secrets: inherit",
    /* Bare context use names no key at all. */
    "      - run: echo '${{ toJSON(secrets) }}'"
  ]) {
    withFixture((root) => {
      const path = join(root, ".github/workflows/ci.yml");
      const workflow = readFileSync(path, "utf8")
        .replace("      - name: Setup Node", `${step}\n      - name: Setup Node`);
      writeFileSync(path, workflow);
      const result = run(root, "check-repository.mjs");
      assert.equal(result.status, 1, `accepted secret access: ${step}`);
      assert.match(result.stderr, /may not consume repository secrets/);
    });
  }
});

test("the automatic GITHUB_TOKEN stays usable", () => {
  withFixture((root) => {
    const path = join(root, ".github/workflows/ci.yml");
    const workflow = readFileSync(path, "utf8")
      .replace("      - name: Setup Node", "      - run: gh repo view\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n      - name: Setup Node");
    writeFileSync(path, workflow);
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("container actions must be pinned by digest", () => {
  const digest = `@sha256:${"a".repeat(64)}`;
  for (const [action, status] of [
    ["docker://alpine:latest", 1],
    ["docker://alpine", 1],
    [`docker://alpine${digest}`, 0]
  ]) {
    withFixture((root) => {
      const path = join(root, ".github/workflows/ci.yml");
      const workflow = readFileSync(path, "utf8")
        .replace("      - name: Setup Node", `      - uses: ${action}\n      - name: Setup Node`);
      writeFileSync(path, workflow);
      const result = run(root, "check-repository.mjs");
      assert.equal(result.status, status, `${action}\n${result.stderr}`);
      if (status === 1) assert.match(result.stderr, /Container action is not pinned to a digest/);
    });
  }
});

test("a quoted uses key is still pin-checked", () => {
  withFixture((root) => {
    const path = join(root, ".github/workflows/ci.yml");
    const workflow = readFileSync(path, "utf8")
      .replace("      - name: Setup Node", '      - "uses": actions/setup-node@main\n      - name: Setup Node');
    writeFileSync(path, workflow);
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not pinned to a full SHA/);
  });
});

test("manual dispatch is rejected", () => {
  /* A dispatched run loads the selected branch's copy of the workflow, so the
     guard in that copy cannot be trusted to have run at all. */
  withFixture((root) => {
    const path = join(root, ".github/workflows/ci.yml");
    const workflow = readFileSync(path, "utf8")
      .replace("  schedule:", "  workflow_dispatch:\n  schedule:");
    writeFileSync(path, workflow);
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Manual dispatch lets a branch supply its own workflow/);
  });
});

test("a dangling symlink is still rejected", () => {
  /* existsSync is false for a link whose target is missing, so checking
     existence before lstat would skip the entry and miss the link. */
  withFixture((root) => {
    symlinkSync("does-not-exist.txt", join(root, "dangling.txt"));
    spawnSync("git", ["add", "-Af"], { cwd: root, encoding: "utf8" });
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Symbolic links are not allowed: dangling\.txt/);
  });
});

test("tracked build output and secrets are rejected", () => {
  withFixture((root) => {
    write(root, "dist/index.html", "<!doctype html>\n");
    /* Split so this file does not itself trip the guard it is testing. */
    write(root, "leaked.txt", `${["AKIA", "IOSFODNN7EXAMPLE"].join("")}\n`);
    spawnSync("git", ["add", "-Af"], { cwd: root, encoding: "utf8" });
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Generated or dependency directory is tracked: dist\/index\.html/);
    assert.match(result.stderr, /Possible AWS access key in leaked\.txt/);
  });
});

test("configuration paths cannot escape the repository", () => {
  withFixture((root) => {
    const config = readConfig(root);
    config.performance.outputDirectory = "../outside";
    writeConfig(root, config);
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must stay inside the repository/);
  });
});

test("a placeholder project check is rejected", () => {
  withFixture((root) => {
    const config = readConfig(root);
    config.projectChecks = [];
    writeConfig(root, config);
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /projectChecks must contain at least one real/);
  });
});
