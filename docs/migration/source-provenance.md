# Source provenance

This repository was extracted from the `alphacentr/` directory of the
`kiaquila/web-design` multi-project workspace on 2026-08-20. Nothing was
re-created by hand: the published tree and the project's whole commit history
were carried over by `git filter-repo` and then proved against the source.

## Source identity

| Fact | Value |
| --- | --- |
| Source repository | `kiaquila/web-design` (public) |
| Source commit (published `main`) | `3b99cb3d23328013c28eb73ab8525b13b6992d9e` |
| Source subtree | `alphacentr/` |
| Source subtree tree object | `3f218ed66aaace1775f9427b6e62d4a1b6523620` |
| Rewritten `main` | `46de0dd5c807a2ba20cd292fdda9005106197c37` |
| Files carried over | 437 |

The source commit was the tip of the source repository's `main` at extraction
time, so the migrated tree is the published state of the project and not a
work in progress.

## How the history was rewritten

A disposable clone of `kiaquila/web-design` was fetched from GitHub, not from
any local checkout, so that no uncommitted working-tree state could be picked
up. The clone was then reduced to a single ref at the source commit — every
other branch, every remote-tracking ref, and every tag was deleted, and the
reflog was expired — before the filter ran:

```bash
git clone https://github.com/kiaquila/web-design.git
git checkout --detach 3b99cb3d23328013c28eb73ab8525b13b6992d9e
# delete all other branches, remotes and tags, expire the reflog
git filter-repo --path alphacentr/ --path-rename alphacentr/:
```

The rename lifts `alphacentr/site` to `site` and the three project documents to
the repository root. That is the only topology change the history rewrite makes.

## Proof taken before any migration edit

All four checks were run on the filtered clone, before the baseline or any
adaptation was committed.

1. **Exact tree.** The root tree of the rewritten `main` is
   `3f218ed66aaace1775f9427b6e62d4a1b6523620` — the same tree object the source
   repository published under `alphacentr/` at
   `3b99cb3d23328013c28eb73ab8525b13b6992d9e`. The migrated content is
   therefore byte-identical to the source, not merely equivalent.
2. **Commit history.** The rewritten `main` carries 10 commits, which reconcile
   exactly against the source:

   | Kind | Count | Note |
   | --- | --- | --- |
   | Non-merge commits touching `alphacentr/` | 8 | the expected set, complete |
   | Merge commits that carried `alphacentr/` changes | 1 | `Merge current main and migrate Alpha-Centr staging`, which changed `site/README.md` and `site/wrangler.json` in the merge itself |
   | Commits that were already empty upstream | 1 | `Trigger Alpha-Centr branch preview` |

   `git filter-repo` prunes commits that *become* empty through filtering; it
   does not delete commits that were empty in the source. The merge above lost
   its second parent because that parent contributed nothing to `alphacentr/`,
   but the changes it introduced were kept.
3. **No tags.** The source repository's only tag, `chaijana-iteration-01`,
   belongs to another project and does not appear here.
4. **Object integrity.** `git fsck --full --strict` reports no problem.

## What was deliberately excluded

The extraction used the immutable published commit only. None of the following
reached this repository:

- the dirty working tree of the local `web-design` checkout;
- the `feat/alphacentr-lumen` and `feat/alphacentr-restore-photography` feature
  branches;
- the rejected local **Alpha Lumen Deep** concept;
- any other project directory of the workspace.

### Proof that the rejected Alpha Deep concept is absent

The Alpha Deep concept was identified by three artefacts: the `PlayfairDisplay`
typeface, `playfair-display-*.woff2` font files, and `site/src/styles/bands.css`.
None of them exists in this repository, in any commit of its history:

```bash
# no matching path in any of the 10 commits
git log --all --pretty=format:%H | while read c; do git ls-tree -r --name-only "$c"; done \
  | sort -u | grep -Ei 'playfair|bands'      # no output, exit 1

# no matching content in any commit, anywhere outside this document
git grep -I -Ei 'playfair|bands\.css' $(git rev-list --all) \
  -- ':!docs/migration/source-provenance.md'   # no output, exit 1

# strictest form: the shipped product tree only
git grep -I -Ei 'playfair|bands\.css' $(git rev-list --all) -- site   # no output, exit 1
```

The second command excludes this file by pathspec for one reason: this document
is the only place in the repository where the strings `PlayfairDisplay`,
`playfair-display-*.woff2`, and `bands.css` appear at all — it has to name the
artefacts in order to state that they are absent. Without the exclusion the
search matches its own prose and exits 0, which would make the check
unreproducible. The third command avoids the question entirely by searching only
`site/`, the tree that is actually shipped; it is the one to run if the
exclusion looks like special pleading. Both return nothing.

The same searches return nothing when run against `alphacentr/` at the
source commit, and `git log --all --diff-filter=A -- '*playfair*' '*bands.css*'`
in the source repository attributes every Playfair Display file to the `ks/`
and `chaijana/` projects. The Alpha Deep concept was never committed to
`alphacentr/` in any ref of the source repository, so the filtered history
cannot contain it.

What *is* present is the approved **Alpha Lumen** concept, unrenamed. The site
ships one self-hosted typeface, Inter, as Latin and Cyrillic subsets under the
SIL Open Font License, with five stylesheets: `base.css`, `components.css`,
`layout.css`, `pages.css`, and `tokens.css`.

## Preserved product invariants

Verified on the migrated tree by `npm --prefix site run check`:

| Invariant | Evidence |
| --- | --- |
| 419 unique materials | recorded in `README.md` and `CONTENT-AUDIT.md` |
| 828 static routes | `Built 828 pages into dist/` |
| Route completeness tests | 13 of 13 pass in `site/tests/routes.test.mjs` |
| Catalogue | 18 categories, 256 sessions, every session reachable |
| Articles | 106 articles in 7 sections, plus the preserved alias URLs |
| Editorial, news, FAQ, press, testimonials | 16 / 6 / 10 / 8 / 84 |
| Approved local images | every referenced asset exists; ≥250 session covers and ≥100 article images |
| Self-hosted Inter | `site/assets/fonts/inter-{latin,cyrillic}.woff2` + `OFL-Inter.txt` |
| Content and data JSON | `site/src/content/**`, `site/src/data/*.mjs` unchanged |
| Worker and CSP | `site/worker/index.ts`, `run_worker_first: true` asserted by test |
| `mailto:` form behaviour | forms post to the author's address; CSP allows `form-action 'self' mailto:` |
| Hidden phone number | still unpublished, with the rationale kept in `site/src/data/site.mjs` |

Nothing was added: no medical promise, price, backend, payment flow, CDN,
analytics, external font, or protected book text.

## Harness baseline

The development harness in this repository — the repository guard, the project
check runner, the payload budget, the config contract, the CI workflow, and the
`docs/content-and-design.md`, `docs/security.md`, and `docs/testing.md`
standards — was copied from the `template/` directory of `kiaquila/web-design`
at `ea8501fdb90236fcb891e97b15f7a42a62f76ff1` ("refactor: add a lightweight
web-design project template (#46)").

| Fact | Value |
| --- | --- |
| Baseline repository | `kiaquila/web-design` (public) |
| Baseline commit | `ea8501fdb90236fcb891e97b15f7a42a62f76ff1` |
| Baseline subtree | `template/` |

The copy was adapted locally and is now owned here. Two deliberate departures
from the template, both recorded in `docs/testing.md`:

- the template's aggregate `dist`-wide payload budget was replaced by per-page,
  shared-asset, and per-file budgets, because this site builds 828 routes and a
  total over all of them does not describe any visitor's page weight;
- `scripts/check-repository.mjs` is the template's ~100-line guard rather than
  the 2251-line policy engine that an earlier revision of this branch carried.
  That engine tried to parse shell text inside workflow steps, and every review
  finding against it was a gap in that parsing. This repository has one
  read-only workflow, no write-capable job, and no actor-controlled input, so
  the guard enforces those properties structurally — it rejects any workflow
  that grants a write scope, consumes a repository secret, or uses
  `pull_request_target` or `workflow_run` — instead of trying to decide whether
  a given shell command is safe. It also stays inside the 600-line-per-file
  limit that `AGENTS.md` sets, which the previous implementation did not.

Nothing in this repository reaches back to `kiaquila/web-design` at runtime or
in CI. There is no lock file, release manifest, managed-file list, profile,
synchronisation script, update workflow, or upstream-verification check: later
template improvements are copied in selectively through ordinary reviewable
pull requests.
