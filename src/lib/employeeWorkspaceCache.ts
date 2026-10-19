import type { QueryClient } from "@tanstack/react-query";

export function refreshAttendanceWorkspace(client: QueryClient) {
    // Tenant copies have different employee IDs. Invalidate views, never copy one tenant's payload into another.
    return Promise.all(["attendance-session", "employee-attendance", "employee-dashboard-attendance",
        "attendance-hub", "attendance-hub-day", "attendance-hub-live", "employees-attendance"].map((key) =>
        client.invalidateQueries({ queryKey: [key] })));
}

export function refreshEmployeeWorkspace(client: QueryClient, employeeId: string) {
    for (const key of ["employee", "employee-profile", "employee-dashboard-profile", "employee-dashboard-attendance", "employee-recent-activity",
        "employee-dashboard-tasks", "employee-dashboard-lead-counts", "employee-dashboard-lead-queue", "employee-notices"]) {
        void client.invalidateQueries({ queryKey: [key, employeeId] });
    }
    for (const key of ["attendance-session", "employee-attendance"]) {
        void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === key && query.queryKey[2] === employeeId });
    }
    for (const key of ["employee-dashboard-lead-logs", "employee-dashboard-announcements", "employee-agent-lead-dashboard"]) {
        void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === key && query.queryKey[2] === employeeId });
    }
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "lead-call-summary" && query.queryKey[1] === "me" && query.queryKey[2] === employeeId });
}
