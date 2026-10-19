export const dashboardViews = ["calls", "people", "performance", "activity", "attendance", "insights"] as const;
export type DashboardView = typeof dashboardViews[number];
export const dashboardViewLabels: Record<DashboardView, string> = {
    calls: "Calls", people: "People", performance: "Performance", activity: "Activity", attendance: "Attendance", insights: "Insights",
};
export function dashboardView(value: string | null): DashboardView {
    return dashboardViews.includes(value as DashboardView) ? value as DashboardView : "calls";
}
export function dashboardSectionView(name: string): DashboardView {
    if (["Agent Productivity", "Online Status"].includes(name)) return "people";
    if (name === "Employee Attendance") return "attendance";
    if (name === "Recent Lead Activity") return "activity";
    return "performance";
}
