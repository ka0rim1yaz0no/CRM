export type RingCentralClassificationConfidence = "high" | "probable" | "needs_review";
export type RingCentralClassificationOutcome = "connected" | "not_connected" | "voicemail" | "unclassified";

export type RingCentralCallClassification = {
  outcome: RingCentralClassificationOutcome;
  confidence: RingCentralClassificationConfidence;
  reason: string;
};

const voicemailStatuses = new Set(["VOICEMAIL", "VOICEMAILSCREENING"]);
const notConnectedStatuses = new Set([
  "BUSY",
  "CANCELLED",
  "DECLINED",
  "FAILED",
  "MISSED",
  "NOANSWER",
  "NOTCONNECTED",
  "REJECTED",
  "UNAVAILABLE",
]);
const terminalStatuses = new Set(["DISCONNECTED", "GONE"]);

function normalizeStatus(value: unknown) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizedStatuses(values: unknown[]) {
  return new Set(values.map(normalizeStatus).filter(Boolean));
}

function resultIncludes(result: string, patterns: string[]) {
  return patterns.some((pattern) => result.includes(pattern));
}

function normalizeTranscript(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchingPatterns(value: string, patterns: RegExp[]) {
  return patterns.filter((pattern) => pattern.test(value));
}

const voicemailTranscriptPatterns = [
  /\bvoicemail\b/,
  /\bvoice mail\b/,
  /\bleave (?:me |us |a )?message\b/,
  /\b(?:after|at) the (?:tone|beep)\b/,
  /\brecord (?:your|a) message\b/,
  /\bmailbox\b/,
  /\b(?:is|are) (?:not available|unavailable)\b/,
  /\bcannot take your call\b/,
  /\bcan't take your call\b/,
  /\bcall has been forwarded\b/,
];

const automatedTranscriptPatterns = [
  /\bplease (?:hold|stay|remain) (?:on )?(?:the )?line\b/,
  /\bnext available (?:agent|representative|clerk|operator)\b/,
  /\bcall will be (?:answered|handled)\b/,
  /\bhandled in the order\b/,
  /\boperating hours\b/,
  /\bmenu options?\b/,
  /\bpress (?:one|two|three|four|five|six|seven|eight|nine|zero|\d)\b/,
  /\bto repeat (?:this|these|the) (?:message|menu|options?)\b/,
  /\bfor english\b/,
];

export function isRingCentralOutcomeShadowEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.RINGCENTRAL_OUTCOME_SHADOW_MODE || "").trim().toLowerCase()
  );
}

export function classifyRingCentralCall(input: {
  statusCodes?: unknown[];
  providerResult?: unknown;
  answeredAt?: Date | string | null;
}): RingCentralCallClassification {
  const statuses = normalizedStatuses(input.statusCodes || []);
  const result = normalizeStatus(input.providerResult);
  const voicemailDetected = [...statuses].some((status) => voicemailStatuses.has(status))
    || resultIncludes(result, ["VOICEMAIL", "VOICEMAILSCREENING"]);

  if (voicemailDetected) {
    return {
      outcome: "voicemail",
      confidence: "high",
      reason: "RingCentral reported a voicemail state.",
    };
  }

  const notConnectedDetected = [...statuses].some((status) => notConnectedStatuses.has(status))
    || resultIncludes(result, ["NOANSWER", "NOTCONNECTED", "BUSY", "REJECTED", "FAILED", "CANCELLED"]);

  if (notConnectedDetected) {
    return {
      outcome: "not_connected",
      confidence: "high",
      reason: "RingCentral reported a no-answer or failed-call result.",
    };
  }

  const answered = Boolean(input.answeredAt)
    || statuses.has("ANSWERED")
    || resultIncludes(result, ["ANSWERED", "ACCEPTED", "CONNECTED"]);

  if (answered) {
    return {
      outcome: "unclassified",
      confidence: "needs_review",
      reason: "The call was answered, but call events alone cannot prove whether a person or voicemail answered.",
    };
  }

  const terminal = [...statuses].some((status) => terminalStatuses.has(status));
  if (terminal) {
    return {
      outcome: "not_connected",
      confidence: "probable",
      reason: "The call ended without an answered or voicemail event.",
    };
  }

  return {
    outcome: "unclassified",
    confidence: "needs_review",
    reason: "RingCentral did not provide enough call-state evidence to classify this call.",
  };
}

export function classifyRingCentralRecording(input: {
  transcript?: unknown;
  durationSeconds?: unknown;
}): RingCentralCallClassification {
  const transcript = normalizeTranscript(input.transcript);
  const words = transcript.split(/\s+/).filter(Boolean);
  const voicemailMatches = matchingPatterns(transcript, voicemailTranscriptPatterns);
  const automatedMatches = matchingPatterns(transcript, automatedTranscriptPatterns);

  if (voicemailMatches.length > 0) {
    return {
      outcome: "voicemail",
      confidence: "high",
      reason: "The RingCentral recording contains a clear voicemail greeting or message prompt.",
    };
  }

  if (automatedMatches.length >= 2) {
    return {
      outcome: "voicemail",
      confidence: "high",
      reason: "The RingCentral recording contains multiple automated IVR or hold-system prompts.",
    };
  }

  if (automatedMatches.length === 1) {
    return {
      outcome: "voicemail",
      confidence: "probable",
      reason: "The RingCentral recording contains an automated IVR or hold-system prompt.",
    };
  }

  const helloCount = (transcript.match(/\b(?:hello|hi)\b/g) || []).length;
  const liveGreeting = /\b(?:hello|hi|good morning|good afternoon|thank you for calling)\b/.test(transcript);
  const liveResponse = /\b(?:speaking|how can i help|how may i help|who is this|yes this is|yeah|yes)\b/.test(transcript);

  if (helloCount >= 2 || (liveGreeting && liveResponse) || (liveGreeting && words.length >= 8)) {
    return {
      outcome: "connected",
      confidence: "probable",
      reason: "The RingCentral recording contains a live conversational greeting without voicemail or IVR prompts.",
    };
  }

  if (words.length === 0 || transcript === "this call is being recorded") {
    return {
      outcome: "not_connected",
      confidence: "probable",
      reason: "The RingCentral recording did not contain an intelligible response from the called party.",
    };
  }

  return {
    outcome: "connected",
    confidence: "probable",
    reason: "The RingCentral recording contains intelligible speech without a voicemail or automated-system prompt.",
  };
}
