import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import {
  createCodexReviewRequestMarkerBody,
  isAcceptableCodexSummaryComment
} from "../scripts/codex-review-helpers.mjs";
import {
  rerunCodexReviewForHead,
  shouldRouteCodexReviewRerunEvent
} from "../scripts/codex-review-rerun.mjs";

const root = resolve(import.meta.dirname, "..");
const headSha = "2667f79cd7676ff331730cabf661d38dbbcddb0d";
const user = { login: "chatgpt-codex-connector[bot]" };
const requestedAt = "2026-10-15T21:30:00Z";
const legacy = "Codex Review: Didn't find any major issues. :rocket:\n\n**Reviewed commit:** `2667f79cd7`";
// Observed native receipt, including the optional integration help footer.
const receipt = `<!-- codex-review-receipt:v1 -->

${legacy}

<details> <summary>ℹ️ About Codex in GitHub</summary>
<br/>

[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general).
If Codex has suggestions, it will comment; otherwise it will react with 👍.
</details>`;
const structured = `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 ${JSON.stringify({
  code_review: { commit_sha: headSha, has_any_findings: false, has_unresolved_findings: false, status: "completed" },
  security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null }
})} -->

## Codex Review Summary`;
const comment = {
  id: 31, user, body: receipt,
  created_at: "2026-10-15T21:38:13Z", updated_at: "2026-10-15T21:38:13Z"
};
const acceptable = (candidate) => isAcceptableCodexSummaryComment(candidate, headSha, requestedAt, 30);

test("native receipt, full SHA receipt, and legacy remain explicit positive evidence", () => {
  for (const body of [receipt, legacy, receipt.replace("2667f79cd7`", `${headSha}\``),
    ...["Keep it up!", "Bravo.", "Looks great.", "🎉"].map((suffix) => legacy.replace(":rocket:", suffix))]) {
    assert.equal(acceptable({ ...comment, body }), true, body);
  }
});

test("receipt evidence rejects spoofed, stale, malformed, ambiguous and negative results", () => {
  const badBodies = [
    receipt.replace("2667f79cd7", "0000000000"),
    receipt.replace("2667f79cd7", `${headSha}a`),
    receipt.replace("2667f79cd7", "2667f79cd"),
    receipt.replace("2667f79cd7", `${headSha.slice(0, -1)}a`),
    receipt.replace("**Reviewed commit:** `2667f79cd7`", ""),
    receipt.replace("Didn't find any major issues.", "Found a P1 issue."),
    receipt.replace("Didn't find any major issues.", "Review in progress."),
    receipt.replace("Didn't find any major issues.", "Completed. 👍"),
    receipt.replace(":rocket:", "But a blocking problem remains."),
    receipt.replace(":rocket:", "Found an unresolved issue."),
    receipt.replace("v1 -->", "v2 -->"),
    receipt.replace("v1 -->", "v1"),
    `<!-- codex-review-receipt:v1 -->\n${receipt}`,
    `${receipt}\n**Reviewed commit:** \`${"a".repeat(40)}\``,
    `${legacy}\nCodex Review: Found a P2 issue.`,
    receipt.replace("</details>", "P2 issue\n</details>"),
    receipt.replace("</details>", "P3 note and P1 issue\n</details>"),
    structured,
    structured.replace('"completed"', '"in_progress"'),
    structured.replace('"has_any_findings":false', '"has_any_findings":true'),
    structured.replace(headSha, "a".repeat(40)),
    structured.replace('"has_any_findings":false', '"has_any_findings":"false"'),
    `${structured}\n${legacy}`,
    `${structured}\n${structured}`,
    "👍 Completed"
  ];
  for (const body of badBodies) assert.equal(acceptable({ ...comment, body }), false, body);
  assert.equal(acceptable({ ...comment, user: { login: "fake-codex[bot]" } }), false);
  assert.equal(acceptable({ ...comment, created_at: requestedAt, id: 29 }), false);
  assert.equal(acceptable({ ...comment, created_at: "2026-10-15T21:29:00Z" }), false);
  assert.equal(acceptable({ ...comment, created_at: "invalid" }), false);
  assert.equal(acceptable({ ...comment, created_at: "2026-10-15T21:29:00Z", updated_at: comment.updated_at }), false,
    "editing an old receipt must not rebind it to a new request");
});

test("created and edited native signals pass the actual workflow filter and runtime router", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/codex-review-rerun.yml"), "utf8");
  assert.match(workflow, /issue_comment:\s+types: \[created, edited\]/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  const expression = workflow.match(/    if: \|\n([\s\S]+?)    runs-on:/)[1];
  const workflowRoutes = (event, eventName = "issue_comment") => Boolean(runInNewContext(expression, {
    github: { event, event_name: eventName },
    startsWith: (body, prefix) => String(body).toLowerCase().startsWith(prefix.toLowerCase())
  }));
  for (const action of ["created", "edited"]) {
    for (const body of [legacy, receipt, structured]) {
      const event = { action, issue: { number: 1, pull_request: {} }, comment: { ...comment, body } };
      assert.equal(workflowRoutes(event), true);
      assert.equal(shouldRouteCodexReviewRerunEvent(event), true);
      const forged = { ...event, comment: { ...event.comment, user: { login: "fake-codex[bot]" } } };
      assert.equal(workflowRoutes(forged), false);
      assert.equal(shouldRouteCodexReviewRerunEvent(forged), false);
    }
  }
  const updatedSummary = { ...comment, body: structured, created_at: "2026-10-14T00:00:00Z" };
  assert.equal(shouldRouteCodexReviewRerunEvent({ action: "edited", issue: { pull_request: {} }, comment: updatedSummary }), true);
  for (const body of ["unrelated", "<!-- web-design:codex-review-request -->", "Codex Review Summary", "👍 Completed"]) {
    const event = { issue: { pull_request: {} }, comment: { ...comment, body } };
    assert.equal(workflowRoutes(event), false);
    assert.equal(shouldRouteCodexReviewRerunEvent(event), false);
  }
  const formal = { action: "submitted", review: { user }, pull_request: { number: 1 } };
  assert.equal(workflowRoutes(formal, "pull_request_review"), true);
  assert.equal(shouldRouteCodexReviewRerunEvent(formal), true);
  assert.equal(shouldRouteCodexReviewRerunEvent({ ...formal, action: "dismissed" }), false);
  assert.equal(shouldRouteCodexReviewRerunEvent({ action: "deleted", issue: { pull_request: {} }, comment }), false);
  assert.equal(shouldRouteCodexReviewRerunEvent({ action: "created", issue: {}, comment }), false);
});

const run = {
  id: 42, event: "pull_request", head_sha: headSha,
  status: "completed", conclusion: "failure",
  created_at: requestedAt, run_started_at: requestedAt
};

test("rerun re-evaluates completed or active gates once and ignores evidence already evaluated", async () => {
  for (const active of [false, true]) {
    let reads = 0;
    const posts = [];
    const request = async (_token, _repo, path, options = {}) => {
      if (options.method === "POST") { posts.push(path); return null; }
      if (path.includes("/pulls/")) return { state: "open", head: { sha: headSha } };
      return { workflow_runs: [{ ...run, status: active && reads++ === 0 ? "in_progress" : "completed" }] };
    };
    const args = { token: "token", repository: "owner/repo", headSha, pullNumber: 1, request, sleep: async () => {}, evidenceUpdatedAt: comment.updated_at };
    assert.equal((await rerunCodexReviewForHead(args)).action, "rerun");
    assert.equal(posts.length, 1);
    const afterRerun = async (_token, _repo, path) => path.includes("/pulls/")
      ? { state: "open", head: { sha: headSha } }
      : { workflow_runs: [{ ...run, run_started_at: "2026-10-15T21:39:00Z" }] };
    assert.equal((await rerunCodexReviewForHead({ ...args, request: afterRerun })).action, "already_evaluated");
  }
});

test("a newer edit reruns an earlier successful evaluation", async () => {
  let posts = 0;
  const result = await rerunCodexReviewForHead({
    token: "token", repository: "owner/repo", headSha, pullNumber: 1,
    evidenceUpdatedAt: "2026-10-15T21:40:00Z",
    request: async (_token, _repo, path, options = {}) => {
      if (options.method === "POST") { posts++; return null; }
      return path.includes("/pulls/") ? { state: "open", head: { sha: headSha } }
        : { workflow_runs: [{ ...run, conclusion: "success", run_started_at: "2026-10-15T21:39:00Z" }] };
    }
  });
  assert.equal(result.action, "rerun");
  assert.equal(posts, 1);
});

test("a push or closure during active waiting or just before requeue prevents rerun", async () => {
  for (const active of [false, true]) {
    for (const closed of [false, true]) {
      let headReads = 0;
      const result = await rerunCodexReviewForHead({
        token: "token", repository: "owner/repo", headSha, pullNumber: 1,
        sleep: async () => {},
        request: async (_token, _repo, path, options = {}) => {
          assert.notEqual(options.method, "POST");
          if (path.includes("/pulls/")) return ++headReads === 1
            ? { state: "open", head: { sha: headSha } }
            : { state: closed ? "closed" : "open", head: { sha: closed ? headSha : "a".repeat(40) } };
          return { workflow_runs: [{ ...run, status: active ? "in_progress" : "completed" }] };
        }
      });
      assert.equal(result.action, "stale");
    }
  }
});

test("active run polling is bounded", async () => {
  await assert.rejects(rerunCodexReviewForHead({
    token: "token", repository: "owner/repo", headSha, maxActiveRunPolls: 1,
    request: async () => ({ workflow_runs: [{ ...run, status: "in_progress" }] }),
    sleep: async () => {}
  }), /remained active/);
});

function executeGate({ body = receipt, threads = [], moveHead = false, failFinalHeadRead = false, reviews = [], reviewComments = [] } = {}) {
  const temporary = mkdtempSync(resolve(tmpdir(), "codex-gate-test-"));
  try {
    const marker = {
      id: 30, user: { login: "github-actions[bot]" }, created_at: requestedAt,
      body: createCodexReviewRequestMarkerBody({ headSha, requestId: "request", sourceCommentId: "29", sourceCommentCreatedAt: requestedAt, requestedAt })
    };
    const fixture = { headSha, comments: [marker, { ...comment, body }], threads, moveHead, failFinalHeadRead, reviews, reviewComments };
    writeFileSync(resolve(temporary, "mock.mjs"), `
      const fixture = ${JSON.stringify(fixture)};
      let pulls = 0;
      globalThis.fetch = async (url) => {
        let data;
        if (url.endsWith("/graphql")) data = {data:{repository:{pullRequest:{reviewThreads:{nodes:fixture.threads,pageInfo:{hasNextPage:false}}}}}};
        else if (url.includes("/issues/")) data = fixture.comments;
        else if (url.includes("/reviews?")) data = fixture.reviews;
        else if (url.includes("/comments?")) data = fixture.reviewComments;
        else {
          pulls++;
          if (fixture.failFinalHeadRead && pulls >= 4) throw new Error("Head API unavailable");
          data = {head:{sha:fixture.moveHead && pulls >= 4 ? "a".repeat(40) : fixture.headSha}};
        }
        return {ok:true,json:async()=>data};
      };
    `);
    return spawnSync(process.execPath, ["--import", resolve(temporary, "mock.mjs"), resolve(root, "scripts/codex-review-gate.mjs")], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "owner/repo", CODEX_REVIEW_PR_NUMBER: "1", CODEX_REVIEW_HEAD_SHA: headSha,
        CODEX_REVIEW_REQUIRE_HEAD_MATCH: "true", CODEX_REVIEW_WAIT_MS: "20", CODEX_REVIEW_POLL_MS: "1", CODEX_REVIEW_DEBOUNCE_MS: "0" }
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("actual gate accepts receipt but never treats an updated structured summary as evidence", () => {
  assert.equal(executeGate().status, 0);
  const result = executeGate({ body: structured });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /state: pending/);
});

test("actual gate rejects a push racing its successful evidence read", () => {
  const result = executeGate({ moveHead: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /head moved/);
});

test("an API error during the final head check cannot retain a successful verdict", () => {
  const result = executeGate({ failFinalHeadRead: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Head API unavailable/);
});

test("actual gate keeps unresolved findings across heads and request windows", () => {
  const author = { login: "chatgpt-codex-connector", __typename: "Bot" };
  const finding = { isResolved: false, comments: { nodes: [{ author, body: "P2 blocking finding" }] } };
  assert.equal(executeGate({ threads: [finding] }).status, 1);
  assert.equal(executeGate({ threads: [{ ...finding, isResolved: true }] }).status, 0);
  for (const body of ["P0 critical finding", "P1 urgent finding", "Unclassified finding"]) {
    assert.equal(executeGate({ threads: [{ ...finding, comments: { nodes: [{ author, body }] } }] }).status, 1);
  }
  assert.equal(executeGate({ threads: [{ ...finding, comments: { nodes: [{ author, body: "P3 advisory" }] } }] }).status, 0);
  assert.equal(executeGate({ threads: [{ ...finding, comments: { nodes: [{ author: { ...author, __typename: "User" }, body: "P2 spoofed" }] } }] }).status, 0);
  assert.equal(executeGate({ threads: [{ ...finding, comments: { nodes: [{ author: { ...author, login: "fake-codex" }, body: "P2 spoofed" }] } }] }).status, 0);
  assert.equal(executeGate({ reviews: [{ id: 20, commit_id: headSha, state: "COMMENTED", user, submitted_at: "2026-10-15T21:29:00Z" }],
    reviewComments: [{ pull_request_review_id: 20, user, body: "P2 finding before the latest request" }] }).status, 1);
});

test("the executable rerun entry point reads the live head for an edited old summary", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "codex-rerun-test-"));
  try {
    const event = { action: "edited", issue: { number: 1, pull_request: {} }, comment: {
      ...comment, body: structured, created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-15T22:00:00Z"
    } };
    writeFileSync(resolve(temporary, "event.json"), JSON.stringify(event));
    writeFileSync(resolve(temporary, "mock.mjs"), `
      globalThis.fetch = async (url, options = {}) => {
        let data;
        if (options.method === "POST") data = null;
        else if (url.includes("/pulls/")) data = {state:"open",head:{sha:"${headSha}"}};
        else {
          if (!url.includes("head_sha=${headSha}")) throw new Error("Requeue must select the live head");
          data = {workflow_runs:[${JSON.stringify({ ...run, run_started_at: "2026-10-15T21:59:00Z" })}]};
        }
        return {ok:true,text:async()=>JSON.stringify(data)};
      };
    `);
    const result = spawnSync(process.execPath, ["--import", resolve(temporary, "mock.mjs"), resolve(root, "scripts/codex-review-rerun.mjs")], {
      encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "owner/repo", GITHUB_EVENT_PATH: resolve(temporary, "event.json") }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Requested Codex Review rerun/,
      "updated_at, rather than the older created_at, must drive deduplication");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
