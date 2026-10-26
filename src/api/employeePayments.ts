import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";
import { getActiveBusinessId } from "./businessStorage";
import type { EmployeePayments } from "../../shared/employeePayments";
import { savedPayrollPeriod, isConfiguredSavedPayrollPeriod } from "../../shared/payrollPeriod";

export async function getEmployeePayments(employeeId: string, businessId: string, page = 1, signal?: AbortSignal, view: "current" | "history" = "current") {
    const auth = getAuthUser();
    if (auth?.userType !== "employee" || auth.user._id !== employeeId || !auth.attendanceHubSession ||
        !businessId || getActiveBusinessId() !== businessId) throw new Error("Sign in again to view payments.");
    const session = auth.attendanceHubSession;
    const config = {
        params: { page, view }, signal, timeout: 15000,
        headers: { "X-Business-Id": businessId, "X-CRM-Admin-Session": "", "X-CRM-Attendance-Session": session, "Cache-Control": "no-store" },
    };
    const ensureCurrent = () => {
        const current = getAuthUser();
        if (current?.userType !== "employee" || current.user._id !== employeeId || current.attendanceHubSession !== session ||
            getActiveBusinessId() !== businessId) throw new Error("Payment session changed. Refresh payments.");
    };
    const { data } = await api.get<EmployeePayments>(`/employees/${encodeURIComponent(employeeId)}/payments`, config);
    ensureCurrent();
    if (data.business.id !== businessId) throw new Error("Payment session changed. Refresh payments.");
    if (data.view === view) return data;
    // Compatibility with the live read API allows a frontend-only rollout without restarting calls.
    const { data: settings } = await api.get("/system-settings", { ...config, params: {} }); ensureCurrent();
    const all = [...data.items], pages = Math.ceil(data.total / data.pageSize);
    for (let otherPage = 1; otherPage <= pages; otherPage++) {
        if (otherPage === data.page) continue;
        const next = await api.get<EmployeePayments>(`/employees/${encodeURIComponent(employeeId)}/payments`, { ...config, params: { page: otherPage, view } });
        ensureCurrent(); if (next.data.business.id !== businessId) throw new Error("Payment session changed. Refresh payments.");
        all.push(...next.data.items);
    }
    const currentPeriod = savedPayrollPeriod(data.currentPayPeriod);
    const filtered = all.filter(item => {
        const period = savedPayrollPeriod(item.payPeriod);
        return period && data.historyFrom && period.start >= data.historyFrom && isConfiguredSavedPayrollPeriod(period, settings) &&
            (view === "history" || currentPeriod && period.start === currentPeriod.start && period.end === currentPeriod.end);
    });
    return { ...data, view, page, total: filtered.length, items: filtered.slice((page - 1) * data.pageSize, page * data.pageSize) };
}
