# Testing and performance

## Checks

From a fresh checkout, install both lockfiles once — the root one carries the
`yaml` parser the guard uses, the `site` one carries the build:

```bash
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix site
```

`npm run preflight` then runs, in order, exactly what the `project-ci` workflow
runs:

| Step | Command | What it covers |
| --- | --- | --- |
| repository guard | `npm run check:repository` | tracked build output, dependencies, secrets, personal paths, symlinks, workflow permissions and action pinning |
| harness tests | `npm run test:harness` | regression tests for the guard, the config contract, and the budget |
| project checks | `npm run check:project` | `npm --prefix site run check` — the 828-page build and the route tests |
| payload budget | `npm run check:budget` | page weight, measured against the build the previous step produced |

`projectChecks` in `web-design.config.json` holds real commands as argument
arrays, so the runner executes the named program directly and never interprets
shell text.

## Why the budget is per page, not per build

The upstream template budgets the whole deployable directory: a total raw size,
a total gzip size, and a per-extension total. That works for a handful of pages
and breaks down here.

This site builds **828 static routes** — 25.4 MB of HTML — and ships **363
cover images** totalling 7.5 MB. A visitor loads exactly one of those pages. Any
aggregate ceiling large enough for the build to pass would be roughly three
thousand times a real page's weight, so it could never catch a regression; and
adding a page would consume budget even if every page stayed small. A total over
all HTML and images does not describe what anybody downloads.

So the budget measures what a visit actually costs:

1. **Critical HTML per page family.** Every built page belongs to exactly one
   family, named by a pattern over its path, and each family has a budget. The
   checker gzips **every** page in a family and holds its heaviest member to
   that budget.

   Families rather than a list of sample pages: naming one page per family only
   proves that page is small, and any of the other 817 could grow past it
   unnoticed — which is exactly what happened during review, when the author
   sample was the small landing page rather than the family's heaviest. The
   representative recorded below is therefore derived from the build, not
   trusted from the config, and a page matching no family is a failure, so none
   goes unbudgeted.

   The site loads CSS and JS as separate files, so a page's critical payload is
   its HTML document, measured gzipped because that is how it is served.
2. **The media each page references**, budgeted per family alongside its HTML.
   A catalogue category page pulls in 86 covers — about 1.9 MB — so budgeting
   the document alone would leave the bulk of a visit's real weight unmeasured
   while every individual image stayed under the per-file ceiling. Shared assets
   are excluded from this figure, since they are counted once below.

3. **Shared assets**, budgeted separately because they are fetched once and then
   reused across all 828 routes.
4. **Per-file ceilings**, so one oversized image fails on its own instead of
   hiding among 362 others.

5. **A reachability backstop.** HTML and CSS reference syntax is open-ended —
   quoting, escapes, character references, case — so a spelling the scanner
   cannot read would make a page's images weigh zero, silently, which is the
   worst failure mode. Every shipped file under `assets/media/` must therefore
   be discovered by the scan. If a template starts emitting a form the scanner
   cannot read, its images stop being discovered and the build fails here
   instead of under-reporting. The six files the site genuinely no longer
   references are listed in `performance.unreferencedMedia`; a file that
   becomes referenced again must be removed from that list.

## Recorded baseline

Measured from `npm --prefix site run build` at the commit that introduced this
budget. Every limit is stored beside the measurement it came from, and
`scripts/config.mjs` rejects a limit set below its own recorded measurement.

Per family: the heaviest HTML document (gzip) and the heaviest referenced
media payload (raw, excluding shared assets).

| Page family | Pages | HTML gzip | Budget | Media raw | Budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| home | 1 | 8 794 B | 10 240 B | 403 104 B | 462 848 B |
| catalogue index | 1 | 5 602 B | 6 656 B | 180 844 B | 208 896 B |
| catalogue category | 18 | 8 511 B | 10 240 B | 1 876 372 B | 2 097 152 B |
| session page | 606 | 16 029 B | 18 432 B | 133 186 B | 155 648 B |
| articles index | 1 | 5 077 B | 6 144 B | 89 570 B | 106 496 B |
| article section | 16 | 9 816 B | 11 264 B | 0 B | 40 960 B |
| article page | 141 | 42 329 B | 47 104 B | 321 644 B | 368 640 B |
| author landing | 1 | 4 488 B | 5 632 B | 0 B | 40 960 B |
| author page | 6 | 10 284 B | 11 776 B | 0 B | 40 960 B |
| press item | 8 | 4 333 B | 5 120 B | 0 B | 40 960 B |
| testimonials | 1 | 32 122 B | 36 864 B | 0 B | 40 960 B |
| FAQ | 1 | 17 891 B | 20 480 B | 0 B | 40 960 B |
| editorial, legal and news | 27 | 17 893 B | 20 480 B | 0 B | 40 960 B |

A zero media figure means the family references nothing beyond the shared
assets; its budget is still a real number so a later image is bounded. Covers
are lazy-loaded, so the media figure is the full weight of a page rather than
what arrives before first paint — the HTML column is the first-render cost.

The thirteen families sum to all 828 built pages. The `press item` family exists
because the coverage rule found it: eight `avtor/pressa-i-tv/…` pages sit a
level deeper than the other author pages and matched no family on the first
pass.

| Shared asset | Measured | Budget |
| --- | ---: | ---: |
| stylesheet `assets/styles.css` | 6 815 B gzip | 8 192 B |
| client script `assets/nav.js` | 801 B gzip | 1 024 B |
| web fonts, both Inter subsets | 67 176 B raw | 73 728 B |
| logo and favicon, both SVGs | 11 502 B gzip / 29 190 B raw | 13 312 B / 32 768 B |

Any file whose extension one of these uses must itself be listed here, so a new
page-wide stylesheet, script, font or vector cannot ship unmeasured — the
extension allow-list would otherwise accept it while the page budget saw only
its `<link>` tag.

| Per-file ceiling | Largest measured | Budget |
| --- | ---: | ---: |
| cover image (`.webp`) | 321 644 B raw | 358 400 B |
| vector asset (`.svg`) | 14 595 B raw | 16 384 B |

Headroom is 12–25 % — enough to absorb ordinary copy edits and the ~1 % gzip
difference between zlib builds (the numbers above are from macOS; CI on Linux
measures slightly higher), small enough that a new stylesheet layer, an
unoptimised image, or a runaway listing page trips the check.

For context, the whole-site distribution is 4.0 KB minimum, 7.9 KB median, and
11.6 KB at the 90th percentile, so the two large outliers above — a long book
article and the 84-item testimonials page — are budgeted as the deliberate
exceptions they are, not used to set a ceiling for everything else.

**Changing a limit.** Re-run the build, take the new measurement, update both
the measured value and the limit, and explain the tradeoff in the pull request.
Do not raise a limit merely to make a check pass.

**What else is pinned.** `web-design.config.json` also requires
`projectChecks` to run `npm --prefix site run check` from the repository root,
and pins the root and `site` package scripts that command resolves to. Without
that, a check could keep its exact command while the script behind it quietly
stopped running the route tests. Changing how the site is built or tested is
fine — update those pinned values in the same pull request.

## Manual checks

Automated checks complement visual QA rather than replacing it. For visual
changes, record the narrow (375 px) and wide (1280 px and above) layouts,
keyboard navigation and focus, the mobile menu and disclosure widgets, reduced
motion, console and network errors, and the longest category and session titles.
