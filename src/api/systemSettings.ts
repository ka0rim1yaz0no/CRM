import { api } from "../lib/api";
import type { ThemeKey } from "../lib/themes";
import { getAuthUser } from "./authStorage";

export type CurrencyCode = "USD" | "PHP" | "EUR" | "GBP" | "JPY";
export type PayrollBillingCycle = "Monthly" | "Semi-monthly" | "Weekly";

export type SystemSettings = {
    _id: string;
    key: "system";
    currencyCode: CurrencyCode;
    payrollBillingCycle: PayrollBillingCycle;
    payrollRunDay: number;
    payrollFirstCutoffStartDay: number;
    payrollFirstCutoffEndDay: number;
    payrollFirstCutoffPayDay: number;
    payrollSecondCutoffStartDay: number;
    payrollSecondCutoffEndDay: number;
    payrollSecondCutoffPayDay: number;
    autoAssignLeadsEnabled: boolean;
    adminLeadMiniTabsEnabled: boolean;
    employeeLeadMiniTabsEnabled: boolean;
    trackerClearDataEnabled: boolean;
    officialShiftStartTime: string;
    officialShiftEndTime: string;
    officialFirstBreakStartTime: string;
    officialFirstBreakEndTime: string;
    officialLunchBreakStartTime: string;
    officialLunchBreakEndTime: string;
    officialSecondBreakStartTime: string;
    officialSecondBreakEndTime: string;
    attendanceTimeZone: string;
    lateGraceMinutes: number;
    themeKey: ThemeKey;
};

export const currencyOptions: Array<{ code: CurrencyCode; label: string; symbol: string }> = [
    { code: "USD", label: "US Dollar", symbol: "$" },
    { code: "PHP", label: "Philippine Peso", symbol: "₱" },
    { code: "EUR", label: "Euro", symbol: "€" },
    { code: "GBP", label: "British Pound", symbol: "£" },
    { code: "JPY", label: "Japanese Yen", symbol: "¥" },
];

export const payrollBillingCycleOptions: PayrollBillingCycle[] = ["Semi-monthly", "Weekly"];
export const attendanceTimeZoneOptions = [
    { value: "Asia/Manila", label: "Philippines (Asia/Manila)" },
    { value: "America/Chicago", label: "Central Time (America/Chicago)" },
    { value: "Asia/Taipei", label: "Taiwan (Asia/Taipei)" },
    { value: "America/New_York", label: "Eastern Time (America/New_York)" },
    { value: "America/Los_Angeles", label: "Pacific Time (America/Los_Angeles)" },
    { value: "UTC", label: "UTC" },
];

export async function getSystemSettings() {
    const response = await api.get<SystemSettings>("/system-settings");
    return response.data;
}

export async function updateSystemSettings(
    settings: Partial<Pick<SystemSettings, "currencyCode" | "payrollBillingCycle" | "payrollRunDay" | "payrollFirstCutoffStartDay" |
    "payrollFirstCutoffEndDay" | "payrollFirstCutoffPayDay" | "payrollSecondCutoffStartDay" | "payrollSecondCutoffEndDay" |
    "payrollSecondCutoffPayDay" | "autoAssignLeadsEnabled" | "adminLeadMiniTabsEnabled" | "employeeLeadMiniTabsEnabled" |
    "trackerClearDataEnabled" | "officialShiftStartTime" | "officialShiftEndTime" | "officialFirstBreakStartTime" |
    "officialFirstBreakEndTime" | "officialLunchBreakStartTime" | "officialLunchBreakEndTime" | "officialSecondBreakStartTime" |
    "officialSecondBreakEndTime" | "attendanceTimeZone" | "lateGraceMinutes" | "themeKey">>
) {
    const auth = getAuthUser();
    const response = await api.put<SystemSettings>("/system-settings", settings, { headers: { "X-CRM-Admin-Session": auth?.userType === "admin" ? auth.sessionToken || "" : "" } });
    return response.data;
}
