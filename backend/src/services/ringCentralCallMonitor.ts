type LegacyExtension = {
  id?: string;
  extensionNumber?: string;
  name?: string;
  contact?: { email?: string; firstName?: string; lastName?: string };
};

type LegacyEmployee = {
  employeeName: string;
  email: string;
  personalEmail: string;
  phone: string;
};

type LegacyParty = { extensionId?: string; status?: { code?: string } };

export type RingCentralSessionAction = {
  extensionId: string;
  action: "add" | "remove";
};

const activeStatusCodes = new Set(["SETUP", "PROCEEDING", "ANSWERED", "HOLD", "PARKED", "VOICEMAIL", "VOICEMAILSCREENING"]);
const terminalStatusCodes = new Set(["DISCONNECTED", "GONE"]);

function normalizeText(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

export function parseRingCentralExtensionMap(rawValue: string) {
  const value = String(rawValue || "").trim();
  if (!value) return new Map<string, string>();
  try {
    if (value.startsWith("{")) {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return new Map(Object.entries(parsed)
        .map(([employeeCode, extension]) => [employeeCode.trim(), String(extension || "").trim()] as const)
        .filter(([employeeCode, extension]) => Boolean(employeeCode && extension)));
    }
  } catch {
    return new Map<string, string>();
  }
  return new Map(value.split(/[,;\n]+/)
    .map((entry) => entry.split("=").map((part) => part.trim()))
    .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
    .map(([employeeCode, extension]) => [employeeCode, extension] as const));
}

export function isRingCentralActiveStatus(value: unknown) {
  return activeStatusCodes.has(String(value || "").trim().toUpperCase());
}

export function isRingCentralTerminalStatus(value: unknown) {
  return terminalStatusCodes.has(String(value || "").trim().toUpperCase());
}

export function isRingCentralSubscriptionAck(
  metadata: { type?: string; messageId?: string; status?: number },
  expectedMessageId: string
) {
  return (metadata.type === "ClientResponse" || metadata.type === "ClientRequest")
    && metadata.messageId === expectedMessageId;
}

export function resolveRingCentralSessionActions(
  parties: LegacyParty[],
  mappedExtensionIds: ReadonlySet<string>,
  trackedExtensionIds: ReadonlySet<string>
) {
  const actions = new Map<string, RingCentralSessionAction["action"]>();
  let recognizedMappedStatus = false;
  for (const party of parties) {
    const extensionId = String(party.extensionId || "").trim();
    if (!extensionId || !mappedExtensionIds.has(extensionId)) continue;
    if (isRingCentralTerminalStatus(party.status?.code)) actions.set(extensionId, "remove");
    else if (isRingCentralActiveStatus(party.status?.code)) actions.set(extensionId, "add");
    else continue;
    recognizedMappedStatus = true;
  }
  const statuses = parties.map((party) => String(party.status?.code || "").trim()).filter(Boolean);
  if (!recognizedMappedStatus && statuses.length > 0 && statuses.every(isRingCentralTerminalStatus)) {
    trackedExtensionIds.forEach((extensionId) => actions.set(extensionId, "remove"));
  }
  return [...actions].map(([extensionId, action]) => ({ extensionId, action }));
}

export function findRingCentralExtension(employee: LegacyEmployee, extensions: LegacyExtension[], explicitTarget: string) {
  if (explicitTarget) {
    const explicit = extensions.find((extension) => extension.id === explicitTarget || extension.extensionNumber === explicitTarget);
    if (explicit) return explicit;
  }
  const emails = new Set([normalizeText(employee.email), normalizeText(employee.personalEmail)].filter(Boolean));
  const emailMatches = extensions.filter((extension) => emails.has(normalizeText(extension.contact?.email)));
  if (emailMatches.length === 1) return emailMatches[0];
  const nameMatches = extensions.filter((extension) => normalizeText(
    extension.name || [extension.contact?.firstName, extension.contact?.lastName].filter(Boolean).join(" ")
  ) === normalizeText(employee.employeeName));
  if (nameMatches.length === 1) return nameMatches[0];
  const phoneMatches = extensions.filter((extension) => normalizePhone(extension.extensionNumber) === normalizePhone(employee.phone));
  return phoneMatches.length === 1 ? phoneMatches[0] : null;
}

export function startRingCentralCallMonitor() {
  console.log("RingCentral integration removed; Nextiva Call Bridge is the only call provider.");
}

export function getRingCentralMonitorStatus(_employeeCode = "") {
  return {
    configured: false,
    connected: false,
    mapped: false,
    lastError: "RingCentral integration has been removed.",
    deviceName: "",
    extensionId: "",
    extensionNumber: "",
  };
}
