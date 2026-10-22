import { AUTO_CALL_COMMENT_COOLDOWN_MS, evaluateCallingLead } from "../../../shared/leadCallingPolicy.ts";
export { AUTO_CALL_COMMENT_COOLDOWN_MS } from "../../../shared/leadCallingPolicy.ts";
type AutoCallEligibilityLead = {
  status?: string;
  followUpAt?: Date | string | null;
  comments?: Array<{ authorName?: string; authorType?: string; createdAt?: Date | string | null }>;
  callsByEmployee?: Array<{ employeeName?: string; lastCallAt?: Date | string | null }>;
};

export function hasEmployeeCommentForAutoCall(
  lead: AutoCallEligibilityLead,
  _employeeNames: string[] = []
) {
  void _employeeNames;
  return (lead.comments || []).some((comment) => comment.authorType === "employee");
}

export function isLeadEligibleForAutoCall(
  lead: AutoCallEligibilityLead,
  now = new Date(),
  _employeeNames: string[] = []
) {
  void _employeeNames;
  return evaluateCallingLead(lead, now).callable;
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
