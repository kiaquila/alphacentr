# Cloudflare cutover

**Nothing in this document has been performed, and this repository has no
Cloudflare integration.** The Cloudflare connection is deliberately disabled
here: no Cloudflare token is stored in this repository or in GitHub, no workflow
deploys, and the repository's only workflow is read-only. The `alphacentr`
Worker still builds from `kiaquila/web-design`, so the live stage is unaffected
by anything merged here.

`site/` keeps its `wrangler.json` and the `stage:deploy` / `stage:preview`
scripts so the Worker contract stays reviewable and the cutover needs no code
change — but they are run by a person, on purpose, never by CI. Perform the
cutover only after the migration pull request is merged and the owner has
explicitly authorised it.

## Current deployment — the rollback point

Recorded from `docs/stage-hosting.md` in `kiaquila/web-design` at
`3b99cb3d23328013c28eb73ab8525b13b6992d9e`. Restore exactly these values to
roll back.

| Setting | Value |
| --- | --- |
| Worker name | `alphacentr` |
| Repository | `kiaquila/web-design` |
| Production branch | `main` |
| Root directory | `alphacentr/site` |
| Build command | `npm run build` |
| Production deploy command | `npm run stage:deploy` |
| Non-production deploy command | `npm run stage:preview` |
| Included build watch path | `alphacentr/*` |
| Stable URL | `https://alphacentr.ks-design.workers.dev` |

## Target deployment — after cutover

Only the Git connection and the two path settings change. The Worker keeps its
name, so the stable URL and every preview URL shape stay the same.

| Setting | Value | Change |
| --- | --- | --- |
| Worker name | `alphacentr` | unchanged |
| Repository | `kiaquila/alphacentr` | **changed** |
| Production branch | `main` | unchanged |
| Root directory | `site` | **changed** |
| Build command | `npm run build` | unchanged |
| Production deploy command | `npm run stage:deploy` | unchanged |
| Non-production deploy command | `npm run stage:preview` | unchanged |
| Included build watch path | remove — this repository is single-project | **changed** |
| Stable URL | `https://alphacentr.ks-design.workers.dev` | unchanged |

The runtime contract is already correct in this repository and needs no edit:
`site/wrangler.json` declares `"name": "alphacentr"`, a pinned
`compatibility_date` of `2026-08-06`, `"workers_dev": true`,
`"preview_urls": true`, and static assets from `./dist` with
`run_worker_first: true` so every response passes through the security-header
Worker.

Cloudflare owns the Git connection and the build credentials. No Cloudflare
token is stored in this repository or in GitHub, and the cutover introduces
none.

## Cutover procedure

Owner-only, in the Cloudflare dashboard. Steps 1–2 are reversible at any time;
step 3 is the first moment the new repository can publish.

1. **Freeze the old source.** In `kiaquila/web-design`, stop merging changes
   under `alphacentr/`. The directory is intentionally *not* deleted there, so
   the rollback point stays intact.
2. **Record the live version.** In *Workers → `alphacentr` → Deployments*, note
   the current active version id and its commit. This is what step "Rollback"
   restores.
3. **Repoint the Git connection.** In *Workers → `alphacentr` → Settings →
   Build*, disconnect `kiaquila/web-design` and connect
   `kiaquila/alphacentr`. Grant the Cloudflare GitHub App access to the new
   repository when prompted.
4. **Update the build settings** in the same panel:
   - root directory `site` (was `alphacentr/site`);
   - build command `npm run build`;
   - production deploy command `npm run stage:deploy`;
   - non-production deploy command `npm run stage:preview`;
   - remove the `alphacentr/*` build watch path.
5. **Trigger one build from `main`** and let it finish.
6. **Run the smoke list** below against
   `https://alphacentr.ks-design.workers.dev`.
7. **Verify previews** by opening a throwaway pull request and confirming
   Cloudflare posts a `https://<version>-alphacentr.ks-design.workers.dev` URL.
   The version prefix is assigned by Cloudflare and must never be hard-coded.

## Rollback

Any of these is sufficient, cheapest first.

- **Instant, no rebuild.** In *Deployments*, roll back to the version id
  recorded in step 2. This restores the previous bytes immediately and does not
  depend on either repository.
- **Full revert of the connection.** Reconnect `kiaquila/web-design`, restore
  root directory `alphacentr/site` and the `alphacentr/*` watch path, and
  trigger a build from `main`. The source directory still exists there, so this
  reproduces the pre-cutover stage exactly.

## Smoke list after cutover

Check against the stable URL, on a narrow (375 px) and a wide (1280 px and
above) viewport:

1. Home page renders, and the header, mobile menu, and footer work.
2. `/catalog/` lists 18 categories; open one category and one session page.
3. `/stati/` opens, and one article from a section and one alias URL resolve.
4. A preserved alternative URL still resolves, for example
   `/psihologicheskoe-konsultirovanie/`.
5. `/otzyvy/`, `/news/`, `/info/faq/`, `/avtor/kontakty/` all render.
6. `404` handling: request a path that does not exist and confirm the 404 page.
7. Security headers are present on an HTML response — `Content-Security-Policy`,
   `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`,
   `Referrer-Policy`, `Permissions-Policy`:

   ```bash
   curl -sSI https://alphacentr.ks-design.workers.dev/ | grep -i \
     -e content-security-policy -e strict-transport-security \
     -e x-content-type-options -e x-frame-options \
     -e referrer-policy -e permissions-policy
   ```

8. Fonts load from the same origin — no request to any third-party host.
9. `sitemap.xml` and `robots.txt` are served.
