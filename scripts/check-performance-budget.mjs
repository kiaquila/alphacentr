#!/usr/bin/env node
/* Payload budget for a large static catalogue.

   The upstream template budgets the whole deployable directory: total raw
   bytes, total gzip bytes, and a per-extension total. That is meaningful for a
   handful of pages and meaningless here — this site builds 828 routes and
   ~7.5 MB of cover images, so any total large enough to pass would be far too
   loose to catch a regression, and no visitor ever downloads it.

   What a visitor downloads is one HTML document plus the shared stylesheet,
   the one client script, the fonts, and a few images. So this check measures:

     - the gzip size of the critical HTML of each representative page, one per
       route family produced by site/src/routes.mjs;
     - the shared assets every page loads, budgeted separately;
     - a ceiling on any single image or vector, which an aggregate would hide.

   Budgets are recorded next to the measurement they came from, and the config
   contract rejects a budget set below its own recorded measurement. */

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { loadConfig, resolveWithin } from "./config.mjs";

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Deployable output contains a symlink: ${path}`);
    if (stat.isDirectory()) files.push(...filesUnder(path));
    else if (stat.isFile()) files.push(path);
  }
  return files.sort();
}

function gzipBytes(buffer) {
  return gzipSync(buffer, { level: 9 }).length;
}

function overBudget(label, measured, limit) {
  return measured > limit ? [`${label}: ${measured} B exceeds ${limit} B`] : [];
}

function checkRepresentativePages(pages, output, report) {
  const failures = [];
  for (const page of pages) {
    const path = resolveWithin(output, page.file, `representative page ${page.name}`);
    const measured = gzipBytes(readFileSync(path));
    report.push(`  ${page.name}: ${measured} B gzip / ${page.gzipBytes} B budget`);
    failures.push(...overBudget(`Critical HTML of ${page.name}`, measured, page.gzipBytes));
  }
  return failures;
}

function checkSharedAssets(assets, output, report) {
  const failures = [];
  for (const asset of assets) {
    const buffers = asset.files.map(
      (file) => readFileSync(resolveWithin(output, file, `shared asset ${asset.name}`))
    );
    /* Each asset is a separate response, so gzip them separately and add up. */
    const measured = {
      rawBytes: buffers.reduce((total, buffer) => total + buffer.length, 0),
      gzipBytes: buffers.reduce((total, buffer) => total + gzipBytes(buffer), 0)
    };
    for (const unit of ["gzipBytes", "rawBytes"]) {
      if (asset[unit] === undefined) continue;
      const kind = unit === "gzipBytes" ? "gzip" : "raw";
      report.push(`  ${asset.name}: ${measured[unit]} B ${kind} / ${asset[unit]} B budget`);
      failures.push(...overBudget(`Shared ${asset.name} (${kind})`, measured[unit], asset[unit]));
    }
  }
  return failures;
}

function checkPerFileLimits(limits, files, output, report) {
  const failures = [];
  for (const limit of limits) {
    let largest = { path: null, size: 0 };
    for (const file of files) {
      if (extname(file).toLowerCase() !== limit.extension) continue;
      const size = lstatSync(file).size;
      if (size > largest.size) largest = { path: file, size };
    }
    if (!largest.path) continue;
    report.push(`  largest ${limit.name}: ${largest.size} B raw / ${limit.maxRawBytes} B budget`);
    failures.push(...overBudget(
      `Largest ${limit.name} (${relative(output, largest.path)})`,
      largest.size,
      limit.maxRawBytes
    ));
  }
  return failures;
}

export function checkPerformance(root) {
  const { performance } = loadConfig(root);
  const output = resolveWithin(root, performance.outputDirectory, "performance.outputDirectory");
  const files = filesUnder(output);
  if (files.length === 0) throw new Error(`No deployable files found in ${performance.outputDirectory}`);

  const failures = [];
  const report = [];

  const allowed = new Set(performance.allowedExtensions);
  for (const file of files) {
    const found = extname(file).toLowerCase();
    if (!allowed.has(found)) {
      failures.push(`Unexpected deployable file type ${found || "(none)"}: ${relative(output, file)}`);
    }
  }

  report.push(`Critical HTML per representative page (${performance.representativePages.length} of ${files.filter((file) => file.endsWith(".html")).length} pages):`);
  failures.push(...checkRepresentativePages(performance.representativePages, output, report));
  report.push("Shared assets loaded by every page:");
  failures.push(...checkSharedAssets(performance.sharedAssets, output, report));
  report.push("Per-file ceilings:");
  failures.push(...checkPerFileLimits(performance.perFileLimits, files, output, report));

  return { failures, files, report };
}

const rootIndex = process.argv.indexOf("--root");
const root = resolve(
  rootIndex === -1 ? import.meta.dirname : process.argv[rootIndex + 1],
  rootIndex === -1 ? ".." : "."
);

try {
  const result = checkPerformance(root);
  console.log(result.report.join("\n"));
  if (result.failures.length) {
    console.error(result.failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log(`Payload budget passed (${result.files.length} deployable files).`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
