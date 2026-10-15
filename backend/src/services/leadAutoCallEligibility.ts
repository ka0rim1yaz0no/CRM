type AutoCallEligibilityLead = {
  status?: string;
  followUpAt?: Date | string | null;
  comments?: Array<{ authorName?: string; authorType?: string; createdAt?: Date | string | null }>;
  callsByEmployee?: Array<{ employeeName?: string; lastCallAt?: Date | string | null }>;
};

export const AUTO_CALL_COMMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function isDueFollowUp(followUpAt: Date | string | null | undefined, now: Date) {
  if (!followUpAt) {
    return false;
  }

  const followUpTime = new Date(followUpAt).getTime();
  return Number.isFinite(followUpTime) && followUpTime <= now.getTime();
}

export function hasEmployeeCommentForAutoCall(
  lead: AutoCallEligibilityLead,
  _employeeNames: string[] = []
) {
  return (lead.comments || []).some((comment) => comment.authorType === "employee");
}

export function isLeadEligibleForAutoCall(
  lead: AutoCallEligibilityLead,
  now = new Date(),
  _employeeNames: string[] = []
) {
  if (lead.status !== "NEW" && lead.status !== "Follow up") {
    return false;
  }

  const followUpTime = new Date(lead.followUpAt || "").getTime();

  if (Number.isFinite(followUpTime) && followUpTime > now.getTime()) {
    return false;
  }

  const matchingComments = (lead.comments || []).filter((comment) => comment.authorType === "employee");
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

export function autoCallPhoneCandidates(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 7) return [];

  const candidates = new Set([digits]);
  if (digits.length === 11 && digits.startsWith("1")) candidates.add(digits.slice(1));
  if (digits.length > 10) candidates.add(digits.slice(-10));
  if (digits.length > 8) candidates.add(digits.slice(-8));
  return Array.from(candidates).filter((candidate) => candidate.length >= 7);
}

export function shouldBlockCommentedPhone(
  comments: Array<{ createdAt?: Date | string | null }>,
  followUpAt: Date | string | null | undefined,
  now = new Date()
) {
  if (comments.length === 0) return false;

  const commentTimes = comments.map((comment) => new Date(comment.createdAt || "").getTime());
  if (commentTimes.some((time) => !Number.isFinite(time))) return true;

  const followUpTime = new Date(followUpAt || "").getTime();
  const latestCommentTime = Math.max(...commentTimes);
  if (Number.isFinite(followUpTime) && followUpTime <= now.getTime() && followUpTime > latestCommentTime) {
    return false;
  }

  return latestCommentTime > now.getTime() - AUTO_CALL_COMMENT_COOLDOWN_MS;
}
