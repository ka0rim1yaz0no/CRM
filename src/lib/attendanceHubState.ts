export function attendanceHubFilters(params: URLSearchParams) {
    return { preset: params.get("preset") || "last-7-days", from: params.get("from") || undefined,
        to: params.get("to") || undefined, business: params.get("business") || undefined, employee: params.get("employee") || undefined,
        team: params.get("team") || undefined, role: params.get("role") || undefined, issue: params.get("issue") || undefined,
        sort: params.get("sort") || "date", direction: params.get("direction") || "desc", page: Number(params.get("page") || 1), pageSize: 25 };
}
export function attendanceHubFilterChange(params: URLSearchParams, key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page");
    return next;
}
export function attendanceServerNow(serverTime: string, receivedAt: number, localNow: number) {
    return Date.parse(serverTime) + Math.max(0, localNow - receivedAt);
}
