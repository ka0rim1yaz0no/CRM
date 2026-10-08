type AutoCallEligibilityLead = {
  status?: string;
  followUpAt?: Date | string | null;
  comments?: Array<{ authorName?: string; authorType?: string; createdAt?: Date | string | null }>;
  callsByEmployee?: Array<{ employeeName?: string; lastCallAt?: Date | string | null }>;
};

export const AUTO_CALL_COMMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function normalizeName(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function isDueFollowUp(followUpAt: Date | string | null | undefined, now: Date) {
  if (!followUpAt) {
    return false;
  }

  const followUpTime = new Date(followUpAt).getTime();
  return Number.isFinite(followUpTime) && followUpTime <= now.getTime();
}

export function hasEmployeeCommentForAutoCall(
  lead: AutoCallEligibilityLead,
  employeeNames: string[] = []
) {
  const normalizedEmployeeNames = new Set(employeeNames.map(normalizeName).filter(Boolean));

  return (lead.comments || []).some((comment) => {
    if (comment.authorType !== "employee") {
      return false;
    }

    return normalizedEmployeeNames.size === 0 || normalizedEmployeeNames.has(normalizeName(comment.authorName));
  });
}

export function isLeadEligibleForAutoCall(
  lead: AutoCallEligibilityLead,
  now = new Date(),
  employeeNames: string[] = []
) {
  if (lead.status !== "NEW" && lead.status !== "Follow up") {
    return false;
  }

  const followUpTime = new Date(lead.followUpAt || "").getTime();

  if (Number.isFinite(followUpTime) && followUpTime > now.getTime()) {
    return false;
  }

  const normalizedEmployeeNames = new Set(employeeNames.map(normalizeName).filter(Boolean));
  const matchingComments = (lead.comments || []).filter((comment) => {
    if (comment.authorType !== "employee") {
      return false;
    }

    return normalizedEmployeeNames.size === 0 || normalizedEmployeeNames.has(normalizeName(comment.authorName));
  });
  const commentTimes = matchingComments
    .map((comment) => new Date(comment.createdAt || "").getTime())
    .filter(Number.isFinite);

  if (commentTimes.length === 0) {
    return matchingComments.length === 0;
  }

  if (matchingComments.some((comment) => !Number.isFinite(new Date(comment.createdAt || "").getTime()))) {
    return false;
  }

  const latestCommentTime = Math.max(...commentTimes);

  if (
    lead.status === "Follow up" &&
    isDueFollowUp(lead.followUpAt, now) &&
    Number.isFinite(followUpTime) &&
    latestCommentTime < followUpTime
  ) {
    return true;
  }

  return latestCommentTime <= now.getTime() - AUTO_CALL_COMMENT_COOLDOWN_MS;
}
