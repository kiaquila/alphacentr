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

## Baseline pin and its required follow-up

`.web-design/lock.json` pins the baseline at
`f042879d8b6d11cc80021bb19cc4aacd645cc621`, version `0.1.0-dev`. This is a
**provisional** pin: at migration time `kiaquila/web-design` had no immutable
stable release of the project template, and the draft pull request that
introduces it was explicitly not to be merged.

The pin is honest rather than a workaround. The commit is a real 40-character
SHA in the source repository, `scripts/bootstrap-project.mjs` accepted it with
no local edit, and both `check-managed-files.mjs` and `check-baseline-change.mjs`
accept `0.1.0-dev` as a release version. Nothing in the baseline was patched to
make this pass.

**Required follow-up.** After the draft template pull request is merged and the
first immutable stable release is tagged, re-pin this project onto that
release's full commit SHA in a separate pull request:

```bash
npm run sync:web-design -- plan  --source-ref <stable-release-sha> --version <version>
npm run sync:web-design -- apply --source-ref <stable-release-sha> --version <version>
```

Until then, `baseline-source-verification` resolves the pin against a commit
that lives on a feature branch of the source repository. The source repository
is public, so the check needs no `WEB_DESIGN_READ_TOKEN`.
