# Testing and performance

## Checks

`npm run preflight` runs, in order, exactly what the `project-ci` workflow runs:

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

1. **Critical HTML per representative page.** For each page family produced by
   `site/src/routes.mjs` — home, catalogue, article, author, info — the budget
   covers the **heaviest member of that family**, so the limit actually binds,
   plus the index or landing page visitors usually arrive on. The heaviest
   member is found by enumerating every route the family's module returns and
   measuring all of them, not by guessing from the URL shape. The site loads CSS
   and JS as separate files, so a page's critical payload is its HTML document,
   and it is measured gzipped because that is how it is served.
2. **Shared assets**, budgeted separately because they are fetched once and then
   reused across all 828 routes.
3. **Per-file ceilings**, so one oversized image fails on its own instead of
   hiding among 362 others.

## Recorded baseline

Measured from `npm --prefix site run build` at the commit that introduced this
budget. Every limit is stored beside the measurement it came from, and
`scripts/config.mjs` rejects a limit set below its own recorded measurement.

| Representative page | Route family | Measured gzip | Budget |
| --- | --- | ---: | ---: |
| home | `home.mjs` | 8 794 B | 10 240 B |
| catalogue index | `catalog.mjs` | 5 602 B | 6 656 B |
| catalogue category (largest) | `catalog.mjs` | 8 511 B | 10 240 B |
| session page (largest) | `catalog.mjs` | 16 029 B | 18 432 B |
| articles index | `articles.mjs` | 5 077 B | 6 144 B |
| article section (largest) | `articles.mjs` | 9 816 B | 11 264 B |
| article page (largest) | `articles.mjs` | 42 329 B | 47 104 B |
| author landing | `author.mjs` | 4 488 B | 5 632 B |
| author page (largest) | `author.mjs` | 10 284 B | 11 776 B |
| testimonials (largest listing) | `info.mjs` | 32 122 B | 36 864 B |
| FAQ | `info.mjs` | 17 891 B | 20 480 B |

`/otzyvy/` is the heaviest route `info.mjs` produces; `/info/` is within 2 bytes
of the FAQ entry, so FAQ stands for that shape. `/catalog/…/552/` and the
Bekhterev article are the heaviest members of their families.

| Shared asset | Measured | Budget |
| --- | ---: | ---: |
| stylesheet `assets/styles.css` | 6 815 B gzip | 8 192 B |
| client script `assets/nav.js` | 801 B gzip | 1 024 B |
| web fonts, both Inter subsets | 67 176 B raw | 73 728 B |

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

## Manual checks

Automated checks complement visual QA rather than replacing it. For visual
changes, record the narrow (375 px) and wide (1280 px and above) layouts,
keyboard navigation and focus, the mobile menu and disclosure widgets, reduced
motion, console and network errors, and the longest category and session titles.
