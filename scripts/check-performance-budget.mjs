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
import { extname, join, relative, resolve, sep } from "node:path";
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

/* Measure every page of every family and hold each family's heaviest page to
   its budget. Checking only a named sample would prove that one page is small
   while any of the other 817 grew past it unnoticed, so the representative is
   derived from the build rather than read from the config. Every page must
   belong to exactly one family, so none is left unbudgeted. */
/* The media a page pulls in beyond the shared assets. A category page
   references 86 covers, so budgeting the HTML alone would leave the bulk of its
   real weight unmeasured while the per-file ceiling saw nothing wrong with any
   single image. Shared assets are excluded because they are budgeted once,
   separately — a visitor fetches them on the first page and reuses them. */
/* Resolve a referenced URL to the path the build actually wrote. A query or
   fragment is part of the request but not of the file name, and a relative URL
   is resolved against the document that carries it, so both are normalised
   away before any size lookup — otherwise the lookup misses and the bytes are
   silently counted as zero. External and data URLs are not our payload. */
function assetPath(raw, baseDirectory) {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const withoutQuery = trimmed.split(/[?#]/)[0];
  if (!withoutQuery) return null;
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    /* A malformed escape is not a path we can resolve; keep the raw text. */
  }
  const combined = decoded.startsWith("/") ? decoded : `${baseDirectory}/${decoded}`;
  const parts = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function referencedMediaBytes(html, sizes, shared, pageDirectory) {
  let total = 0;
  const seen = new Set();
  /* Count anything the build actually wrote, wherever it sits — a page-local
     image resolves beside its page, not under assets/. Documents are excluded:
     a link to another page is navigation, not a fetch. Shared assets are
     excluded because they are budgeted once, separately. */
  const add = (raw) => {
    const asset = assetPath(raw, pageDirectory);
    if (!asset || asset.endsWith(".html") || seen.has(asset) || shared.has(asset)) return;
    if (!sizes.has(asset)) return;
    seen.add(asset);
    total += sizes.get(asset);
  };
  /* One matcher for every fetch-producing attribute. HTML allows exactly three
     attribute-value forms — double-quoted, single-quoted, and unquoted (no
     whitespace, quotes, =, <, > or backtick) — so covering all three is
     complete rather than another guess at a spelling. A srcset lists candidates
     as `url descriptor, url descriptor`; the browser fetches one of them, so
     every candidate counts toward what the page can cost. */
  for (const match of html.matchAll(
    /\b(src|href|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  )) {
    const [, attribute, doubleQuoted, singleQuoted, unquoted] = match;
    const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    const urls = attribute === "srcset"
      ? value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0])
      : [value.trim()];
    for (const url of urls) add(url);
  }
  return total;
}

function checkPageFamilies(families, output, files, shared, report) {
  const failures = [];
  const pages = files
    .filter((file) => file.endsWith(".html"))
    .map((file) => relative(output, file).split(sep).join("/"));
  const sizes = new Map(
    files.map((file) => [relative(output, file).split(sep).join("/"), lstatSync(file).size])
  );
  const claimed = new Map();

  for (const family of families) {
    const pattern = new RegExp(family.pattern);
    let heaviest = { page: null, gzip: 0 };
    let media = { page: null, bytes: 0 };
    let count = 0;
    for (const page of pages) {
      if (!pattern.test(page)) continue;
      count += 1;
      if (claimed.has(page)) {
        failures.push(`${page} matches both "${claimed.get(page)}" and "${family.name}"`);
        continue;
      }
      claimed.set(page, family.name);
      const html = readFileSync(join(output, page));
      const measured = gzipBytes(html);
      if (measured > heaviest.gzip) heaviest = { page, gzip: measured };
      const bytes = referencedMediaBytes(
        html.toString("utf8"),
        sizes,
        shared,
        page.split("/").slice(0, -1).join("/")
      );
      if (bytes > media.bytes) media = { page, bytes };
    }
    if (count === 0) {
      failures.push(`Page family "${family.name}" matches no built page`);
      continue;
    }
    report.push(`  ${family.name} (${count}): ${heaviest.gzip} B gzip HTML / ${family.gzipBytes} B — ${heaviest.page}`);
    report.push(`    heaviest media: ${media.bytes} B raw / ${family.mediaRawBytes} B${media.page ? ` — ${media.page}` : " — none beyond shared"}`);
    failures.push(...overBudget(`Heaviest ${family.name} (${heaviest.page})`, heaviest.gzip, family.gzipBytes));
    failures.push(...overBudget(`Media of ${family.name} (${media.page ?? family.name})`, media.bytes, family.mediaRawBytes));
  }

  for (const page of pages) {
    if (!claimed.has(page)) failures.push(`No page family covers ${page}`);
  }
  return failures;
}

/* Every file whose extension a shared asset uses must itself be budgeted.
   Listing paths alone would let a new page-wide stylesheet or script ship
   unmeasured: the extension allow-list would accept it and the HTML budget
   would see only its `<link>` tag. */
function checkUnbudgetedShared(assets, output, files) {
  const listed = new Set(assets.flatMap((asset) => asset.files));
  const extensions = new Set([...listed].map((file) => extname(file).toLowerCase()));
  return files
    .map((file) => relative(output, file).split(sep).join("/"))
    .filter((file) => extensions.has(extname(file).toLowerCase()) && !listed.has(file))
    .map((file) => `Shared asset is not budgeted: ${file}`);
}

/* A shared stylesheet fetches its own media — `url("…")` backgrounds and
   fonts — on every page, and an HTML-only scan never sees them. Anything a
   shared stylesheet pulls in must therefore be a budgeted shared asset itself. */
function checkStylesheetMedia(assets, output, files) {
  const listed = new Set(assets.flatMap((asset) => asset.files));
  const present = new Set(files.map((file) => relative(output, file).split(sep).join("/")));
  const failures = [];
  for (const stylesheet of [...listed].filter((file) => file.endsWith(".css"))) {
    const directory = stylesheet.split("/").slice(0, -1).join("/");
    const css = readFileSync(join(output, stylesheet), "utf8");
    /* CSS spells a url() value three ways — double-quoted, single-quoted, or
       unquoted (no parentheses, whitespace or quotes) — so a quoted URL may
       legitimately contain `)`. Terminating at the first one truncated it. */
    for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/g)) {
      const [, doubleQuoted, singleQuoted, unquoted] = match;
      const asset = assetPath(doubleQuoted ?? singleQuoted ?? unquoted ?? "", directory);
      if (!asset || !present.has(asset) || listed.has(asset)) continue;
      failures.push(`${stylesheet} references an unbudgeted asset: ${asset}`);
    }
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

  report.push(`Critical HTML, heaviest page of each family (${files.filter((file) => file.endsWith(".html")).length} pages):`);
  const shared = new Set(performance.sharedAssets.flatMap((asset) => asset.files));
  failures.push(...checkPageFamilies(performance.pageFamilies, output, files, shared, report));
  report.push("Shared assets loaded by every page:");
  failures.push(...checkSharedAssets(performance.sharedAssets, output, report));
  failures.push(...checkUnbudgetedShared(performance.sharedAssets, output, files));
  failures.push(...checkStylesheetMedia(performance.sharedAssets, output, files));
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
