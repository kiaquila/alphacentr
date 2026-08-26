/* Configuration contract for the repository guard, the project checks, and the
   payload budget. Adapted from the kiaquila/web-design template at
   ea8501fdb90236fcb891e97b15f7a42a62f76ff1, with the template's aggregate
   `dist`-wide budget replaced by per-page and shared-asset budgets: this site
   ships 828 static pages, so a total over all HTML and images says nothing
   about what a visitor actually downloads. */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const extension = /^\.[a-z0-9]+$/;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function resolveWithin(root, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return target;
}

function collect(callback) {
  try {
    callback();
  } catch (error) {
    return [error.message];
  }
  return [];
}

/* The product check for this repository is the site build and its route tests.
   Requiring that exact argv is what makes a placeholder impossible to
   substitute — `["true"]` and friends satisfy any shape rule, and classifying
   whether an arbitrary command is "real" is the shell-parsing problem the
   2251-line guard lost. Gated on the site package existing so the harness
   fixtures, which ship no site, can use their own smoke command. */
const SITE_CHECK = ["npm", "--prefix", "site", "run", "check"];

/* Requiring the invocation is not enough on its own: `run check` resolves to a
   package script, and that script could be narrowed to skip the route tests
   while the argv stayed identical. So the scripts it resolves to are pinned
   too. Changing how the site is built or tested is fine — update these values
   in the same pull request, the way a payload budget is re-measured. */
/* CI runs `npm run preflight`, which is itself a chain of root aliases. Pinning
   only the site scripts would leave that chain free to drop a step, so the
   scripts CI actually invokes are pinned here as well. */
const ROOT_SCRIPTS = {
  "check:repository": "node scripts/check-repository.mjs",
  "check:project": "node scripts/run-project-checks.mjs",
  "check:budget": "node scripts/check-performance-budget.mjs",
  "test:harness": "node --test tests/*.test.mjs",
  preflight: "npm run check:repository && npm run test:harness && npm run check:project && npm run check:budget"
};

const SITE_SCRIPTS = {
  build: "node scripts/build.mjs",
  test: 'node --test "tests/*.test.mjs"',
  check: "npm run build && npm test"
};

function scriptErrors(root, relativePath, expected) {
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(join(root, relativePath), "utf8")).scripts ?? {};
  } catch (error) {
    return [`Cannot read ${relativePath}: ${error.message}`];
  }
  return Object.entries(expected)
    .filter(([name, body]) => scripts[name] !== body)
    .map(([name, body]) => `${relativePath} script "${name}" must be: ${body}`);
}

function validateProjectChecks(config, root) {
  const errors = [];
  if (!Array.isArray(config.projectChecks) || config.projectChecks.length === 0) {
    return ["projectChecks must contain at least one real build or test command"];
  }
  if (existsSync(join(root, "site/package.json"))) {
    /* The cwd matters as much as the argv: `--prefix site` is relative, so a
       check running from `alternate/` would resolve to `alternate/site` and
       leave the real site untested while the command looked identical. */
    const runsSiteCheck = config.projectChecks.some((check) => Array.isArray(check?.command) &&
      check.command.length === SITE_CHECK.length &&
      check.command.every((part, index) => part === SITE_CHECK[index]) &&
      resolve(root, check.cwd ?? ".") === resolve(root));
    if (!runsSiteCheck) {
      errors.push(`projectChecks must run the site check from the repository root: ${SITE_CHECK.join(" ")}`);
    }
    errors.push(...scriptErrors(root, "site/package.json", SITE_SCRIPTS));
  }
  for (const [index, check] of config.projectChecks.entries()) {
    if (!isObject(check) || typeof check.name !== "string" || !check.name.trim()) {
      errors.push(`projectChecks[${index}] must have a name`);
    }
    if (!Array.isArray(check?.command) || check.command.length === 0 ||
        check.command.some((part) => typeof part !== "string" || !part)) {
      errors.push(`projectChecks[${index}].command must be a non-empty string array`);
    }
    errors.push(...collect(() => {
      resolveWithin(root, check?.cwd ?? ".", `projectChecks[${index}].cwd`);
    }));
  }
  return errors;
}

/* A page family is one group of routes produced by site/src/routes.mjs, named
   by a pattern over the built path. The budget covers the critical HTML
   document — the bytes a browser must have before it can render anything.

   Families rather than named sample pages: a fixed sample only proves that
   that one page is small, and any of the other 817 could grow past it
   unnoticed. The checker measures every page in a family and holds its maximum
   to the budget, so the representative is derived from the build rather than
   trusted from the config. */
function validatePageFamilies(families, output) {
  const errors = [];
  if (!Array.isArray(families) || families.length === 0) {
    return ["performance.pageFamilies must describe every family of built pages"];
  }
  for (const [index, family] of families.entries()) {
    const label = `performance.pageFamilies[${index}]`;
    if (!isObject(family) || typeof family.name !== "string" || !family.name.trim()) {
      errors.push(`${label} must have a name`);
      continue;
    }
    if (typeof family.pattern !== "string" || !family.pattern) {
      errors.push(`${label}.pattern must be a regular expression over the built path`);
    } else {
      errors.push(...collect(() => new RegExp(family.pattern)));
    }
    if (family.representative !== undefined) {
      errors.push(...collect(() => resolveWithin(output, family.representative, `${label}.representative`)));
    }
    /* A family may legitimately reference no media of its own beyond the
       shared assets, so its measured media baseline can be zero; the budget
       still has to be a real number so a later image is bounded. */
    for (const [limit, measured, allowZero] of [
      ["gzipBytes", "measuredGzipBytes", false],
      ["mediaRawBytes", "measuredMediaRawBytes", true]
    ]) {
      if (!positiveInteger(family[limit])) errors.push(`${label}.${limit} must be positive`);
      const recorded = allowZero
        ? Number.isInteger(family[measured]) && family[measured] >= 0
        : positiveInteger(family[measured]);
      if (!recorded) {
        errors.push(`${label}.${measured} must record the measured baseline`);
      } else if (positiveInteger(family[limit]) && family[limit] < family[measured]) {
        errors.push(`${label}.${limit} is below its own recorded measurement`);
      }
    }
  }
  return errors;
}

/* Shared assets are fetched once per visit and reused across all 828 routes,
   so they are budgeted separately from the per-page HTML. */
function validateSharedAssets(assets, output) {
  const errors = [];
  if (!Array.isArray(assets) || assets.length === 0) {
    return ["performance.sharedAssets must list the assets every page loads"];
  }
  for (const [index, asset] of assets.entries()) {
    const label = `performance.sharedAssets[${index}]`;
    if (!isObject(asset) || typeof asset.name !== "string" || !asset.name.trim()) {
      errors.push(`${label} must have a name`);
      continue;
    }
    if (!Array.isArray(asset.files) || asset.files.length === 0) {
      errors.push(`${label}.files must list at least one file`);
    } else {
      for (const [fileIndex, file] of asset.files.entries()) {
        errors.push(...collect(() => resolveWithin(output, file, `${label}.files[${fileIndex}]`)));
      }
    }
    for (const [limit, measured] of [["gzipBytes", "measuredGzipBytes"], ["rawBytes", "measuredRawBytes"]]) {
      if (asset[limit] === undefined && asset[measured] === undefined) continue;
      if (!positiveInteger(asset[limit])) errors.push(`${label}.${limit} must be positive`);
      if (!positiveInteger(asset[measured])) {
        errors.push(`${label}.${measured} must record the measured baseline`);
      } else if (positiveInteger(asset[limit]) && asset[limit] < asset[measured]) {
        errors.push(`${label}.${limit} is below its own recorded measurement`);
      }
    }
    if (asset.gzipBytes === undefined && asset.rawBytes === undefined) {
      errors.push(`${label} needs a gzipBytes or rawBytes limit`);
    }
  }
  return errors;
}

/* Per-file ceilings keep one oversized cover image from bloating a single
   page, which an aggregate total would hide among 363 other images. */
function validatePerFileLimits(limits) {
  const errors = [];
  if (!Array.isArray(limits) || limits.length === 0) {
    return ["performance.perFileLimits must bound the largest single file of each media type"];
  }
  for (const [index, limit] of limits.entries()) {
    const label = `performance.perFileLimits[${index}]`;
    if (!isObject(limit) || typeof limit.name !== "string" || !limit.name.trim()) {
      errors.push(`${label} must have a name`);
      continue;
    }
    if (!extension.test(limit.extension ?? "")) {
      errors.push(`${label}.extension must be a lower-case file extension`);
    }
    if (!positiveInteger(limit.maxRawBytes)) errors.push(`${label}.maxRawBytes must be positive`);
    if (!positiveInteger(limit.measuredMaxRawBytes)) {
      errors.push(`${label}.measuredMaxRawBytes must record the measured baseline`);
    } else if (positiveInteger(limit.maxRawBytes) && limit.maxRawBytes < limit.measuredMaxRawBytes) {
      errors.push(`${label}.maxRawBytes is below its own recorded measurement`);
    }
  }
  return errors;
}

export function validateConfig(config, root) {
  if (!isObject(config) || config.schemaVersion !== 1) {
    return ["web-design.config.json must use schemaVersion 1"];
  }
  const errors = [];
  if (!kebabCase.test(config.projectSlug ?? "") || config.projectSlug === "replace-me") {
    errors.push("projectSlug must be replaced with the project's lower-case kebab-case slug");
  }
  errors.push(...validateProjectChecks(config, root));
  errors.push(...scriptErrors(root, "package.json", ROOT_SCRIPTS));

  const performance = config.performance;
  if (!isObject(performance)) return [...errors, "performance configuration is required"];

  let output = root;
  errors.push(...collect(() => {
    output = resolveWithin(root, performance.outputDirectory, "performance.outputDirectory");
  }));
  if (!Array.isArray(performance.allowedExtensions) || performance.allowedExtensions.length === 0 ||
      performance.allowedExtensions.some((value) => !extension.test(value))) {
    errors.push("performance.allowedExtensions must contain lower-case file extensions");
  }
  errors.push(...validatePageFamilies(performance.pageFamilies, output));
  errors.push(...validateSharedAssets(performance.sharedAssets, output));
  errors.push(...validatePerFileLimits(performance.perFileLimits));
  return errors;
}

export function loadConfig(root) {
  const path = join(root, "web-design.config.json");
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read web-design.config.json: ${error.message}`);
  }
  const errors = validateConfig(config, root);
  if (errors.length) throw new Error(errors.join("\n"));
  return config;
}
