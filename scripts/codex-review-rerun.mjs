#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isTrustedCodexLogin } from "./codex-review-helpers.mjs";

const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending"
]);
const ACTIVE_RUN_POLL_INTERVAL_MS = 10_000;
const MAX_ACTIVE_RUN_POLLS = 24;

export function shouldRouteCodexReviewRerunEvent(event) {
  if (event?.review) return (!event.action || event.action === "submitted") &&
    isTrustedCodexLogin(event.review.user?.login);
  if (!event?.issue?.pull_request || !event?.comment) return false;
  if (event.action && !["created", "edited"].includes(event.action)) return false;
  // Routing is only a wakeup hint. Structured summary state is never a verdict.
  return /^(?:Codex Review:|<!-- codex-review-receipt:v1 -->|<!-- codex-pull-request-review-summary -->)/i.test(String(event.comment.body || "")) &&
    isTrustedCodexLogin(event.comment.user?.login);
}

export function selectCodexReviewRun(runs = [], headSha) {
  const matchingRuns = runs
    .filter((run) => run.event === "pull_request" && run.head_sha === headSha)
    .sort((left, right) =>
      Date.parse(right.created_at || "") - Date.parse(left.created_at || "")
    );

  const activeRun = matchingRuns.find((run) => ACTIVE_STATUSES.has(run.status));
  if (activeRun) return { action: "wait_for_active_then_rerun", run: activeRun };

  const rerunnableRun = matchingRuns.find((run) => run.status === "completed");
  if (rerunnableRun) return { action: "rerun", run: rerunnableRun };

  return { action: "not_found", run: null };
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function defaultRequest(token, repository, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function rerunCodexReviewForHead({
  token,
  repository,
  headSha,
  pullNumber,
  evidenceUpdatedAt,
  request = defaultRequest,
  sleep = defaultSleep,
  maxActiveRunPolls = MAX_ACTIVE_RUN_POLLS
}) {
  if (!token || !repository || !headSha) {
    throw new Error("token, repository, and headSha are required to rerun Codex Review.");
  }

  const [owner, repo] = repository.split("/");
  async function headIsCurrent() {
    if (!pullNumber) return true;
    const pull = await request(token, repository, `/repos/${owner}/${repo}/pulls/${pullNumber}`);
    return pull.state === "open" && pull.head?.sha === headSha;
  }
  const staleResult = { action: "stale", run: null, message: `PR head moved or closed; no rerun for ${headSha}.` };
  if (!await headIsCurrent()) return staleResult;
  const runsPath = `/repos/${owner}/${repo}/actions/workflows/codex-review.yml/runs?event=pull_request&head_sha=${encodeURIComponent(headSha)}&per_page=100`;
  let data = await request(token, repository, runsPath);
  let selected = selectCodexReviewRun(data.workflow_runs || [], headSha);

  for (let poll = 0; selected.action === "wait_for_active_then_rerun" && poll < maxActiveRunPolls; poll += 1) {
    await sleep(ACTIVE_RUN_POLL_INTERVAL_MS);
    if (!await headIsCurrent()) return staleResult;
    data = await request(token, repository, runsPath);
    selected = selectCodexReviewRun(data.workflow_runs || [], headSha);
  }

  if (selected.action === "wait_for_active_then_rerun") {
    throw new Error(
      `Codex Review run ${selected.run.id} remained active while waiting to evaluate new trusted evidence for ${headSha}.`
    );
  }

  if (selected.action === "rerun") {
    // Serialized receipt/summary events can refer to evidence already evaluated
    // by the preceding rerun. A newer edit still triggers a new evaluation.
    if (Date.parse(selected.run.run_started_at || "") > Date.parse(evidenceUpdatedAt || "")) {
      return { ...selected, action: "already_evaluated", message: `Codex Review already evaluated evidence for ${headSha}.` };
    }
    if (!await headIsCurrent()) return staleResult;
    await request(
      token,
      repository,
      `/repos/${owner}/${repo}/actions/runs/${selected.run.id}/rerun`,
      { method: "POST" }
    );
    return {
      ...selected,
      message: `Requested Codex Review rerun for ${headSha} from run ${selected.run.id}.`
    };
  }

  const runId = selected.run?.id ? ` run ${selected.run.id}` : "";
  const messages = {
    not_found: `No completed Codex Review pull_request run found for ${headSha}.`
  };
  return { ...selected, message: messages[selected.action] };
}

async function resolveHeadSha({ token, repository, event, request = defaultRequest }) {
  const pullNumber = event?.pull_request?.number || (event?.issue?.pull_request && event.issue.number);
  if (!pullNumber) {
    throw new Error("Could not resolve pull request from event.");
  }
  const [owner, repo] = repository.split("/");
  const pull = await request(
    token,
    repository,
    `/repos/${owner}/${repo}/pulls/${pullNumber}`
  );
  return { headSha: pull.head?.sha, pullNumber };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !repository || !eventPath) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_EVENT_PATH are required.");
  }

  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  if (!shouldRouteCodexReviewRerunEvent(event)) {
    console.log("Codex Review rerun skipped: event is not trusted Codex evidence.");
    return;
  }

  const { headSha, pullNumber } = await resolveHeadSha({ token, repository, event });
  const evidenceUpdatedAt = event.comment?.updated_at || event.comment?.created_at || event.review?.submitted_at;
  const result = await rerunCodexReviewForHead({ token, repository, headSha, pullNumber, evidenceUpdatedAt });
  console.log(result.message);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`Codex Review rerun failed: ${error.message}`);
    process.exit(1);
  }
}
