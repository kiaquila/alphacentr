/* Configuration contract for the repository guard, the project checks, and the
   payload budget. Adapted from the kiaquila/web-design template at
   ea8501fdb90236fcb891e97b15f7a42a62f76ff1, with the template's aggregate
   `dist`-wide budget replaced by per-page and shared-asset budgets: this site
   ships 828 static pages, so a total over all HTML and images says nothing
   about what a visitor actually downloads. */

import { readFileSync } from "node:fs";
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

function validateProjectChecks(config, root) {
  const errors = [];
  if (!Array.isArray(config.projectChecks) || config.projectChecks.length === 0) {
    return ["projectChecks must contain at least one real build or test command"];
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

/* A representative page stands for one family of routes produced by
   site/src/routes.mjs. Its budget covers the critical HTML document only —
   the bytes the browser must have before it can render anything. */
function validateRepresentativePages(pages, output) {
  const errors = [];
  if (!Array.isArray(pages) || pages.length === 0) {
    return ["performance.representativePages must list the routes that stand for each page family"];
  }
  for (const [index, page] of pages.entries()) {
    const label = `performance.representativePages[${index}]`;
    if (!isObject(page) || typeof page.name !== "string" || !page.name.trim()) {
      errors.push(`${label} must have a name`);
      continue;
    }
    errors.push(...collect(() => resolveWithin(output, page.file, `${label}.file`)));
    if (!positiveInteger(page.gzipBytes)) errors.push(`${label}.gzipBytes must be positive`);
    if (!positiveInteger(page.measuredGzipBytes)) {
      errors.push(`${label}.measuredGzipBytes must record the measured baseline`);
    } else if (positiveInteger(page.gzipBytes) && page.gzipBytes < page.measuredGzipBytes) {
      errors.push(`${label}.gzipBytes is below its own recorded measurement`);
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
  errors.push(...validateRepresentativePages(performance.representativePages, output));
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
