/* Repository guard: workflow policy, tracked-file policy, and the config
   contract that pins what CI actually runs. */

import assert from "node:assert/strict";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  JOB,
  SITE_PACKAGE,
  STEP,
  assertWorkflowAccepted,
  assertWorkflowRejected,
  readConfig,
  repositoryRoot,
  run,
  withFixture,
  write,
  writeConfig
} from "./helpers.mjs";

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
    "tests/helpers.mjs",
    "tests/payload-budget.test.mjs",
    "tests/repository-guard.test.mjs"
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

test("a tracked npm-shrinkwrap.json is refused", () => {
  /* npm prefers a shrinkwrap over package-lock.json, so it silently decides
     what `npm ci` installs. */
  for (const path of ["npm-shrinkwrap.json", "site/npm-shrinkwrap.json"]) {
    withFixture((root) => {
      write(root, path, '{"name":"x","lockfileVersion":3}\n');
      spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
      const result = run(root, "check-repository.mjs");
      assert.equal(result.status, 1, `accepted ${path}`);
      assert.match(result.stderr, /npm-shrinkwrap\.json overrides the lockfile/);
    });
  }
});

test("a tracked .npmrc is refused whatever it contains", () => {
  /* npm config can replace the shell that runs `npm run preflight`, and its
     ini parser accepts quoted keys and comment-truncated keys. Reading the
     file meant re-deriving that parser, so the file itself is refused. */
  for (const contents of [
    "script-shell=./evil.sh\n",
    '"script-shell"=./evil.sh\n',
    "script-shell ; harmless = ./evil.sh\n",
    "registry=https://registry.npmjs.org/\n",
    ""
  ]) {
    withFixture((root) => {
      write(root, ".npmrc", contents);
      spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
      const result = run(root, "check-repository.mjs");
      assert.equal(result.status, 1, `accepted .npmrc: ${JSON.stringify(contents)}`);
      assert.match(result.stderr, /Tracked \.npmrc can redirect the package scripts/);
    });
  }
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
