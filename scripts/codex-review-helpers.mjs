const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CODEX_REVIEW_LOGIN = "chatgpt-codex-connector[bot]";

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function compareNumericIds(left, right) {
  if (!/^\d+$/.test(String(left || "")) || !/^\d+$/.test(String(right || ""))) return 0;
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId === rightId ? 0 : leftId > rightId ? 1 : -1;
}

export function isStrictlyAfterCodexReviewRequest(value, requestMarker) {
  const valueTime = Date.parse(value || "");
  const requestedAt = Date.parse(
    requestMarker?.sourceCommentCreatedAt ||
    requestMarker?.requestedAt ||
    requestMarker?.commentCreatedAt ||
    ""
  );
  return Number.isFinite(valueTime) && Number.isFinite(requestedAt) && valueTime > requestedAt;
}

export function isTrustedAssociation(value) {
  return TRUSTED_ASSOCIATIONS.has(String(value || "").toUpperCase());
}

export function isCodexReviewCommand(body) {
  return /(?:^|\s)@codex\s+review\b/i.test(String(body || ""));
}

export function isCodexReviewCommandForHead(body, headSha) {
  const requestedHead = String(body || "").match(
    /(?:^|\s)@codex\s+review\s+`?([a-f0-9]{40})`?\b/i
  )?.[1];
  return Boolean(requestedHead) && normalize(requestedHead) === normalize(headSha);
}

export function isTrustedCodexLogin(login) {
  return normalize(login) === CODEX_REVIEW_LOGIN;
}

export function createCodexReviewRequestMarkerBody({
  headSha,
  requestId,
  sourceCommentId,
  sourceCommentCreatedAt,
  requestedAt
}) {
  const recordedAt = requestedAt || new Date().toISOString();
  return [
    `Codex review request recorded for \`${String(headSha || "").slice(0, 10)}\`.`,
    "",
    "<!-- web-design:codex-review-request",
    `CODEX_REVIEW_REQUEST_ID: ${requestId}`,
    `CODEX_REVIEW_SHA: ${headSha}`,
    `CODEX_REVIEW_SOURCE_COMMENT_ID: ${sourceCommentId}`,
    `CODEX_REVIEW_SOURCE_COMMENT_CREATED_AT: ${sourceCommentCreatedAt || recordedAt}`,
    `CODEX_REVIEW_REQUESTED_AT: ${recordedAt}`,
    "-->"
  ].join("\n");
}

export function extractCodexReviewRequestMarker(body) {
  const text = String(body || "");
  if (!text.includes("web-design:codex-review-request")) return null;

  const field = (name) =>
    text.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im"))?.[1]?.trim() || null;
  const requestId = field("CODEX_REVIEW_REQUEST_ID");
  const sha = field("CODEX_REVIEW_SHA");
  const sourceCommentId = field("CODEX_REVIEW_SOURCE_COMMENT_ID");
  const sourceCommentCreatedAt = field("CODEX_REVIEW_SOURCE_COMMENT_CREATED_AT");
  const requestedAt = field("CODEX_REVIEW_REQUESTED_AT");

  if (!requestId || !sha || !sourceCommentId || !requestedAt) return null;
  if (!/^[a-f0-9]{7,40}$/i.test(sha)) return null;

  return {
    requestId,
    sha,
    sourceCommentId,
    sourceCommentCreatedAt,
    requestedAt
  };
}

export function latestCodexReviewRequestMarker(comments = [], headSha) {
  return comments
    .map((comment) => {
      const marker = extractCodexReviewRequestMarker(comment?.body);
      if (!marker) return null;
      return {
        ...marker,
        commentId: String(comment.id || ""),
        commentCreatedAt: comment.created_at || null,
        author: normalize(comment.user?.login)
      };
    })
    .filter((marker) =>
      marker && marker.author === "github-actions[bot]" && marker.sha === headSha
    )
    .sort((left, right) => {
      const byRequestTime = Date.parse(right.sourceCommentCreatedAt || right.requestedAt || "") -
        Date.parse(left.sourceCommentCreatedAt || left.requestedAt || "");
      return byRequestTime || compareNumericIds(right.sourceCommentId, left.sourceCommentId);
    })[0] || null;
}

export function latestTrustedCodexReviewCommand(comments = [], timeline = [], headSha) {
  return comments
    .filter((comment) =>
      comment?.user?.type !== "Bot" &&
      isTrustedAssociation(comment?.author_association) &&
      isCodexReviewCommandForHead(comment?.body, headSha)
    )
    .sort((left, right) =>
      Date.parse(right.created_at || "") - Date.parse(left.created_at || "")
    )
    .map((comment) => ({
      requestId: `bootstrap-${comment.id}-${String(headSha).slice(0, 12)}`,
      sha: headSha,
      sourceCommentId: String(comment.id || ""),
      sourceCommentCreatedAt: comment.created_at,
      requestedAt: comment.created_at,
      commentCreatedAt: comment.created_at,
      bootstrap: true
    }))[0] || null;
}

export function extractCodexPriority(body) {
  const match = String(body || "").match(/\bP([0-3])\b/i);
  return match ? Number(match[1]) : null;
}

export function containsBlockingCodexSeverity(body) {
  return [...String(body || "").matchAll(/\bP([0-3])\b/gi)]
    .some((match) => Number(match[1]) <= 2);
}

export function classifyCodexNativeReview(review, reviewComments = [], headSha) {
  if (!review || review.commit_id !== headSha) return null;
  if (!isTrustedCodexLogin(review.user?.login)) return null;
  if (containsBlockingCodexSeverity(review.body)) return "fail";
  if (review.state === "CHANGES_REQUESTED") return "fail";

  const commentsForReview = reviewComments.filter((comment) =>
    comment.pull_request_review_id === review.id &&
    isTrustedCodexLogin(comment.user?.login)
  );
  if (commentsForReview.length > 0) {
    const priorities = commentsForReview.map((comment) => extractCodexPriority(comment.body));
    if (priorities.some((priority) => priority === null)) return "fail";
    if (Math.min(...priorities) <= 2) return "fail";
  }

  return review.state === "APPROVED" || review.state === "COMMENTED" ? "pass" : null;
}

export function codexNativeReviewResult(reviews = [], reviewComments = [], headSha) {
  const results = reviews
    .map((review) => classifyCodexNativeReview(review, reviewComments, headSha))
    .filter((result) => result !== null);
  if (results.length === 0) return null;
  // A later clean review does not clear an earlier blocking finding on the same
  // head: resolving a P0-P2 finding requires a code change, and that moves the
  // head SHA. Any fail for this exact head therefore keeps the gate closed.
  return results.includes("fail") ? "fail" : "pass";
}

export function codexNativeVerdictForHead(
  reviews = [],
  reviewComments = [],
  headSha,
  requestMarker
) {
  // Blocking findings are bound to the head, not to a request window. Repeating
  // "@codex review" for the same unchanged SHA opens a newer window, so scoping
  // the verdict to it would discard blockers recorded under an earlier marker.
  // Classification already requires review.commit_id === headSha, so evaluating
  // every review here stays head-bound.
  if (codexNativeReviewResult(reviews, reviewComments, headSha) === "fail") return "fail";

  const reviewsAfterRequest = reviews.filter((review) =>
    isStrictlyAfterCodexReviewRequest(review.submitted_at, requestMarker)
  );
  return codexNativeReviewResult(reviewsAfterRequest, reviewComments, headSha);
}

export function isAcceptableCodexSummaryComment(comment, headSha, requestedAt, sourceCommentId) {
  const body = String(comment?.body || "");
  // Keep the explicit legacy/receipt verdict. The mutable structured summary is
  // a wakeup signal only; its presence, status text, or reactions cannot pass.
  const receipt = body.replace(/^<!-- codex-review-receipt:v1 -->\s*/i, "");
  const content = receipt.replace(/\s*<details>[\s\S]*<\/details>\s*$/i, "").trim();
  const verdict = content.match(/^Codex Review:\s*Didn't find any major issues\.([^\n]*)\n\s*\*\*Reviewed commit:\*\*\s*`([a-f0-9]{10}|[a-f0-9]{40})`\s*$/i);
  if (!verdict || containsBlockingCodexSeverity(body)) return false;
  // Native receipts vary their congratulatory suffix (for example "Bravo.").
  // Keep that legacy flexibility without accepting an explicit contrary result.
  if (/\b(?:but|however|although|yet|found|issues?|findings?|unresolved|blocking|problems?|bugs?|errors?|failed|pending|running|incomplete)\b/i.test(verdict[1])) return false;
  if ((body.match(/codex-review-receipt:/gi) || []).length > 1 ||
      (body.match(/\*\*Reviewed commit:\*\*/gi) || []).length !== 1) return false;
  if (normalize(verdict[2]) !== normalize(String(headSha || "").slice(0, verdict[2].length))) return false;
  const shortSha = String(headSha || "").slice(0, 10);
  const commentCreatedAt = Date.parse(comment?.created_at || "");
  const requestTime = Date.parse(requestedAt || "");
  const ordering = commentCreatedAt === requestTime
    ? compareNumericIds(comment?.id, sourceCommentId) > 0
    : commentCreatedAt > requestTime;
  const isAfterRequest = !requestedAt ||
    (Number.isFinite(commentCreatedAt) && Number.isFinite(requestTime) && ordering);
  return isAfterRequest &&
    isTrustedCodexLogin(comment?.user?.login) &&
    /^Codex Review:\s*Didn't find any major issues\./im.test(body) &&
    Boolean(shortSha) &&
    new RegExp(`\\*\\*Reviewed commit:\\*\\*\\s*\\\`${verdict[2]}\\\``, "i").test(body);
}

export function hasUnresolvedCodexFindings(threads = []) {
  return threads.some((thread) => {
    const finding = thread.comments?.nodes?.[0];
    const author = finding?.author;
    // GraphQL Bot.login omits the REST API's [bot] suffix. Require the Bot
    // type before normalizing that representation to the trusted identity.
    const trusted = author?.__typename === "Bot" &&
      isTrustedCodexLogin(`${String(author.login || "").replace(/\[bot\]$/i, "")}[bot]`);
    if (thread.isResolved || !trusted) return false;
    const priority = extractCodexPriority(finding.body);
    return priority === null || priority <= 2;
  });
}
