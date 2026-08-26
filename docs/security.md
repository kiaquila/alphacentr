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

## What the guard cannot enforce, and what backs it

A `pull_request` run evaluates the candidate ref's copy of `ci.yml`, so a branch
supplies the workflow that checks it. No rule written inside that file can bind
it — the branch owns the rule too. This is why `workflow_dispatch`,
`workflow_run` and `pull_request_target` are refused outright, but `pull_request`
itself has to stay: without it there is no pull-request validation at all.

What actually binds is repository configuration, outside any branch's reach.
The state this repository relies on, verified via the API:

| Setting | Value | Why it matters |
| --- | --- | --- |
| Default workflow permissions | `read` | A branch's copy cannot obtain a write token however it spells `permissions:` |
| Allow GitHub Actions to approve pull requests | off | A workflow cannot approve its own pull request |
| Actions secrets | none | There is no credential for a candidate branch to read |
| Environments | none | No environment secret or protection rule to subvert |

Keep those settings as they are. The guard's workflow rules are a fast, local
signal that a change is heading the wrong way; they are not the boundary, and
they should not be described as one.
