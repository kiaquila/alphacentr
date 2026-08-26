# Security

- Keep secrets and production data outside Git in the deployment platform's
  secret store or an ignored local file.
- Give workflows top-level least-privilege permissions and pin external actions
  to full commit SHAs.
- Do not use `pull_request_target` for candidate code.
- Do not deploy, publish, change DNS, or mutate external systems from ordinary
  pull-request validation.
- Review new network dependencies, embeds, analytics, and trackers for purpose,
  license, privacy, and failure behavior.

## What the repository guard enforces

`scripts/check-repository.mjs` reads workflow files through a YAML parser and
asks its questions of the parsed document. Reading the text instead meant
re-deriving YAML one spelling at a time — quoted keys, escaped scalars, flow
collections, anchors, merge keys, comments that look like block scalars — and
each spelling missed was a silent bypass. The parser decides what the document
says; the guard only decides what is allowed:

- every `permissions:` declaration must be provably `read` or `none`; an
  unrecognised value fails rather than passes;
- no workflow may mention the `secrets` context except the exact access
  `secrets.GITHUB_TOKEN`;
- no `pull_request_target`, `workflow_run`, or `workflow_dispatch` — a manual
  run loads the selected branch's copy of the workflow, so the guard in that
  copy cannot be trusted to have run;
- actions are pinned to a full commit SHA, container actions to a digest.

Each rule fails closed: a permission value that is not recognisably read-only
is rejected rather than assumed safe, and a workflow that does not parse is
rejected outright.
