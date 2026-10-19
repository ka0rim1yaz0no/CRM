const personalFields = ["personalPhone", "personalEmail", "personalAddress", "emergencyContact", "contactRelationship", "emergencyContactNumber", "personalNotes", "bankName", "bankAccountName", "bankAccountNumber"] as const;
export function profileCompleteness(profile: Partial<Record<typeof personalFields[number], string>>) {
  const filled = personalFields.filter((field) => profile[field]?.trim()).length;
  return { filled, total: personalFields.length, percent: Math.round(filled / personalFields.length * 100) };
}
export function maskBankNumber(value = "") {
  if (!value) return "";
  return value.length <= 4 ? "*".repeat(value.length) : `${"*".repeat(Math.min(8, value.length - 4))} ${value.slice(-4)}`;
}
export function profileDayKey(value: Date | string) {
  const at = new Date(value); if (!Number.isFinite(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
export function profileActivityDay(value: string, now = new Date()) {
  const day = profileDayKey(value); if (!day) return "Date unavailable";
  if (day === profileDayKey(now)) return "Today";
  if (day === profileDayKey(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}
export function tenureLabel(hired?: string | null, now = new Date()) {
  if (!hired) return "";
  const start = /^\d{4}-\d{2}-\d{2}$/.test(hired) ? hired : profileDayKey(hired);
  const end = profileDayKey(now); if (!start || !end || start > end || !Number.isFinite(Date.parse(start)) || new Date(start).toISOString().slice(0, 10) !== start) return "";
  const [year, month, day] = start.split("-").map(Number); const [ey, em, ed] = end.split("-").map(Number);
  const months = Math.max(0, (ey - year) * 12 + em - month - Number(ed < day));
  return months >= 12 ? `${Math.floor(months / 12)} yr${months >= 24 ? "s" : ""} ${months % 12} mo${months % 12 === 1 ? "" : "s"}` : months ? `${months} mo${months === 1 ? "" : "s"}` : "Less than a month";
}
export function colorContrast(first: string, second: string) {
  const luminance = (hex: string) => { const rgb = hex.replace("#", ""); const values = [0, 2, 4].map((offset) => parseInt(rgb.slice(offset, offset + 2), 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return values[0] * .2126 + values[1] * .7152 + values[2] * .0722; };
  const a = luminance(first); const b = luminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
export function blendColor(foreground: string, background: string, opacity: number) {
  const channels = [0, 2, 4].map((offset) => Math.round(parseInt(foreground.slice(offset + 1, offset + 3), 16) * opacity + parseInt(background.slice(offset + 1, offset + 3), 16) * (1 - opacity)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
