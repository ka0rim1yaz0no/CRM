export function uniqueDashboardRows<T extends { employeeId: string }>(rows: T[], codeFor: (row: T) => string) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const code = codeFor(row).trim();
    const identity = code ? `code:${code}` : `id:${row.employeeId}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
