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

`scripts/check-repository.mjs` reads workflow files as text rather than parsing
YAML, which is sound only while the text and the parsed document agree. It
therefore refuses the constructs where they can diverge — escaped double-quoted
scalars, flow collections, explicit `? key`, anchors, aliases, and merge keys —
and asks its questions of what remains:

- every `permissions:` declaration must be provably `read` or `none`; an
  unrecognised value fails rather than passes;
- no workflow may mention the `secrets` context except the exact access
  `secrets.GITHUB_TOKEN`;
- no `pull_request_target`, `workflow_run`, or `workflow_dispatch` — a manual
  run loads the selected branch's copy of the workflow, so the guard in that
  copy cannot be trusted to have run;
- actions are pinned to a full commit SHA, container actions to a digest.

Each rule is written to fail closed: a shape the guard cannot read is rejected,
not assumed safe. Write it in plain block YAML and the guard reads it.
