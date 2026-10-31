/** Check GitHub review approvals without accepting stale or truncated results. */
type JsonRecord = Record<string, unknown>;

function object(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value as JsonRecord;
}

export function parseCurrentHumanApproval(json: string, head: string): boolean {
  const response = object(JSON.parse(json) as unknown, "GitHub response");
  const data = object(response.data, "GitHub data");
  const repo = object(data.repository, "GitHub repository");
  const pr = object(repo.pullRequest, "GitHub pull request");
  const author = object(pr.author, "PR author");
  if (typeof author.login !== "string") throw new Error("invalid PR author login");
  const authorLogin = author.login.toLowerCase();
  const connection = object(pr.latestOpinionatedReviews, "latest reviews");
  const page = object(connection.pageInfo, "review page");
  if (!Array.isArray(connection.nodes) || !Number.isSafeInteger(connection.totalCount)) {
    throw new Error("invalid latest reviews");
  }
  if (page.hasNextPage !== false || connection.nodes.length !== connection.totalCount) {
    throw new Error("incomplete latest reviews");
  }
  return connection.nodes.some((raw: unknown) => {
    const review = object(raw, "review");
    if (review.state !== "APPROVED" || review.author === null || review.commit === null)
      return false;
    const reviewer = object(review.author, "review author");
    const commit = object(review.commit, "review commit");
    return (
      reviewer.__typename === "User" &&
      typeof reviewer.login === "string" &&
      !reviewer.login.toLowerCase().endsWith("[bot]") &&
      reviewer.login.toLowerCase() !== authorLogin &&
      commit.oid === head
    );
  });
}
