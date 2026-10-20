export type DataCheckSection = "Attendance" | "Calls" | "Leads" | "Consistency";
export type DataCheckStatus = "match" | "mismatch" | "cannot-verify";
export type DataCheckSample = { recordId: string; employeeCode: string; timestamp: string };
export type DataCheckRow = {
  id: string; section: DataCheckSection; business: string; label: string;
  dashboardValue: number | string | null; recomputedValue: number | string | null;
  difference: number | null; status: DataCheckStatus; explanation: string;
  proof: "independent" | "same-code, weaker proof"; samples: DataCheckSample[]; warningOnly?: boolean;
};
export type DataCheckReport = {
  date: string; business: string; generatedAt: string; expiresAt: string; cached: boolean;
  verdict: "PASS" | "WARN" | "FAIL"; counts: Record<DataCheckStatus, number>; checks: DataCheckRow[];
  businesses: Array<{ id: string; name: string }>; boundaryProof: string;
};

export function dataCheckVerdict(rows: DataCheckRow[]) {
  return rows.some(row => row.status === "mismatch" && !row.warningOnly) ? "FAIL" :
    rows.some(row => row.status !== "match") ? "WARN" : "PASS";
}
export function dataCheckCsv(report: DataCheckReport) {
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
  };
  return [["Shift date", "Business", "Section", "Check", "Status", "Dashboard", "Recomputed", "Difference", "Proof", "Explanation"],
    ...report.checks.filter(row => row.status === "mismatch").map(row => [report.date, row.business, row.section, row.label, row.status, row.dashboardValue, row.recomputedValue, row.difference, row.proof, row.explanation])]
    .map(row => row.map(cell).join(",")).join("\r\n");
}
export function dataCheckText(report: DataCheckReport) {
  return [`Data Check ${report.verdict}`, `Shift: ${report.date}; business: ${report.business}; as of: ${report.generatedAt}`,
    ...report.checks.map(row => `${row.status.toUpperCase()} | ${row.business} | ${row.label} | dashboard=${row.dashboardValue ?? "unavailable"} | recomputed=${row.recomputedValue ?? "unavailable"} | difference=${row.difference ?? "n/a"} | ${row.proof}\n${row.explanation}`)].join("\n");
}
