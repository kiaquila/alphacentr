/* Payload budget: page families, shared assets, and per-file ceilings. */

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

test("images a page references count against its family budget", () => {
  /* A catalogue page pulls in dozens of covers, so budgeting only the HTML
     would leave most of its real weight unmeasured while each image stayed
     under the per-file ceiling. */
  withFixture((root) => {
    write(root, "site/dist/assets/media/cover.webp", randomBytes(6 * 1024));
    write(
      root,
      "site/dist/index.html",
      '<!doctype html><title>Home</title><img src="/assets/media/cover.webp" />\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Media of home \(index\.html\): \d+ B exceeds 4096 B/);
  });
});

test("media counts however the attribute is spelled", () => {
  /* The browser fetches these, so a quote style or attribute the scanner did
     not anticipate must not silently drop them from the total. */
  for (const markup of [
    '<img src="/assets/media/wide.webp" />',
    "<img src='/assets/media/wide.webp' />",
    '<img srcset="/assets/media/wide.webp 2x" />',
    "<img srcset='/assets/media/wide.webp 2x' />",
    "<source srcset='/assets/media/wide.webp 1x, /assets/media/wide.webp 2x' />",
    "<video poster='/assets/media/wide.webp'></video>",
    /* HTML's third attribute-value form: unquoted. */
    "<img src=/assets/media/wide.webp>",
    "<img srcset=/assets/media/wide.webp>",
    /* A query or fragment is part of the request, not of the file name. */
    '<img src="/assets/media/wide.webp?v=1" />',
    '<img src="/assets/media/wide.webp#frag" />',
    /* A relative URL resolves against the document that carries it. */
    '<img src="assets/media/wide.webp" />',
    /* HTML attribute names are case-insensitive. */
    '<IMG SRC="/assets/media/wide.webp" />',
    /* Character references are resolved before the URL is used. */
    '<img src="/assets/media/wide&#46;webp" />',
    '<img SrcSet="/assets/media/wide.webp 2x" />'
  ]) {
    withFixture((root) => {
      write(root, "site/dist/assets/media/wide.webp", randomBytes(6 * 1024));
      write(root, "site/dist/index.html", `<!doctype html><title>Home</title>${markup}\n`);
      const result = run(root, "check-performance-budget.mjs");
      assert.equal(result.status, 1, `media not counted: ${markup}`);
      assert.match(result.stderr, /Media of home \(index\.html\): \d+ B exceeds 4096 B/);
    });
  }
});

test("a page-local image resolves beside its own page", () => {
  /* `src="local.webp"` on `other/index.html` is `other/local.webp`, not a
     path under assets/, so resolving from the deployment root would miss it. */
  withFixture((root) => {
    write(root, "site/dist/other/local.webp", randomBytes(6 * 1024));
    write(
      root,
      "site/dist/other/index.html",
      '<!doctype html><title>Other</title><img src="local.webp" />\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Media of other pages \(other\/index\.html\): \d+ B exceeds 4096 B/);
  });
});

test("a link to another page is navigation, not payload", () => {
  withFixture((root) => {
    write(
      root,
      "site/dist/index.html",
      '<!doctype html><title>Home</title><a href="/other/index.html">Other</a>\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("the CSS url() function name is case-insensitive", () => {
  withFixture((root) => {
    write(root, "site/dist/assets/hero.webp", randomBytes(2 * 1024));
    write(
      root,
      "site/dist/assets/styles.css",
      ':root{color:#1b2a24}.h{background:URL("/assets/hero.webp")}\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /references an unbudgeted asset: assets\/hero\.webp/);
  });
});

test("a quoted CSS url may contain a parenthesis", () => {
  withFixture((root) => {
    write(root, "site/dist/assets/hero(1).webp", randomBytes(2 * 1024));
    write(
      root,
      "site/dist/assets/styles.css",
      ':root{color:#1b2a24}.h{background:url("/assets/hero(1).webp")}\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /references an unbudgeted asset: assets\/hero\(1\)\.webp/);
  });
});

test("an image no page can be seen to reference fails loudly", () => {
  /* The backstop for the scanner itself: HTML and CSS reference syntax is
     open-ended, so a spelling this cannot read must fail rather than quietly
     weigh zero. `data-src` is not fetched by the browser and is not read. */
  withFixture((root) => {
    write(root, "site/dist/assets/media/orphan.webp", randomBytes(1024));
    write(
      root,
      "site/dist/index.html",
      '<!doctype html><title>Home</title><img data-src="/assets/media/orphan.webp" />\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No page references assets\/media\/orphan\.webp/);
  });
});

test("a reference this check cannot resolve fails on its own page", () => {
  /* Global reachability is not enough: the same file referenced readably from
     another page would mask an undercount here, so an unresolvable fetch
     reference is reported against the page that carries it. */
  withFixture((root) => {
    write(root, "site/dist/assets/media/cover.webp", randomBytes(512));
    write(
      root,
      "site/dist/other/index.html",
      '<!doctype html><title>Other</title><img src="/assets/media/cover&period;webp" />\n'
    );
    write(
      root,
      "site/dist/index.html",
      '<!doctype html><title>Home</title><img src="/assets/media/cover.webp" />\n'
    );
    const config = readConfig(root);
    config.performance.unreferencedMedia = [];
    writeConfig(root, config);
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /other\/index\.html references .*cover&period;webp, which this check cannot resolve/);
  });
});

test("an href to a route is not treated as an unresolvable fetch", () => {
  withFixture((root) => {
    write(
      root,
      "site/dist/index.html",
      '<!doctype html><title>Home</title><a href="/catalog/">Catalogue</a>\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("media the config records as unreferenced is allowed", () => {
  withFixture((root) => {
    write(root, "site/dist/assets/media/orphan.webp", randomBytes(1024));
    const config = readConfig(root);
    config.performance.unreferencedMedia = ["assets/media/cover.webp", "assets/media/orphan.webp"];
    writeConfig(root, config);
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("a recorded file that is referenced again must be delisted", () => {
  withFixture((root) => {
    write(root, "site/dist/assets/media/cover.webp", randomBytes(512));
    write(
      root,
      "site/dist/index.html",
      '<!doctype html><title>Home</title><img src="/assets/media/cover.webp" />\n'
    );
    const config = readConfig(root);
    config.performance.unreferencedMedia = ["assets/media/cover.webp"];
    writeConfig(root, config);
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is referenced now; remove it from unreferencedMedia/);
  });
});

test("media pulled in by a page's own CSS counts against that page", () => {
  /* A <style> block or style attribute fetches exactly like an <img>, and the
     bytes belong to the page that carries it. */
  for (const markup of [
    '<style>.h{background:url(/assets/media/wide.webp)}</style>',
    '<div style="background:url(/assets/media/wide.webp)"></div>',
    "<div style='background:url(\"/assets/media/wide.webp\")'></div>",
    /* HTML's third attribute-value form applies to style as well. */
    "<div style=background:url(/assets/media/wide.webp)></div>"
  ]) {
    withFixture((root) => {
      write(root, "site/dist/assets/media/wide.webp", randomBytes(6 * 1024));
      write(root, "site/dist/index.html", `<!doctype html><title>Home</title>${markup}\n`);
      const result = run(root, "check-performance-budget.mjs");
      assert.equal(result.status, 1, `inline CSS media not counted: ${markup}`);
      assert.match(result.stderr, /Media of home \(index\.html\): \d+ B exceeds 4096 B/);
    });
  }
});

test("a <link> href is an immediate fetch and is counted", () => {
  withFixture((root) => {
    write(root, "site/dist/assets/media/wide.webp", randomBytes(6 * 1024));
    write(
      root,
      "site/dist/index.html",
      '<!doctype html><title>Home</title><link rel="preload" as="image" href="/assets/media/wide.webp" />\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Media of home \(index\.html\): \d+ B exceeds 4096 B/);
  });
});

test("a comment delimiter inside a CSS string is literal text", () => {
  /* `/*` in a quoted value does not open a comment, so a regex sweep between
     two strings would swallow the live declaration between them. */
  withFixture((root) => {
    write(root, "site/dist/assets/media/wide.webp", randomBytes(6 * 1024));
    write(
      root,
      "site/dist/index.html",
      "<!doctype html><title>Home</title><style>" +
        '.a{content:"/*"} .b{background:url(/assets/media/wide.webp)} .c{content:"*/"}' +
        "</style>\n"
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Media of home \(index\.html\): \d+ B exceeds 4096 B/);
  });
});

test("metadata and commented-out CSS are not fetched", () => {
  /* `data-style` is not a style attribute, and a commented-out declaration is
     never requested; neither may inflate a page total or fail the build. */
  for (const markup of [
    '<div data-style="background:url(/preview.webp)"></div>',
    "<style>/* background:url(/retired.webp) */</style>",
    /* A backslash escapes outside a string too, so this opens no string and
       the comment after it is still a comment. */
    '<style>:root{--quote: \\";} /* background:url(/retired.webp) */</style>',
    '<img data-src="/assets/media/wide.webp" />',
    /* Commented-out markup is not fetched. */
    '<!-- <img src="/assets/media/wide.webp" /> -->',
    /* An anchor is navigation: the file is fetched only if someone clicks. */
    '<a href="/assets/media/wide.webp">download</a>'
  ]) {
    withFixture((root) => {
      write(root, "site/dist/assets/media/wide.webp", randomBytes(6 * 1024));
      const config = readConfig(root);
      config.performance.unreferencedMedia = ["assets/media/cover.webp", "assets/media/wide.webp"];
      writeConfig(root, config);
      write(root, "site/dist/index.html", `<!doctype html><title>Home</title>${markup}\n`);
      const result = run(root, "check-performance-budget.mjs");
      assert.equal(result.status, 0, `treated as a fetch: ${markup}\n${result.stderr}`);
    });
  }
});

test("media a shared stylesheet pulls in must be budgeted", () => {
  /* The browser fetches a CSS background on every page, and an HTML-only scan
     never sees it. */
  withFixture((root) => {
    write(root, "site/dist/assets/media/hero.webp", randomBytes(2 * 1024));
    write(
      root,
      "site/dist/assets/styles.css",
      ':root{color:#1b2a24}.hero{background:url("/assets/media/hero.webp")}\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /styles\.css references an unbudgeted asset: assets\/media\/hero\.webp/);
  });
});

test("a stylesheet may reference assets that are budgeted", () => {
  withFixture((root) => {
    write(root, "site/dist/assets/nav.js", "/* shared */\n");
    write(
      root,
      "site/dist/assets/styles.css",
      ':root{color:#1b2a24}.a{background:url("./nav.js")}\n'
    );
    const result = run(root, "check-performance-budget.mjs");
    assert.equal(result.status, 0, result.stderr);
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