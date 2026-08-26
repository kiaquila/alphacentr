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

/* Where the build writes per-page imagery, as opposed to the handful of assets
   every page loads. */
const MEDIA_DIRECTORY = "assets/media";

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
/* An attribute value is HTML text: the parser resolves character references
   before the URL is used, so `wide&#46;webp` fetches `wide.webp`. */
function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return value.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (match, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[name.toLowerCase()] ?? match;
  });
}

/* CSS escapes a character as `\` plus up to six hex digits and an optional
   trailing space, or as `\` plus the character itself. */
function decodeCssEscapes(value) {
  return value.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|(.))/g, (match, hex, literal) =>
    (hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : literal));
}

/* CSS spells a url() value three ways — double-quoted, single-quoted, or
   unquoted (no parentheses, whitespace or quotes) — and the function name is
   case-insensitive, so a quoted URL may legitimately contain `)`. */
/* Remove CSS comments, which are never fetched, without touching string
   contents: `/*` inside a quoted value is literal text, so a regex sweep can
   swallow a live declaration between two strings. Strings and comments are a
   closed part of the CSS grammar, so scanning for just those two is complete
   even though parsing CSS in general would not be. */
function stripCssComments(css) {
  let out = "";
  let quote = null;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      out += character;
      if (character === "\\") {
        out += css[index + 1] ?? "";
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    /* A backslash escapes the next character anywhere in CSS, not only inside
       a string, so an escaped quote does not open one. */
    if (character === "\\") {
      out += character + (css[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      out += character;
      continue;
    }
    if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 1;
      out += " ";
      continue;
    }
    out += character;
  }
  return out;
}

function* cssUrls(css) {
  for (const match of stripCssComments(css).matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi)) {
    yield match[1] ?? match[2] ?? match[3] ?? "";
  }
}

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

function referencedMediaBytes(html, sizes, shared, pageDirectory, discovered, unresolved) {
  let total = 0;
  const seen = new Set();
  /* Count anything the build actually wrote, wherever it sits — a page-local
     image resolves beside its page, not under assets/. Documents are excluded:
     a link to another page is navigation, not a fetch. Shared assets are
     excluded because they are budgeted once, separately.

     `mustResolve` marks the attributes that name a file the browser fetches.
     One of those failing to resolve means this scanner could not read the
     spelling, and that has to be reported per page: a global reachability
     check would see the same file referenced readably from some other page and
     stay quiet while this page undercounted. */
  const add = (raw, mustResolve) => {
    const asset = assetPath(raw, pageDirectory);
    if (!asset || asset.endsWith(".html") || seen.has(asset) || shared.has(asset)) return;
    if (!sizes.has(asset)) {
      if (mustResolve) unresolved?.add(asset);
      return;
    }
    seen.add(asset);
    discovered?.add(asset);
    total += sizes.get(asset);
  };
  /* Commented-out markup is not fetched. HTML comments do not nest, so
     removing them is exact.

     The contents of a raw-text element are data, not markup: an `<img src=…>`
     written inside a JSON-LD `<script>` or a `<textarea>` fetches nothing. The
     start tags are kept — a `<script src=…>` is a real fetch — and only the
     contents are dropped. `<style>` is deliberately not in this list, because
     its contents are CSS the page really does fetch from, and are scanned as
     such below. */
  const live = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(<(script|textarea|title)\b[^>]*>)[\s\S]*?<\/\2\s*>/gi, "$1");

  /* One matcher for every fetch-producing attribute. The name must start an
     attribute — preceded by whitespace, a quote or a slash — so `data-src`,
     which the browser does not fetch, is not read as `src`. HTML allows exactly
     three attribute-value forms — double-quoted, single-quoted, and unquoted
     (no whitespace, quotes, =, <, > or backtick) — so covering all three is
     complete rather than another guess at a spelling. A srcset lists candidates
     as `url descriptor, url descriptor`; the browser fetches one of them, so
     every candidate counts toward what the page can cost.

     `href` is deliberately not in this set: on an anchor it is navigation, and
     the file is fetched only if someone follows the link. It is scanned below,
     on <link> elements alone, where it does name an immediate fetch. */
  const scan = (text, attributes) => {
    const pattern = new RegExp(
      `(?:^|[\\s"'/])(${attributes})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
      "gi"
    );
    for (const match of text.matchAll(pattern)) {
      const [, attribute, doubleQuoted, singleQuoted, unquoted] = match;
      const value = decodeEntities(doubleQuoted ?? singleQuoted ?? unquoted ?? "");
      const urls = attribute.toLowerCase() === "srcset"
        ? value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0])
        : [value.trim()];
      for (const url of urls) add(url, true);
    }
  };

  /* Scan start tags rather than the whole document: `style=…` or `src=…`
     appearing in text content — inside a <code> sample, say — is not an
     attribute and fetches nothing. The tag pattern steps over quoted values so
     a `>` inside one (`alt="a > b"`) does not end the tag early. */
  const START_TAG = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  for (const [, name, attributes] of live.matchAll(START_TAG)) {
    scan(attributes, "src|poster|srcset");
    if (name.toLowerCase() === "link") scan(attributes, "href");
    for (const style of attributes.matchAll(
      /(?:^|[\s"'\/])style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
    )) {
      for (const url of cssUrls(style[1] ?? style[2] ?? style[3] ?? "")) {
        add(decodeCssEscapes(decodeEntities(url)), true);
      }
    }
  }
  /* A <style> block's contents are CSS, fetched exactly like an <img> and
     belonging to this page rather than to the shared stylesheet. */
  for (const block of live.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const url of cssUrls(block[1] ?? "")) {
      add(decodeCssEscapes(decodeEntities(url)), true);
    }
  }
  return total;
}

function checkPageFamilies(families, output, files, shared, discovered, report) {
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
      const unresolved = new Set();
      const bytes = referencedMediaBytes(
        html.toString("utf8"),
        sizes,
        shared,
        page.split("/").slice(0, -1).join("/"),
        discovered,
        unresolved
      );
      for (const reference of unresolved) {
        failures.push(`${page} references ${reference}, which this check cannot resolve to a built file`);
      }
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
    /* Per-page media is governed by the family budgets, the reachability check
       and the per-file ceilings, so it is not held to this rule — otherwise
       budgeting one CSS background would demand that all 363 covers be listed
       as shared assets too. This rule is about a new page-wide stylesheet,
       script or font, which live directly under assets/. */
    .filter((file) => !file.startsWith(`${MEDIA_DIRECTORY}/`))
    .filter((file) => extensions.has(extname(file).toLowerCase()) && !listed.has(file))
    .map((file) => `Shared asset is not budgeted: ${file}`);
}

/* A shared stylesheet fetches its own media — `url("…")` backgrounds and
   fonts — on every page, and an HTML-only scan never sees them. Anything a
   shared stylesheet pulls in must therefore be a budgeted shared asset itself. */
function checkStylesheetMedia(assets, output, files, discovered) {
  const listed = new Set(assets.flatMap((asset) => asset.files));
  const present = new Set(files.map((file) => relative(output, file).split(sep).join("/")));
  const failures = [];
  for (const stylesheet of [...listed].filter((file) => file.endsWith(".css"))) {
    const directory = stylesheet.split("/").slice(0, -1).join("/");
    const css = readFileSync(join(output, stylesheet), "utf8");
    for (const url of cssUrls(css)) {
      const asset = assetPath(decodeCssEscapes(url), directory);
      if (!asset) continue;
      if (!present.has(asset)) {
        failures.push(`${stylesheet} references ${asset}, which this check cannot resolve to a built file`);
        continue;
      }
      /* A budgeted stylesheet reference is a real fetch, so it counts as
         discovered — otherwise the reachability check below would reject a
         correctly budgeted CSS background as unreferenced. */
      if (listed.has(asset)) {
        discovered?.add(asset);
        continue;
      }
      failures.push(`${stylesheet} references an unbudgeted asset: ${asset}`);
    }
  }
  return failures;
}

/* Every shipped image must be discovered by the scan above. This is the
   backstop for the scan itself: the reference syntaxes of HTML and CSS are
   open-ended, and a spelling the scanner cannot read would otherwise make a
   page's images weigh zero — silently, which is the worst failure mode. If a
   template starts emitting a form this cannot read, its images stop being
   discovered and the build fails here instead of under-reporting. Files the
   site genuinely no longer references are listed in the config. */
function checkMediaReachable(performance, output, files, discovered) {
  const allowed = new Set(performance.unreferencedMedia ?? []);
  const shipped = files
    .map((file) => relative(output, file).split(sep).join("/"))
    .filter((file) => file.startsWith(`${MEDIA_DIRECTORY}/`));
  const failures = shipped
    .filter((file) => !discovered.has(file) && !allowed.has(file))
    .map((file) => `No page references ${file}, or its reference cannot be read`);
  for (const file of allowed) {
    if (discovered.has(file)) failures.push(`${file} is referenced now; remove it from unreferencedMedia`);
    else if (!shipped.includes(file)) failures.push(`unreferencedMedia lists a missing file: ${file}`);
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
  const discovered = new Set();
  failures.push(...checkPageFamilies(performance.pageFamilies, output, files, shared, discovered, report));
  report.push("Shared assets loaded by every page:");
  failures.push(...checkSharedAssets(performance.sharedAssets, output, report));
  failures.push(...checkUnbudgetedShared(performance.sharedAssets, output, files));
  failures.push(...checkStylesheetMedia(performance.sharedAssets, output, files, discovered));
  /* Last, so pages and stylesheets have both contributed their discoveries. */
  failures.push(...checkMediaReachable(performance, output, files, discovered));
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
