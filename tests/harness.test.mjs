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
    pageFamilies: [
      { name: "home", pattern: "^index\\.html$", measuredGzipBytes: 60, gzipBytes: 4096 },
      { name: "other pages", pattern: "^.+/index\\.html$", measuredGzipBytes: 60, gzipBytes: 4096 }
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

/* Run this repository's script against the fixture through --root, rather than
   the copy inside it, so `yaml` resolves from the repository's node_modules.
   The script under test is the same either way; only resolution differs. */
function run(root, script) {
  return spawnSync(process.execPath, [join(repositoryRoot, "scripts", script), "--root", root], {
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
  /* A second page so both fixture families match something, the way every
     family in the real config covers at least one built route. */
  write(root, "site/dist/other/index.html", "<!doctype html><title>Other</title>\n");
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

/* Most workflow tests differ only in what they splice into ci.yml, so they
   share one helper: patch the workflow, run the guard, assert the outcome. */
function withWorkflow(root, replacements) {
  const path = join(root, ".github/workflows/ci.yml");
  let workflow = readFileSync(path, "utf8");
  for (const [from, to] of replacements) {
    assert.ok(workflow.includes(from), `fixture workflow has no anchor: ${from}`);
    workflow = workflow.replace(from, to);
  }
  writeFileSync(path, workflow);
  return run(root, "check-repository.mjs");
}

function assertWorkflowRejected(replacements, expected, label) {
  withFixture((root) => {
    const result = withWorkflow(root, replacements);
    assert.equal(result.status, 1, `accepted: ${label}\n${result.stdout}`);
    assert.match(result.stderr, expected);
  });
}

function assertWorkflowAccepted(replacements, label) {
  withFixture((root) => {
    const result = withWorkflow(root, replacements);
    assert.equal(result.status, 0, `rejected: ${label}\n${result.stderr}`);
  });
}

const JOB = "    runs-on: ubuntu-latest";
const STEP = "      - name: Setup Node";

test("the harness passes on a well-formed repository", () => {
  withFixture((root) => {
    for (const script of ["check-repository.mjs", "run-project-checks.mjs", "check-performance-budget.mjs"]) {
      const result = run(root, script);
      assert.equal(result.status, 0, `${script}\n${result.stdout}\n${result.stderr}`);
    }
  });
});

test("this repository's own guard holds", () => {
  const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "check-repository.mjs")], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("the guard is small enough to review", () => {
  /* AGENTS.md caps a code file at 600 lines. The guard this replaced was
     2251 lines, and every review finding against it was a parsing gap. */
  for (const file of [
    "scripts/check-repository.mjs",
    "scripts/check-performance-budget.mjs",
    "scripts/config.mjs",
    "tests/harness.test.mjs"
  ]) {
    const lines = readFileSync(join(repositoryRoot, file), "utf8").split("\n").length;
    assert.ok(lines <= 600, `${file} is ${lines} lines, over the 600-line cap`);
  }
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
    assert.match(result.stderr, /Heaviest home \(index\.html\): \d+ B exceeds 4096 B/);
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
    assert.equal(run(root, "check-performance-budget.mjs").status, 0);
  });
});

test("a page that is not the configured representative is still budgeted", () => {
  /* The reason families replaced named sample pages: any of the other 817
     pages growing past the sample must fail, not pass unmeasured. */
  withFixture((root) => {
    write(root, "site/dist/some-other-page/index.html", randomBytes(8 * 1024).toString("hex"));
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Heaviest other pages \(some-other-page\/index\.html\): \d+ B exceeds/);
  });
});

test("a new page-wide stylesheet must be budgeted", () => {
  /* The extension allow-list would accept it and the HTML budget would see
     only its <link> tag, so an unlisted shared asset is rejected outright. */
  withFixture((root) => {
    write(root, "site/dist/assets/extra.css", ".a{color:red}\n");
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Shared asset is not budgeted: assets\/extra\.css/);
  });
});

test("a page no family covers is reported", () => {
  withFixture((root) => {
    write(root, "site/dist/stray.html", "<!doctype html><title>Stray</title>\n");
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No page family covers stray\.html/);
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
    config.performance.pageFamilies[0].measuredGzipBytes = 9000;
    writeConfig(root, config);
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gzipBytes is below its own recorded measurement/);
  });
});

/* Every spelling below is valid YAML that parses to a write grant. The guard
   reads the parsed document, so quoting, escapes, flow style, anchors and
   comments are the parser's problem rather than a rule each. */
test("a write grant is rejected however it is spelled", () => {
  for (const [label, replacements] of [
    ["top-level", [["permissions:\n  contents: read", "permissions:\n  contents: write"]]],
    ["job-level block", [[JOB, `    permissions:\n      contents: write\n${JOB}`]]],
    ["write-all", [[JOB, `    permissions: write-all\n${JOB}`]]],
    ["quoted value", [[JOB, `    permissions:\n      contents: "write"\n${JOB}`]]],
    ["single-quoted value", [[JOB, `    permissions:\n      'contents': 'write'\n${JOB}`]]],
    ["quoted key", [[JOB, `    'permissions': write-all\n${JOB}`]]],
    ["escaped key", [[JOB, `    "permissio\\u006es": write-all\n${JOB}`]]],
    ["explicit key", [[JOB, `    ? permissions\n    : write-all\n${JOB}`]]],
    ["anchor", [[JOB, `    permissions: &perms write-all\n${JOB}`]]],
    ["write after read", [[JOB, `    permissions:\n      contents: read\n      id-token: write\n${JOB}`]]],
    ["trailing comment", [[JOB, `    permissions:\n      contents: write # needed\n${JOB}`]]],
    ["flow mapping", [[JOB, `    permissions: {contents: write}\n${JOB}`]]],
    ["whole job in flow style", [["jobs:", "jobs:\n  flow-job: {permissions: write-all, runs-on: ubuntu-latest, steps: [{run: echo hi}]}"]]],
    ["flow job on a continuation line", [["jobs:", "jobs:\n  cont-job:\n    {permissions: write-all, runs-on: ubuntu-latest, steps: [{run: echo hi}]}"]]],
    ["comment that looks like a block scalar", [
      ["  project-ci:", "  project-ci: # looks-like-block: |"],
      [JOB, `    permissions: write-all\n${JOB}`]
    ]]
  ]) {
    assertWorkflowRejected(replacements, /may not grant write permissions/, label);
  }
});

test("read-only permission declarations still pass", () => {
  for (const [label, replacements] of [
    ["block read", [[JOB, `    permissions:\n      contents: read\n${JOB}`]]],
    ["quoted read", [[JOB, `    permissions:\n      contents: "read"\n${JOB}`]]],
    ["read and none", [[JOB, `    permissions:\n      contents: read\n      id-token: none\n${JOB}`]]],
    ["read with comment", [[JOB, `    permissions:\n      contents: read # only the checkout\n${JOB}`]]],
    ["read-all", [[JOB, `    permissions: read-all\n${JOB}`]]],
    ["empty mapping grants nothing", [[JOB, `    permissions: {}\n${JOB}`]]]
  ]) {
    assertWorkflowAccepted(replacements, label);
  }
});

test("every secrets access form is rejected", () => {
  for (const [label, replacements] of [
    ["dotted", [[STEP, `      - run: echo \${{ secrets.DEPLOY_TOKEN }}\n${STEP}`]]],
    ["bracketed", [[STEP, `      - run: echo \${{ secrets['DEPLOY_TOKEN'] }}\n${STEP}`]]],
    ["bare context", [[STEP, `      - run: echo '\${{ toJSON(secrets) }}'\n${STEP}`]]],
    ["inherit", [[STEP, `      - uses: ./local\n        secrets: inherit\n${STEP}`]]],
    /* A double-quoted YAML scalar decodes escapes, so the value GitHub
       expands is `secrets.DEPLOY_TOKEN` even though the text is not. */
    ["escaped in a quoted scalar", [[STEP, `      - run: echo $TOKEN\n        env:\n          TOKEN: "\${{ \\x73ecrets.DEPLOY_TOKEN }}"\n${STEP}`]]],
    /* GitHub expands ${{ }} inside a block scalar, so a run body is in scope. */
    ["inside a block scalar", [[STEP, `      - name: Leak\n        run: |\n          echo \${{ secrets.DEPLOY_TOKEN }}\n${STEP}`]]]
  ]) {
    assertWorkflowRejected(replacements, /may not consume repository secrets/, label);
  }
});

test("the automatic GITHUB_TOKEN stays usable", () => {
  assertWorkflowAccepted(
    [[STEP, `      - run: gh repo view\n        env:\n          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n${STEP}`]],
    "secrets.GITHUB_TOKEN"
  );
});

test("actions must be pinned, containers by digest", () => {
  for (const [action, label] of [
    ["actions/setup-node@main", "branch ref"],
    ["docker://alpine:latest", "mutable container tag"],
    ["docker://alpine", "container without a tag"]
  ]) {
    assertWorkflowRejected(
      [[STEP, `      - uses: ${action}\n${STEP}`]],
      /not pinned to a (?:full SHA|digest)/,
      label
    );
  }
  /* A quoted key is the same key once parsed, so it is pin-checked too. */
  assertWorkflowRejected(
    [[STEP, `      - "uses": actions/setup-node@main\n${STEP}`]],
    /not pinned to a full SHA/,
    "quoted uses key"
  );
  assertWorkflowAccepted(
    [[STEP, `      - uses: docker://alpine@sha256:${"a".repeat(64)}\n${STEP}`]],
    "digest-pinned container"
  );
});

test("triggers that let a branch supply the workflow are rejected", () => {
  for (const [trigger, label] of [
    ["  workflow_dispatch:", "manual dispatch"],
    ['  "workflow_dispatch":', "quoted manual dispatch"],
    ["  workflow_run:\n    workflows: [CI]\n    types: [completed]", "workflow_run"],
    ["  pull_request_target:", "pull_request_target"]
  ]) {
    assertWorkflowRejected([["  schedule:", `${trigger}\n  schedule:`]], /lets a branch supply its own workflow/, label);
  }
});

test("a run script may contain shell that looks like YAML", () => {
  /* A block scalar is a string, not structure: braces, brackets, quotes and
     backslashes in a shell script must not be read as YAML. */
  const script = [
    "      - name: Shell that looks structural",
    "        run: |",
    "          [ -f package.json ] && echo present",
    "          {name: not-yaml}",
    '          echo "a\\tb"',
    '          for f in *.{js,mjs}; do echo "$f"; done'
  ].join("\n");
  assertWorkflowAccepted([[STEP, `${script}\n${STEP}`]], "shell in a block scalar");
});

test("an apostrophe in a step name is not a quote delimiter", () => {
  assertWorkflowAccepted(
    [[STEP, `      - name: Alpha's checkout # a note\n        run: echo ok\n${STEP}`]],
    "plain scalar with an apostrophe"
  );
});

test("a workflow that is not valid YAML is rejected", () => {
  assertWorkflowRejected([["permissions:", "permissions: [unclosed"]], /not valid YAML/, "malformed document");
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

test("a no-op project check cannot replace the site check", () => {
  /* `["true"]` satisfies any shape rule, so the site check is required by
     exact argv whenever the repository actually ships a site package. */
  withFixture((root) => {
    write(root, "site/package.json", `${SITE_PACKAGE}\n`);
    const config = readConfig(root);
    config.projectChecks = [{ name: "placeholder", command: ["true"] }];
    writeConfig(root, config);
    spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must run the site check from the repository root/);
  });
});

const SITE_PACKAGE = JSON.stringify({
  name: "site",
  private: true,
  scripts: {
    build: "node scripts/build.mjs",
    test: 'node --test "tests/*.test.mjs"',
    check: "npm run build && npm test"
  }
}, null, 2);

test("the real site check satisfies the requirement", () => {
  withFixture((root) => {
    write(root, "site/package.json", `${SITE_PACKAGE}\n`);
    const config = readConfig(root);
    config.projectChecks = [{ name: "site", command: ["npm", "--prefix", "site", "run", "check"] }];
    writeConfig(root, config);
    spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("the site check must run from the repository root", () => {
  /* `--prefix site` is relative, so a check running from `alternate/` would
     resolve to `alternate/site` and leave the real site untested. */
  withFixture((root) => {
    write(root, "site/package.json", `${SITE_PACKAGE}\n`);
    write(root, "alternate/site/package.json", `${SITE_PACKAGE}\n`);
    const config = readConfig(root);
    config.projectChecks = [{
      name: "site",
      cwd: "alternate",
      command: ["npm", "--prefix", "site", "run", "check"]
    }];
    writeConfig(root, config);
    spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must run the site check from the repository root/);
  });
});

test("narrowing a site script behind the required argv is rejected", () => {
  /* `run check` resolves to a package script, so pinning only the argv would
     let the script drop the route tests while the invocation stayed identical. */
  withFixture((root) => {
    const narrowed = JSON.parse(SITE_PACKAGE);
    narrowed.scripts.check = "npm run build";
    write(root, "site/package.json", `${JSON.stringify(narrowed, null, 2)}\n`);
    const config = readConfig(root);
    config.projectChecks = [{ name: "site", command: ["npm", "--prefix", "site", "run", "check"] }];
    writeConfig(root, config);
    spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
    const result = run(root, "check-repository.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /script "check" must be: npm run build && npm test/);
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
