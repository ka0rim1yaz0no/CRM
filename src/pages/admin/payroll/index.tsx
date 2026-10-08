import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    FiBriefcase,
    FiCheck,
    FiCheckCircle,
    FiChevronDown,
    FiChevronLeft,
    FiChevronRight,
    FiClock,
    FiCreditCard,
    FiDownload,
    FiEdit2,
    FiFileText,
    FiFilter,
    FiPlus,
    FiPrinter,
    FiRotateCcw,
    FiSearch,
    FiArchive,
    FiTarget,
    FiUsers,
    FiX,
} from "react-icons/fi";
import AdminLayout from "../adminLayout";
import {
    archivePayrollItem,
    archivePayrollRecord,
    createPayrollItem,
    getPayrollDtr,
    getPayrollItems,
    getPayrollRecords,
    getPayrollStats,
    markPayrollRecordPaid,
    markPayrollRecordUnpaid,
    restorePayrollItem,
    restorePayrollRecord,
    runPayroll,
    updatePayrollOvertime,
    updateEmployeeBasicPay,
    type PayrollItemCategory,
    type PayrollDtrRow,
    type PayrollListItem,
    type PayrollRecord,
    type PayrollStatus,
} from "../../../api/payroll";
import { getEmployees, updateEmployeeBankDetails, type Employee } from "../../../api/employees";
import { getSystemSettings, type SystemSettings } from "../../../api/systemSettings";
import { DataTableSortHeader } from "../../../components/admin/DataTable";
import { formatCurrency } from "../../../lib/currency";

const payrollTabs = ["Employee Payroll", "Bank Accounts", "Payouts", "Deductions", "Tax Settings", "Archived"] as const;
const payrollNavigation = [
    { tab: "Employee Payroll", icon: FiUsers, description: "Employee pay runs" },
    { tab: "Bank Accounts", icon: FiCreditCard, description: "Payout details" },
    { tab: "Payouts", icon: FiTarget, description: "Payment batches" },
    { tab: "Deductions", icon: FiBriefcase, description: "Employee deductions" },
    { tab: "Tax Settings", icon: FiFileText, description: "Payroll tax rules" },
    { tab: "Archived", icon: FiArchive, description: "Restorable records" },
] as const;
const statusOptions: PayrollStatus[] = ["Pending", "Paid", "Failed", "Completed", "Review", "Applied", "Enabled"];

const emptyBankForm = {
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
};

const emptyItemForm = {
    name: "",
    second: "",
    third: "",
    fourth: "",
    status: "Pending" as PayrollStatus,
};

const statusClass: Record<string, string> = {
    Paid: "bg-emerald-400/10 text-emerald-200",
    Pending: "bg-white/[0.06] text-white/55",
    Failed: "bg-red-500/15 text-red-200",
    Completed: "bg-sky-400/10 text-sky-100",
    Review: "bg-yellow-400/10 text-yellow-100/85",
    Applied: "bg-violet-400/10 text-violet-100",
    Enabled: "bg-emerald-400/10 text-emerald-200",
};

function payrollItemFieldLabels(category: PayrollItemCategory) {
    if (category === "Deductions") {
        return {
            name: "Deduction",
            second: "Amount",
            third: "Description",
            fourth: "Frequency",
        };
    }

    return {
        name: category === "Tax Settings" ? "Setting" : "Name",
        second: category === "Tax Settings" ? "Status" : "Scope",
        third: category === "Tax Settings" ? "Description" : "Amount",
        fourth: category === "Tax Settings" ? "Updated" : "Detail",
    };
}

function StatusBadge({ status }: { status: string }) {
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${statusClass[status] || "bg-white/[0.06] text-white/55"}`}>
            <span className="size-1.5 rounded-full bg-current" />
            {status}
        </span>
    );
}

function dtrStatusClass(status: PayrollDtrRow["status"]) {
    if (status === "Overtime") return "border-violet-300 bg-violet-50 text-violet-700";
    if (status === "In Progress") return "border-sky-300 bg-sky-50 text-sky-700";
    if (status === "Needs Review") return "border-orange-300 bg-orange-50 text-orange-700";
    if (status === "Late") return "border-rose-300 bg-rose-50 text-rose-700";
    if (status === "Present") return "border-emerald-300 bg-emerald-50 text-emerald-700";
    if (status === "Weekend") return "border-slate-300 bg-slate-100 text-slate-600";
    return "border-amber-300 bg-amber-50 text-amber-700";
}

function formatHoursMinutes(value = 0) {
    const totalMinutes = Math.round(Math.max(Number(value) || 0, 0) * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (!hours && !minutes) return "0m";
    if (!hours) return `${minutes}m`;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDays(value = 0) {
    const days = Math.max(Number(value) || 0, 0);
    return `${days} ${days === 1 ? "day" : "days"}`;
}

const numberWordsUnderTwenty = [
    "Zero",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
];
const numberWordsTens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

type PayslipCutoffOption = {
    value: string;
    label: string;
    payDate: string;
};

function formatPeriodDate(date: Date) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function parsePayPeriodStart(payPeriod = "") {
    const weekly = payPeriod.match(/^Week of ([A-Za-z]+ \d{1,2}, \d{4})$/);
    if (weekly) {
        const parsedWeek = new Date(weekly[1]);
        return Number.isNaN(parsedWeek.getTime()) ? null : parsedWeek;
    }

    const range = payPeriod.match(/^([A-Za-z]+ \d{1,2}, \d{4})\s+-\s+([A-Za-z]+ \d{1,2}, \d{4})$/);
    const parsed = range ? new Date(range[1]) : new Date(payPeriod);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sanitizeCutoffDay(value: number | undefined, fallback: number) {
    return Math.min(Math.max(Math.round(value ?? fallback), 1), 31);
}

function payrollCutoffOption(year: number, month: number, startDay: number, endDay: number, payDay: number): PayslipCutoffOption {
    const crossesMonth = startDay > endDay;
    const start = new Date(year, month, clampCalendarDay(startDay, year, month));
    const endMonth = crossesMonth ? month + 1 : month;
    const end = new Date(year, endMonth, clampCalendarDay(endDay, year, endMonth));
    const payDateMonth = payDay < end.getDate() ? end.getMonth() + 1 : end.getMonth();
    const payDate = new Date(end.getFullYear(), payDateMonth, clampCalendarDay(payDay, end.getFullYear(), payDateMonth));
    const value = `${formatPeriodDate(start)} - ${formatPeriodDate(end)}`;
    return { value, label: value, payDate: formatPeriodDate(payDate) };
}

function semiMonthlyPayrollOptions(year: number, month: number, settings?: SystemSettings) {
    return [
        payrollCutoffOption(
            year,
            month,
            sanitizeCutoffDay(settings?.payrollFirstCutoffStartDay, 6),
            sanitizeCutoffDay(settings?.payrollFirstCutoffEndDay, 20),
            sanitizeCutoffDay(settings?.payrollFirstCutoffPayDay, 25)
        ),
        payrollCutoffOption(
            year,
            month,
            sanitizeCutoffDay(settings?.payrollSecondCutoffStartDay, 21),
            sanitizeCutoffDay(settings?.payrollSecondCutoffEndDay, 5),
            sanitizeCutoffDay(settings?.payrollSecondCutoffPayDay, 10)
        ),
    ];
}

function weeklyCutoffOptions(reference: Date, weeks = 8): PayslipCutoffOption[] {
    const start = new Date(reference);
    start.setDate(reference.getDate() - reference.getDay() + 1);

    return Array.from({ length: weeks }, (_, index) => {
        const weekStart = new Date(start);
        weekStart.setDate(start.getDate() - index * 7);
        const value = `Week of ${formatPeriodDate(weekStart)}`;
        const payDate = new Date(weekStart);
        payDate.setDate(weekStart.getDate() + 6);

        return { value, label: value, payDate: formatPeriodDate(payDate) };
    });
}

function monthsBetween(newer: Date, older: Date) {
    return Math.max(0, (newer.getFullYear() - older.getFullYear()) * 12 + newer.getMonth() - older.getMonth());
}

function weeksBetween(newer: Date, older: Date) {
    const millisecondsPerWeek = 7 * 24 * 60 * 60 * 1000;
    return Math.max(0, Math.ceil((newer.getTime() - older.getTime()) / millisecondsPerWeek));
}

function payslipCutoffOptions(record: PayrollRecord | null, settings?: SystemSettings, selectedPeriod = ""): PayslipCutoffOption[] {
    const basePeriod = record?.payPeriod || "";
    const selectedReference = parsePayPeriodStart(selectedPeriod);
    const baseReference = parsePayPeriodStart(basePeriod) || selectedReference || new Date();
    const oldestReference = selectedReference && selectedReference < baseReference ? selectedReference : baseReference;
    const baseReferenceTime = baseReference.getTime();
    const selectedValue = selectedPeriod || basePeriod;
    const options =
        settings?.payrollBillingCycle === "Weekly"
            ? weeklyCutoffOptions(baseReference, Math.max(52, weeksBetween(baseReference, oldestReference) + 8))
            : Array.from({ length: Math.max(24, monthsBetween(baseReference, oldestReference) + 8) }, (_, index) => {
                  const month = new Date(baseReference.getFullYear(), baseReference.getMonth() - index, 1);
                  return semiMonthlyPayrollOptions(month.getFullYear(), month.getMonth(), settings);
              })
                  .flat()
                  .filter((option) => (parsePayPeriodStart(option.value)?.getTime() || 0) <= baseReferenceTime)
                  .sort((first, second) => parsePayPeriodStart(second.value)!.getTime() - parsePayPeriodStart(first.value)!.getTime());
    const uniqueOptions = Array.from(new Map(options.map((option) => [option.value, option])).values());
    const selectedOption = uniqueOptions.find((option) => option.value === selectedValue);

    if (selectedValue && !selectedOption) {
        const currentOption = { value: selectedValue, label: selectedValue, payDate: record?.paidOn || "-" };
        return [currentOption, ...uniqueOptions];
    }

    return uniqueOptions;
}

function numberToWords(value: number): string {
    const wholeValue = Math.max(0, Math.floor(value));

    if (wholeValue < 20) return numberWordsUnderTwenty[wholeValue];
    if (wholeValue < 100) {
        const tens = Math.floor(wholeValue / 10);
        const remainder = wholeValue % 10;
        return `${numberWordsTens[tens]}${remainder ? ` ${numberWordsUnderTwenty[remainder]}` : ""}`;
    }
    if (wholeValue < 1000) {
        const hundreds = Math.floor(wholeValue / 100);
        const remainder = wholeValue % 100;
        return `${numberWordsUnderTwenty[hundreds]} Hundred${remainder ? ` ${numberToWords(remainder)}` : ""}`;
    }
    if (wholeValue < 1000000) {
        const thousands = Math.floor(wholeValue / 1000);
        const remainder = wholeValue % 1000;
        return `${numberToWords(thousands)} Thousand${remainder ? ` ${numberToWords(remainder)}` : ""}`;
    }

    const millions = Math.floor(wholeValue / 1000000);
    const remainder = wholeValue % 1000000;
    return `${numberToWords(millions)} Million${remainder ? ` ${numberToWords(remainder)}` : ""}`;
}

function countWeekdays(start: Date, end: Date) {
    let days = 0;
    const cursor = new Date(start);

    while (cursor < end) {
        const day = cursor.getDay();
        if (day !== 0 && day !== 6) days += 1;
        cursor.setDate(cursor.getDate() + 1);
    }

    return days;
}

function clampCalendarDay(day: number, year: number, month: number) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    return Math.min(Math.max(Math.round(day || 15), 1), lastDay);
}

function workingDaysForPayPeriod(payPeriod: string, fallback = 0, cutoffDay = 15) {
    const explicitRange = payPeriod.match(/^([A-Za-z]+ \d{1,2}, \d{4})\s+-\s+([A-Za-z]+ \d{1,2}, \d{4})$/);
    if (explicitRange) {
        const start = new Date(explicitRange[1]);
        const end = new Date(explicitRange[2]);
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
            end.setDate(end.getDate() + 1);
            return countWeekdays(start, end);
        }
    }

    const monthPeriod = payPeriod.match(/^([A-Za-z]+)\s+(\d{4})(?:\s+(\d+)-(End|\d+))?$/);
    if (monthPeriod) {
        const month = monthNames.indexOf(monthPeriod[1].toLowerCase());
        const year = Number(monthPeriod[2]);
        if (month >= 0 && Number.isFinite(year)) {
            const lastDay = new Date(year, month + 1, 0).getDate();
            if (monthPeriod[3]) {
                const startDay = clampCalendarDay(Number(monthPeriod[3]), year, month);
                const endDay = monthPeriod[4] === "End" ? lastDay : clampCalendarDay(Number(monthPeriod[4]), year, month);
                if (monthPeriod[4] !== "End" && startDay > endDay) {
                    return countWeekdays(new Date(year, month - 1, startDay), new Date(year, month, endDay + 1));
                }
                return countWeekdays(new Date(year, month, startDay), new Date(year, month, endDay + 1));
            }

            const cutoff = clampCalendarDay(cutoffDay, year, month);
            return countWeekdays(new Date(year, month, 1), new Date(year, month, cutoff + 1));
        }
    }

    const weekPeriod = payPeriod.match(/^Week of (.+)$/);
    if (weekPeriod) {
        const start = new Date(weekPeriod[1]);
        if (!Number.isNaN(start.getTime())) {
            const end = new Date(start);
            end.setDate(start.getDate() + 7);
            return countWeekdays(start, end);
        }
    }

    return fallback;
}

function PayslipDocument({
    record,
    money,
    payrollRunDay,
}: {
    record: PayrollRecord;
    money: (value?: number) => string;
    payrollRunDay?: number;
}) {
    const payDate = record.paidOn && record.paidOn !== "-" ? record.paidOn : new Date().toLocaleDateString("en-US");
    const attendanceDays = record.attendanceDays ?? 0;
    const workingDays = record.workingDays ?? workingDaysForPayPeriod(record.payPeriod, attendanceDays, payrollRunDay);
    const absentDays = record.absentDays ?? Math.max(workingDays - attendanceDays, 0);
    const lateHours = record.lateHours ?? 0;
    const overtimeHours = record.overtimeHours ?? 0;
    const basePay = record.basicPay ?? record.grossPay;
    const minuteRate = record.minuteRate ?? (workingDays > 0 ? (basePay * 2) / workingDays / 8 / 60 : 0);
    const hourlyRate = minuteRate * 60;
    const overtimePay = Math.max(0, Math.round((record.grossPay - basePay) * 100) / 100);
    const deductionMinutes = [
        { label: "Late", minutes: record.lateMinutes ?? Math.round(lateHours * 60) },
        { label: "Excess lunch", minutes: record.excessLunchMinutes ?? 0 },
        { label: "Excess break", minutes: record.excessBreakMinutes ?? 0 },
        { label: "Undertime", minutes: record.earlyTimeOutMinutes ?? 0 },
        { label: "Absence", minutes: record.absenceMinutes ?? 0 },
    ];
    const totalDeductionMinutes = deductionMinutes.reduce((sum, item) => sum + item.minutes, 0);
    const lastDeductionIndex = deductionMinutes.reduce((last, item, index) => item.minutes > 0 ? index : last, -1);
    let allocatedDeductions = 0;
    const deductionRows = deductionMinutes.map((item, index) => {
        const amount = totalDeductionMinutes === 0
            ? 0
            : index === lastDeductionIndex
                ? Math.round((record.deductions - allocatedDeductions) * 100) / 100
                : Math.round((record.deductions * item.minutes / totalDeductionMinutes) * 100) / 100;
        allocatedDeductions += amount;
        return { ...item, amount };
    });

    return (
        <div className="payslip-print bg-white p-8 text-[11px] leading-tight text-slate-950">
            <div className="overflow-hidden rounded-xl border border-slate-300">
                <div className="flex items-start justify-between gap-6 bg-slate-950 px-6 py-5 text-[#ffffff]">
                    <div>
                        <p className="text-[0.62rem] font-semibold uppercase tracking-[0.24em] text-[#ddd6fe]">Assistly Payroll</p>
                        <h1 className="mt-2 text-2xl font-bold tracking-tight text-[#ffffff]">Payslip</h1>
                        <p className="mt-2 max-w-[18rem] text-[0.68rem] leading-5 text-[#e5e7eb]">P2 33 Purok 5 Bakakeng Norte, Baguio City Philippines</p>
                    </div>
                    <div className="min-w-[11rem] rounded-lg border border-white/15 bg-white/10 p-4 text-right">
                        <p className="text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-[#cbd5e1]">Net Pay</p>
                        <p className="mt-2 text-xl font-bold text-[#ffffff]">{money(record.netPay)}</p>
                        <p className="mt-1 text-[0.68rem] text-[#e5e7eb]">{record.payPeriod}</p>
                    </div>
                </div>

                <div className="grid grid-cols-3 border-b border-slate-300 bg-slate-50">
                    {[
                        ["Employee", record.employeeName],
                        ["Employee ID", record.employeeId],
                        ["Department", record.department || "-"],
                        ["Pay Type", record.payType],
                        ["Pay Date", payDate],
                        ["Pay Period", record.payPeriod],
                    ].map(([label, value]) => (
                        <div key={label} className="border-r border-t border-slate-300 px-4 py-3 first:border-t-0">
                            <p className="text-[0.58rem] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
                            <p className="mt-1 font-semibold text-slate-950">{value}</p>
                        </div>
                    ))}
                </div>

                <div className="grid grid-cols-3 gap-3 border-b border-slate-300 px-6 py-4">
                    {[
                        ["Working Days", String(workingDays)],
                        ["Days Present", String(attendanceDays)],
                        ["Absent", formatDays(absentDays)],
                        ["Late", `${record.lateMinutes ?? Math.round(lateHours * 60)} min`],
                        ["Approved OT Hours", formatHoursMinutes(overtimeHours)],
                        ["Hourly Rate", money(hourlyRate)],
                    ].map(([label, value]) => (
                        <div key={label} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
                            <p className="text-[0.58rem] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
                            <p className="mt-1 text-lg font-bold text-slate-950">{value}</p>
                        </div>
                    ))}
                </div>

                <div className="grid grid-cols-2 gap-5 px-6 py-5">
                    <table className="w-full border-collapse text-[11px]">
                        <thead>
                            <tr className="bg-emerald-50 text-emerald-950">
                                <th className="border border-emerald-200 px-3 py-2 text-left font-bold">Earnings</th>
                                <th className="border border-emerald-200 px-3 py-2 text-right font-bold">Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td className="border border-slate-200 px-3 py-2">Basic Pay</td>
                                <td className="border border-slate-200 px-3 py-2 text-right font-semibold">{money(basePay || record.grossPay)}</td>
                            </tr>
                            {overtimePay > 0 && (
                                <tr>
                                    <td className="border border-slate-200 px-3 py-2">Approved OT Pay ({formatHoursMinutes(overtimeHours)})</td>
                                    <td className="border border-slate-200 px-3 py-2 text-right font-semibold">{money(overtimePay)}</td>
                                </tr>
                            )}
                            <tr className="bg-slate-50">
                                <td className="border border-slate-200 px-3 py-2 font-bold">Total Earnings</td>
                                <td className="border border-slate-200 px-3 py-2 text-right font-bold">{money(record.grossPay)}</td>
                            </tr>
                        </tbody>
                    </table>

                    <table className="w-full border-collapse text-[11px]">
                        <thead>
                            <tr className="bg-rose-50 text-rose-950">
                                <th className="border border-rose-200 px-3 py-2 text-left font-bold">Deductions</th>
                                <th className="border border-rose-200 px-3 py-2 text-right font-bold">Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            {deductionRows.map((item) => (
                                <tr key={item.label}>
                                    <td className="border border-slate-200 px-3 py-2">{item.label} ({item.minutes} min)</td>
                                    <td className="border border-slate-200 px-3 py-2 text-right font-semibold">{money(item.amount)}</td>
                                </tr>
                            ))}
                            <tr className="bg-slate-50">
                                <td className="border border-slate-200 px-3 py-2 font-bold">Total Deductions ({record.deductibleMinutes ?? 0} min)</td>
                                <td className="border border-slate-200 px-3 py-2 text-right font-bold">{money(record.deductions)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div className="mx-6 mb-5 rounded-lg border border-violet-200 bg-violet-50 px-5 py-4">
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <p className="text-[0.58rem] font-bold uppercase tracking-[0.16em] text-violet-700">Amount in words</p>
                            <p className="mt-1 font-semibold text-slate-950">{numberToWords(record.netPay)} only</p>
                        </div>
                        <div className="text-right">
                            <p className="text-[0.58rem] font-bold uppercase tracking-[0.16em] text-violet-700">Net Pay</p>
                            <p className="mt-1 text-lg font-bold text-slate-950">{money(record.netPay)}</p>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-12 px-6 pb-7 pt-4 text-center">
                    <div>
                        <div className="mx-auto h-12 w-44 border-b border-slate-900" />
                        <p className="mt-2 font-semibold">Employer Signature</p>
                    </div>
                    <div>
                        <div className="mx-auto h-12 w-44 border-b border-slate-900" />
                        <p className="mt-2 font-semibold">Employee Signature</p>
                    </div>
                </div>
            </div>

            <p className="mt-4 text-center text-[0.65rem] font-medium text-slate-500">This is a system generated payslip.</p>
        </div>
    );
}

function ArchivedPanel({
    title,
    rows,
    isLoading,
    isError,
    emptyText,
}: {
    title: string;
    rows: Array<{
        id: string;
        primary: string;
        secondary: string;
        detail: string;
        status: PayrollStatus;
        onRestore: () => void;
    }>;
    isLoading: boolean;
    isError: boolean;
    emptyText: string;
}) {
    return (
        <section className="overflow-hidden rounded-lg border border-white/10 bg-[#090b13]/80 shadow-2xl shadow-black/20">
            <div className="flex min-h-14 items-center justify-between border-b border-white/10 px-5">
                <div>
                    <h3 className="text-base font-semibold text-white">{title}</h3>
                    <p className="mt-1 text-xs text-white/40">Restore archived records back to active payroll.</p>
                </div>
            </div>
            <div className="content-scroll max-h-[calc(100vh-24rem)] overflow-auto">
                {isLoading && <p className="px-5 py-5 text-sm text-white/45">Loading archived records...</p>}
                {isError && <p className="px-5 py-5 text-sm text-red-200">Unable to load archived records.</p>}
                {!isLoading && !isError && rows.length === 0 && <p className="px-5 py-5 text-sm text-white/45">{emptyText}</p>}
                {!isLoading && !isError && rows.length > 0 && (
                    <div className="divide-y divide-white/10">
                        {rows.map((row) => (
                            <article key={row.id} className="flex items-center justify-between gap-4 px-5 py-4 text-sm transition hover:bg-white/[0.035]">
                                <div className="min-w-0">
                                    <p className="truncate font-semibold text-white">{row.primary}</p>
                                    <p className="mt-1 truncate text-xs text-white/45">{row.secondary}</p>
                                    <p className="mt-1 truncate text-xs text-white/55">{row.detail || "No details"}</p>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    <StatusBadge status={row.status} />
                                    <button
                                        className="inline-flex h-9 items-center gap-2 rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-3 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-300/15"
                                        type="button"
                                        onClick={row.onRestore}
                                    >
                                        <FiRotateCcw className="size-4" aria-hidden="true" />
                                        Restore
                                    </button>
                                </div>
                            </article>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}

export default function PayrollPage() {
    const queryClient = useQueryClient();
    const [activeTab, setActiveTab] = useState<(typeof payrollTabs)[number]>("Employee Payroll");
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("All statuses");
    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const [sortBy, setSortBy] = useState("employeeId");
    const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
    const [pageSize, setPageSize] = useState(10);
    const [page, setPage] = useState(1);
    const [dtrRecord, setDtrRecord] = useState<PayrollRecord | null>(null);
    const [payslipRecord, setPayslipRecord] = useState<PayrollRecord | null>(null);
    const [payslipCutoffPeriod, setPayslipCutoffPeriod] = useState("");
    const [isPayslipCutoffOpen, setIsPayslipCutoffOpen] = useState(false);
    const payslipCutoffPickerRef = useRef<HTMLDivElement | null>(null);
    const [itemModalOpen, setItemModalOpen] = useState(false);
    const [itemForm, setItemForm] = useState(emptyItemForm);
    const [deleteTarget, setDeleteTarget] = useState<{ type: "record"; record: PayrollRecord } | { type: "item"; item: PayrollListItem } | null>(null);
    const [paymentTarget, setPaymentTarget] = useState<{ action: "paid" | "unpaid"; record: PayrollRecord } | null>(null);
    const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
    const [bankEditEmployee, setBankEditEmployee] = useState<Employee | null>(null);
    const [bankForm, setBankForm] = useState(emptyBankForm);
    const [basicPayTarget, setBasicPayTarget] = useState<PayrollRecord | null>(null);
    const [basicPayInput, setBasicPayInput] = useState("");

    const itemCategory = activeTab === "Employee Payroll" || activeTab === "Bank Accounts" || activeTab === "Archived" ? undefined : (activeTab as PayrollItemCategory);

    const recordQueryParams = {
        search,
        status: statusFilter === "All statuses" ? undefined : statusFilter,
        sortBy,
        sortDir,
        archived: activeTab === "Archived",
    };

    const { data: stats } = useQuery({ queryKey: ["payroll-stats"], queryFn: getPayrollStats });
    const { data: systemSettings } = useQuery({ queryKey: ["system-settings"], queryFn: getSystemSettings });
    const { data: employees = [], isLoading: isPayrollLoading, isError: isPayrollError } = useQuery({
        queryKey: ["payroll-records", recordQueryParams],
        queryFn: () => getPayrollRecords(recordQueryParams),
        enabled: activeTab === "Employee Payroll" || activeTab === "Archived",
    });
    const { data: employeeDtr, isLoading: isDtrLoading, isError: isDtrError } = useQuery({
        queryKey: ["payroll-dtr", dtrRecord?.employeeId, dtrRecord?.payPeriod],
        queryFn: () => getPayrollDtr(dtrRecord?.employeeId || "", dtrRecord?.payPeriod),
        enabled: Boolean(dtrRecord?.employeeId),
    });
    const { data: payslipDtr, isLoading: isPayslipDtrLoading } = useQuery({
        queryKey: ["payroll-payslip-dtr", payslipRecord?.employeeId, payslipCutoffPeriod],
        queryFn: () => getPayrollDtr(payslipRecord?.employeeId || "", payslipCutoffPeriod),
        enabled: Boolean(payslipRecord?.employeeId && payslipCutoffPeriod),
    });
    const { data: payrollItems = [], isLoading: areItemsLoading, isError: areItemsError } = useQuery({
        queryKey: ["payroll-items", itemCategory],
        queryFn: () => getPayrollItems(itemCategory),
        enabled: Boolean(itemCategory),
    });
    const { data: archivedPayrollItems = [], isLoading: areArchivedItemsLoading, isError: areArchivedItemsError } = useQuery({
        queryKey: ["payroll-items", "archived"],
        queryFn: () => getPayrollItems(undefined, { archived: true }),
        enabled: activeTab === "Archived",
    });

    const refreshPayroll = () => {
        queryClient.invalidateQueries({ queryKey: ["payroll-records"] });
        queryClient.invalidateQueries({ queryKey: ["payroll-items"] });
        queryClient.invalidateQueries({ queryKey: ["payroll-stats"] });
    };

    const { data: bankEmployees = [], isLoading: areBankEmployeesLoading } = useQuery({
        queryKey: ["employees", "payroll-bank"],
        queryFn: getEmployees,
        enabled: activeTab === "Bank Accounts",
    });

    const payslipCutoffs = useMemo(() => payslipCutoffOptions(payslipRecord, systemSettings, payslipCutoffPeriod), [payslipCutoffPeriod, payslipRecord, systemSettings]);
    const selectedPayslipCutoff = useMemo(
        () => payslipCutoffs.find((option) => option.value === payslipCutoffPeriod),
        [payslipCutoffPeriod, payslipCutoffs]
    );
    const payslipPreviewRecord = useMemo<PayrollRecord | null>(() => {
        if (!payslipRecord) return null;
        if (!payslipDtr) return { ...payslipRecord, payPeriod: payslipCutoffPeriod || payslipRecord.payPeriod };

        return {
            ...payslipRecord,
            department: payslipDtr.employee.department,
            payType: payslipDtr.payType,
            grossPay: payslipDtr.summary.grossPay,
            deductions: payslipDtr.summary.deductions,
            netPay: payslipDtr.summary.netPay,
            attendanceDays: payslipDtr.summary.attendanceDays,
            absentDays: payslipDtr.summary.absentDays,
            absentHours: payslipDtr.summary.absentHours,
            lateDays: payslipDtr.summary.lateDays,
            lateHours: payslipDtr.summary.lateHours,
            workedHours: payslipDtr.summary.workedHours,
            overtimeHours: payslipDtr.summary.overtimeHours,
            scheduledHours: payslipDtr.summary.scheduledHours,
            basicPay: payslipDtr.summary.basicPay,
            workingDays: payslipDtr.summary.monthlyWorkingDays,
            minuteRate: payslipDtr.summary.minuteRate,
            lateMinutes: payslipDtr.summary.lateMinutes,
            excessLunchMinutes: payslipDtr.summary.excessLunchMinutes,
            excessBreakMinutes: payslipDtr.summary.excessBreakMinutes,
            absenceMinutes: payslipDtr.summary.absenceMinutes,
            earlyTimeOutMinutes: payslipDtr.summary.earlyTimeOutMinutes,
            deductibleMinutes: payslipDtr.summary.deductibleMinutes,
            paidOn: payslipDtr.payDate,
            payPeriod: payslipDtr.payPeriod,
        };
    }, [payslipCutoffPeriod, payslipDtr, payslipRecord]);
    const markPaidMutation = useMutation({ mutationFn: markPayrollRecordPaid, onSuccess: refreshPayroll });
    const markUnpaidMutation = useMutation({ mutationFn: markPayrollRecordUnpaid, onSuccess: refreshPayroll });
    const updateOvertimeMutation = useMutation({
        mutationFn: ({ id, overtimeHours }: { id: string; overtimeHours: number }) => updatePayrollOvertime(id, overtimeHours),
        onSuccess: (record) => {
            refreshPayroll();
            setDtrRecord(record);
        },
    });
    const updateBasicPayMutation = useMutation({
        mutationFn: ({ employeeId, basicPay }: { employeeId: string; basicPay: number }) => updateEmployeeBasicPay(employeeId, basicPay),
        onSuccess: () => {
            refreshPayroll();
            setBasicPayTarget(null);
            setBasicPayInput("");
        },
    });
    const archiveRecordMutation = useMutation({ mutationFn: archivePayrollRecord, onSuccess: () => { refreshPayroll(); closeDeletePrompt(); } });
    const restoreRecordMutation = useMutation({ mutationFn: restorePayrollRecord, onSuccess: refreshPayroll });
    const runPayrollMutation = useMutation({ mutationFn: runPayroll, onSuccess: refreshPayroll });
    const createItemMutation = useMutation({
        mutationFn: createPayrollItem,
        onSuccess: () => {
            refreshPayroll();
            setItemModalOpen(false);
            setItemForm(emptyItemForm);
        },
    });
    const archiveItemMutation = useMutation({ mutationFn: archivePayrollItem, onSuccess: () => { refreshPayroll(); closeDeletePrompt(); } });
    const restoreItemMutation = useMutation({ mutationFn: restorePayrollItem, onSuccess: refreshPayroll });
    const updateBankMutation = useMutation({
        mutationFn: ({ employee, bank }: { employee: Employee; bank: typeof emptyBankForm }) => updateEmployeeBankDetails(employee._id, bank),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["employees"] });
            setBankEditEmployee(null);
            setBankForm(emptyBankForm);
        },
    });
    const money = (value = 0) => formatCurrency(value, systemSettings?.currencyCode || "USD");
    const itemLabels = itemCategory ? payrollItemFieldLabels(itemCategory) : null;

    const totalPages = Math.max(Math.ceil(employees.length / pageSize), 1);
    const visibleEmployees = useMemo(() => employees.slice((page - 1) * pageSize, page * pageSize), [employees, page, pageSize]);
    const visibleEmployeeIds = visibleEmployees.map((employee) => employee._id);
    const selectedRecordIdSet = new Set(selectedRecordIds);
    const areAllVisibleSelected = visibleEmployeeIds.length > 0 && visibleEmployeeIds.every((id) => selectedRecordIdSet.has(id));

    const payrollStats = [
        { label: "Employees", value: String(stats?.totalEmployees ?? employees.length), icon: FiUsers },
        { label: "Gross", value: money(stats?.totalPayroll ?? 0), icon: FiBriefcase },
        { label: "Deductions", value: money(stats?.totalDeductions ?? 0), icon: FiTarget },
        { label: "Net", value: money(stats?.netPayroll ?? 0), icon: FiCreditCard },
        { label: "Paid", value: String(stats?.paidEmployees ?? 0), icon: FiCheckCircle },
    ];

    const changeSort = (field: string) => {
        setSortBy((current) => {
            if (current === field) {
                setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
                return current;
            }
            setSortDir("asc");
            return field;
        });
    };

    const saveItem = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!itemCategory || !itemForm.name.trim()) return;

        createItemMutation.mutate({
            category: itemCategory,
            ...itemForm,
            fourth: itemCategory === "Deductions" ? itemForm.fourth || "Every payroll" : itemForm.fourth,
            status: itemCategory === "Deductions" && itemForm.status === "Pending" ? "Applied" : itemForm.status,
        });
    };

    const openItemModal = () => {
        setItemForm(itemCategory === "Deductions" ? { ...emptyItemForm, fourth: "Every payroll", status: "Applied" } : emptyItemForm);
        setItemModalOpen(true);
    };

    const exportCsv = () => {
        const header = ["Employee", "Email", "Employee ID", "Department", "Pay Type", "Days", "Absent Days", "Absent Time", "Late Days", "Late Time", "Worked Hours", "Approved OT Hours", "Gross Pay", "Deductions", "Net Pay", "Status", "Paid On", "Pay Period"];
        const rows = employees.map((employee) => [
            employee.employeeName,
            employee.email,
            employee.employeeId,
            employee.department,
            employee.payType,
            employee.attendanceDays || 0,
            employee.absentDays || 0,
            formatHoursMinutes(employee.absentHours || 0),
            employee.lateDays || 0,
            formatHoursMinutes(employee.lateHours || 0),
            employee.workedHours || 0,
            employee.overtimeHours || 0,
            employee.grossPay,
            employee.deductions,
            employee.netPay,
            employee.status,
            employee.paidOn,
            employee.payPeriod,
        ]);
        const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "payroll.csv";
        link.click();
        URL.revokeObjectURL(url);
    };

    const openDeletePrompt = (target: typeof deleteTarget) => {
        setDeleteTarget(target);
    };

    const closeDeletePrompt = () => {
        setDeleteTarget(null);
    };

    const confirmDelete = () => {
        if (!deleteTarget) return;
        if (deleteTarget.type === "record") archiveRecordMutation.mutate(deleteTarget.record._id);
        if (deleteTarget.type === "item") archiveItemMutation.mutate(deleteTarget.item._id);
    };

    const confirmPaymentStatus = () => {
        if (!paymentTarget) return;

        if (paymentTarget.action === "paid") {
            markPaidMutation.mutate(paymentTarget.record._id, { onSuccess: () => setPaymentTarget(null) });
            return;
        }

        markUnpaidMutation.mutate(paymentTarget.record._id, { onSuccess: () => setPaymentTarget(null) });
    };

    const toggleAllVisibleRecords = () => {
        setSelectedRecordIds((current) => {
            const currentIds = new Set(current);

            if (visibleEmployeeIds.every((id) => currentIds.has(id))) {
                visibleEmployeeIds.forEach((id) => currentIds.delete(id));
            } else {
                visibleEmployeeIds.forEach((id) => currentIds.add(id));
            }

            return Array.from(currentIds);
        });
    };

    const toggleRecordSelection = (recordId: string) => {
        setSelectedRecordIds((current) =>
            current.includes(recordId) ? current.filter((id) => id !== recordId) : [...current, recordId]
        );
    };

    const printPayslip = () => {
        window.print();
    };

    const approvePotentialOvertime = () => {
        if (!dtrRecord || !employeeDtr) return;
        updateOvertimeMutation.mutate({ id: dtrRecord._id, overtimeHours: employeeDtr.summary.overtimeHours });
    };

    const clearApprovedOvertime = () => {
        if (!dtrRecord) return;
        updateOvertimeMutation.mutate({ id: dtrRecord._id, overtimeHours: 0 });
    };

    const openBankEdit = (employee: Employee) => {
        setBankEditEmployee(employee);
        setBankForm({
            bankName: employee.bankName || "",
            bankAccountName: employee.bankAccountName || "",
            bankAccountNumber: employee.bankAccountNumber || "",
        });
    };

    const saveBankDetails = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!bankEditEmployee) return;
        updateBankMutation.mutate({ employee: bankEditEmployee, bank: bankForm });
    };

    useEffect(() => {
        setSelectedRecordIds((current) => current.filter((id) => employees.some((employee) => employee._id === id)));
    }, [employees]);

    useEffect(() => {
        setPayslipCutoffPeriod(payslipRecord?.payPeriod || "");
        setIsPayslipCutoffOpen(false);
    }, [payslipRecord?._id, payslipRecord?.payPeriod]);

    useEffect(() => {
        if (!isPayslipCutoffOpen) return;

        const handlePointerDown = (event: MouseEvent) => {
            if (!payslipCutoffPickerRef.current?.contains(event.target as Node)) {
                setIsPayslipCutoffOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsPayslipCutoffOpen(false);
            }
        };

        document.addEventListener("mousedown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [isPayslipCutoffOpen]);

    useEffect(() => {
        if (!isPayslipCutoffOpen) return;

        window.requestAnimationFrame(() => {
            const list = payslipCutoffPickerRef.current?.querySelector<HTMLElement>("[data-cutoff-list]");
            if (list) list.scrollTop = 0;
        });
    }, [isPayslipCutoffOpen, payslipCutoffs]);

    return (
        <AdminLayout>
            <section className="min-h-[calc(100vh-8.5rem)]">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-semibold text-white">Payroll</h2>
                        <p className="mt-1 text-sm text-white/50">Manage payroll, salaries, deductions and payments.</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <label className="flex h-11 w-[20rem] max-w-full items-center gap-3 rounded-lg border border-white/10 bg-[#090b13]/80 px-3 text-white/45 transition focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
                                placeholder="Search employees..."
                                type="search"
                                value={search}
                                onChange={(event) => {
                                    setSearch(event.target.value);
                                    setPage(1);
                                }}
                            />
                            <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                        </label>
                        <div className="relative">
                            <button
                                className="flex h-11 min-w-[10rem] items-center justify-between gap-2 rounded-lg border border-white/10 bg-[#090b13]/80 px-4 text-sm font-semibold text-white/75 transition hover:bg-white/10"
                                type="button"
                                onClick={() => setIsFilterOpen((open) => !open)}
                            >
                                <span className="inline-flex items-center gap-2"><FiFilter className="size-4" />{statusFilter}</span>
                                <FiChevronDown className={["size-4 text-white/40 transition", isFilterOpen ? "rotate-180" : ""].join(" ")} />
                            </button>
                            {isFilterOpen && (
                                <div className="absolute right-0 top-12 z-30 w-full min-w-[12rem] overflow-hidden rounded-lg border border-white/10 bg-[#0d1018] py-1 shadow-2xl shadow-black/40">
                                    {["All statuses", ...statusOptions].map((status) => (
                                        <button
                                            key={status}
                                            className={["flex h-10 w-full items-center justify-between px-3 text-left text-sm font-semibold transition", statusFilter === status ? "bg-[#842cff] text-white" : "text-white/65 hover:bg-white/[0.06] hover:text-white"].join(" ")}
                                            type="button"
                                            onClick={() => {
                                                setStatusFilter(status);
                                                setIsFilterOpen(false);
                                                setPage(1);
                                            }}
                                        >
                                            {status}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <button className="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-[#090b13]/80 px-4 text-sm font-semibold text-white/75 transition hover:bg-white/10" type="button" onClick={exportCsv}>
                            <FiDownload className="size-4" aria-hidden="true" />
                            Export
                        </button>
                        {activeTab !== "Archived" && (
                            <button
                                className="flex h-11 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-5 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                                type="button"
                                disabled={runPayrollMutation.isPending}
                                onClick={() => runPayrollMutation.mutate(undefined)}
                            >
                                <FiPlus className="size-4" aria-hidden="true" />
                                {runPayrollMutation.isPending ? "Running..." : "Run Payroll"}
                            </button>
                        )}
                    </div>
                </div>

                <div className="mt-5 grid gap-4 xl:h-[calc(100vh-15.5rem)] xl:min-h-[34rem] xl:grid-cols-[minmax(14.5rem,16.5rem)_1fr]">
                    <aside className="relative z-20 flex min-h-0 flex-col overflow-hidden rounded-lg border border-violet-200/80 bg-white/82 shadow-xl shadow-violet-200/35 backdrop-blur">
                        <div className="border-b border-violet-200/80 px-4 py-4">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-[0.64rem] font-semibold uppercase tracking-[0.16em] !text-violet-600">Payroll</p>
                                    <h3 className="mt-1 truncate text-base font-semibold !text-slate-950">Sections</h3>
                                </div>
                                <span className="flex h-8 min-w-8 items-center justify-center rounded-lg border border-violet-200 bg-violet-50 px-2 text-xs font-semibold !text-violet-700">
                                    {payrollTabs.length}
                                </span>
                            </div>
                        </div>
                        <nav className="content-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5" aria-label="Payroll sections">
                            {payrollNavigation.map(({ tab, icon: Icon, description }) => {
                                const isActive = activeTab === tab;

                                return (
                                    <button
                                        key={tab}
                                        className={[
                                            "group relative flex min-h-14 w-full items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5 text-left transition",
                                            isActive
                                                ? "border-[#842cff]/55 bg-[#842cff]/12 shadow-sm shadow-violet-200/60"
                                                : "border-slate-200/70 bg-white/70 hover:border-violet-200 hover:bg-violet-50/80",
                                        ].join(" ")}
                                        type="button"
                                        onClick={() => {
                                            setActiveTab(tab);
                                            setPage(1);
                                            setSelectedRecordIds([]);
                                        }}
                                    >
                                        {isActive && <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-[#842cff]" aria-hidden="true" />}
                                        <span
                                            className={[
                                                "flex size-8 shrink-0 items-center justify-center rounded-md transition",
                                                isActive ? "bg-[#842cff] !text-white" : "bg-violet-50 !text-violet-500 group-hover:bg-violet-100 group-hover:!text-violet-700",
                                            ].join(" ")}
                                        >
                                            <Icon className="size-4" aria-hidden="true" />
                                        </span>
                                        <span className="min-w-0 leading-tight">
                                            <span className={["block truncate text-sm font-semibold leading-5", isActive ? "!text-slate-950" : "!text-slate-700 group-hover:!text-slate-950"].join(" ")}>{tab}</span>
                                            <span className={["mt-0.5 block truncate text-xs font-medium leading-4", isActive ? "!text-violet-700" : "!text-slate-500 group-hover:!text-slate-600"].join(" ")}>
                                                {description}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </nav>
                    </aside>

                    <section className="flex min-h-0 flex-col overflow-hidden">

                {activeTab === "Employee Payroll" && (
                    <>
                        <div className="grid gap-2 rounded-lg border border-violet-200/80 bg-white/82 p-2.5 shadow-sm shadow-violet-200/35 lg:grid-cols-[auto_minmax(0,1fr)_auto]">
                            <label className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium !text-slate-700 shadow-sm">
                                <span>Show</span>
                                <select className="bg-transparent font-semibold !text-slate-950 outline-none" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
                                    <option className="bg-white">10</option>
                                    <option className="bg-white">25</option>
                                    <option className="bg-white">50</option>
                                </select>
                                <span>entries</span>
                            </label>
                            <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                                {payrollStats.map((stat) => {
                                    const Icon = stat.icon;

                                    return (
                                        <article
                                            key={stat.label}
                                            className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-violet-100 bg-white px-2 shadow-sm"
                                        >
                                            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-violet-100 !text-violet-700">
                                                <Icon className="size-3" aria-hidden="true" />
                                            </span>
                                            <span className="min-w-0">
                                                <span className="block truncate text-[0.56rem] font-semibold uppercase tracking-[0.12em] !text-slate-500">
                                                    {stat.label}
                                                </span>
                                                <span className="mt-0.5 block truncate text-xs font-bold !text-slate-950">{stat.value}</span>
                                            </span>
                                        </article>
                                    );
                                })}
                            </div>
                        </div>

                        <section className="mt-3 flex min-h-[24rem] flex-1 flex-col overflow-hidden rounded-lg border border-violet-200/80 bg-white/90 shadow-xl shadow-violet-200/35">
                            <div className="content-scroll min-h-0 max-w-full flex-1 overflow-auto bg-[linear-gradient(to_bottom,#ffffff_0,#ffffff_3.25rem,transparent_3.25rem)] [scrollbar-gutter:stable]">
                                <table className="w-full min-w-full table-fixed border-separate border-spacing-0 text-left">
                                    <thead className="sticky top-0 z-10 bg-white text-[0.74rem] font-medium !text-slate-600 shadow-[12px_0_0_#ffffff]">
                                        <tr>
                                            <th className="w-[4%] px-3 py-3">
                                                <input
                                                    className="size-4 rounded border-slate-300 bg-transparent accent-[#842cff]"
                                                    type="checkbox"
                                                    aria-label="Select all payroll rows"
                                                    checked={areAllVisibleSelected}
                                                    onChange={toggleAllVisibleRecords}
                                                />
                                            </th>
                                            <th className="w-[24%] px-3 py-3"><DataTableSortHeader field="employeeName" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Employee</DataTableSortHeader></th>
                                            <th className="w-[12%] px-3 py-3"><DataTableSortHeader field="employeeId" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Employee ID</DataTableSortHeader></th>
                                            <th className="w-[10%] px-3 py-3">Basic Pay</th>
                                            <th className="w-[6%] px-3 py-3">Days</th>
                                            <th className="w-[7%] px-3 py-3">Hours</th>
                                            <th className="w-[10%] px-3 py-3"><DataTableSortHeader field="netPay" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Net Pay</DataTableSortHeader></th>
                                            <th className="w-[10%] px-3 py-3"><DataTableSortHeader field="status" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Status</DataTableSortHeader></th>
                                            <th className="w-[25%] px-3 py-3 text-center">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200">
                                        {isPayrollLoading && <tr><td className="px-3 py-4 text-sm !text-slate-500" colSpan={9}>Loading payroll...</td></tr>}
                                        {isPayrollError && <tr><td className="px-3 py-4 text-sm text-red-600" colSpan={9}>Unable to load payroll.</td></tr>}
                                        {!isPayrollLoading && !isPayrollError && visibleEmployees.length === 0 && <tr><td className="px-3 py-4 text-sm !text-slate-500" colSpan={9}>No payroll records found.</td></tr>}
                                        {visibleEmployees.map((employee) => {
                                            const initials = employee.employeeName.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();

                                            return (
                                                <tr
                                                    key={employee._id}
                                                    className="cursor-pointer text-sm !text-slate-700 transition hover:bg-violet-50/50 focus-within:bg-violet-50/50"
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={() => setPayslipRecord(employee)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === "Enter" || event.key === " ") {
                                                            event.preventDefault();
                                                            setPayslipRecord(employee);
                                                        }
                                                    }}
                                                >
                                                    <td className="px-3 py-2.5" onClick={(event) => event.stopPropagation()}>
                                                        <input
                                                            className="size-4 rounded border-slate-300 bg-transparent accent-[#842cff]"
                                                            type="checkbox"
                                                            aria-label={`Select ${employee.employeeName}`}
                                                            checked={selectedRecordIdSet.has(employee._id)}
                                                            onChange={() => toggleRecordSelection(employee._id)}
                                                        />
                                                    </td>
                                                    <td className="px-3 py-2.5">
                                                        <div className="flex min-w-0 items-center gap-3">
                                                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#f2b08a,#3d241f)] text-xs font-bold text-white">{initials}</span>
                                                            <span className="min-w-0">
                                                                <span className="block truncate font-semibold !text-slate-950">{employee.employeeName}</span>
                                                                <span className="mt-0.5 block truncate text-xs !text-slate-500">{employee.email}</span>
                                                            </span>
                                                        </div>
                                                    </td>
                                                    <td className="truncate px-3 py-2.5 !text-slate-700">{employee.employeeId}</td>
                                                    <td className="px-3 py-2.5 font-semibold !text-slate-950">{money(employee.basicPay ?? employee.grossPay)}</td>
                                                    <td className="px-3 py-2.5 !text-slate-700">{employee.attendanceDays ?? 0}</td>
                                                    <td className="px-3 py-2.5 !text-slate-700">{employee.workedHours ?? 0}h</td>
                                                    <td className="px-3 py-2.5 font-semibold !text-slate-950">{money(employee.netPay)}</td>
                                                    <td className="px-3 py-2.5"><StatusBadge status={employee.status} /></td>
                                                    <td className="px-3 py-2.5 text-center" onClick={(event) => event.stopPropagation()}>
                                                        <div className="flex flex-nowrap justify-center gap-0.5">
                                                            <button className="inline-flex size-7 items-center justify-center rounded-md !text-slate-600 transition hover:bg-slate-100 hover:!text-slate-950" type="button" onClick={() => { setBasicPayTarget(employee); setBasicPayInput(String(employee.basicPay ?? employee.grossPay ?? 0)); }} aria-label={`Edit basic pay for ${employee.employeeName}`} title="Edit basic pay">
                                                                <FiEdit2 className="size-3.5" />
                                                            </button>
                                                            <button className="inline-flex size-7 items-center justify-center rounded-md !text-[#2563eb] transition hover:bg-[#2563eb]/10 hover:!text-[#1d4ed8]" type="button" onClick={() => setDtrRecord(employee)} aria-label={`View DTR for ${employee.employeeName}`} title="View DTR">
                                                                <FiClock className="size-3.5" />
                                                            </button>
                                                            <button className="inline-flex size-7 items-center justify-center rounded-md !text-violet-600 transition hover:bg-violet-100 hover:!text-violet-800" type="button" onClick={() => setPayslipRecord(employee)} aria-label={`Generate payslip for ${employee.employeeName}`}>
                                                                <FiFileText className="size-3.5" />
                                                            </button>
                                                            <button
                                                                className={[
                                                                    "inline-flex size-7 items-center justify-center rounded-md transition",
                                                                    employee.status === "Paid"
                                                                        ? "!text-amber-600 hover:bg-amber-100 hover:!text-amber-700"
                                                                        : "!text-emerald-600 hover:bg-emerald-100 hover:!text-emerald-700",
                                                                ].join(" ")}
                                                                type="button"
                                                                onClick={() => setPaymentTarget({ action: employee.status === "Paid" ? "unpaid" : "paid", record: employee })}
                                                                aria-label={employee.status === "Paid" ? `Set ${employee.employeeName} unpaid` : `Mark ${employee.employeeName} paid`}
                                                                title={employee.status === "Paid" ? "Set unpaid" : "Mark paid"}
                                                            >
                                                                {employee.status === "Paid" ? <FiRotateCcw className="size-3.5" /> : <FiCheck className="size-3.5" />}
                                                            </button>
                                                            <button className="inline-flex size-7 items-center justify-center rounded-md !text-amber-600 transition hover:bg-amber-100 hover:!text-amber-700" type="button" onClick={() => openDeletePrompt({ type: "record", record: employee })} aria-label={`Archive ${employee.employeeName}`}>
                                                                <FiArchive className="size-3.5" />
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>

                            <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-2.5">
                                <p className="text-xs !text-slate-500">Showing {employees.length === 0 ? 0 : (page - 1) * pageSize + 1} to {Math.min(page * pageSize, employees.length)} of {employees.length} entries</p>
                                <div className="flex items-center gap-2">
                                    <button className="flex size-8 items-center justify-center rounded-lg border border-slate-200 bg-white !text-slate-500 transition hover:bg-violet-50 hover:!text-violet-700 disabled:opacity-40" type="button" disabled={page === 1} onClick={() => setPage((value) => Math.max(value - 1, 1))} aria-label="Previous page">
                                        <FiChevronLeft className="size-4" />
                                    </button>
                                    {Array.from({ length: Math.min(totalPages, 3) }, (_, index) => index + 1).map((pageNumber) => (
                                        <button key={pageNumber} className={["flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition", pageNumber === page ? "border-[#842cff] bg-[#842cff] !text-white" : "border-slate-200 bg-white !text-slate-500 hover:bg-violet-50 hover:!text-violet-700"].join(" ")} type="button" onClick={() => setPage(pageNumber)}>
                                            {pageNumber}
                                        </button>
                                    ))}
                                    {totalPages > 3 && <span className="px-2 text-sm !text-slate-400">...</span>}
                                    {totalPages > 3 && <button className="flex h-8 min-w-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-2 text-sm font-semibold !text-slate-500 transition hover:bg-violet-50 hover:!text-violet-700" type="button" onClick={() => setPage(totalPages)}>{totalPages}</button>}
                                    <button className="flex size-8 items-center justify-center rounded-lg border border-slate-200 bg-white !text-slate-500 transition hover:bg-violet-50 hover:!text-violet-700 disabled:opacity-40" type="button" disabled={page === totalPages} onClick={() => setPage((value) => Math.min(value + 1, totalPages))} aria-label="Next page">
                                        <FiChevronRight className="size-4" />
                                    </button>
                                </div>
                            </div>
                        </section>
                    </>
                )}

                {activeTab === "Bank Accounts" && (
                    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/10 bg-[#090b13]/80 shadow-2xl shadow-black/20">
                        <div className="border-b border-white/10 px-5 py-4">
                            <h3 className="text-base font-semibold text-white">Employee Bank Accounts</h3>
                            <p className="mt-1 text-xs text-white/45">Add or edit payout bank details used by payroll.</p>
                        </div>
                        <div className="content-scroll min-h-0 flex-1 overflow-auto">
                            <table className="w-full min-w-[58rem] table-fixed border-separate border-spacing-0 text-left">
                                <thead className="sticky top-0 z-10 bg-white text-[0.74rem] font-medium !text-slate-600">
                                    <tr>
                                        <th className="w-[24%] px-4 py-4">Employee</th>
                                        <th className="w-[20%] px-4 py-4">Bank</th>
                                        <th className="w-[22%] px-4 py-4">Account Name</th>
                                        <th className="w-[20%] px-4 py-4">Account Number</th>
                                        <th className="w-[14%] px-4 py-4 text-right">Action</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/10">
                                    {areBankEmployeesLoading && <tr><td className="px-4 py-5 text-sm text-white/45" colSpan={5}>Loading bank accounts...</td></tr>}
                                    {!areBankEmployeesLoading && bankEmployees.map((employee) => (
                                        <tr key={employee._id} className="text-sm text-white/75 transition hover:bg-white/[0.035]">
                                            <td className="px-4 py-3">
                                                <p className="font-semibold text-white">{employee.name}</p>
                                                <p className="mt-0.5 text-xs text-white/45">{employee.employeeCode}</p>
                                            </td>
                                            <td className="px-4 py-3">{employee.bankName || "-"}</td>
                                            <td className="px-4 py-3">{employee.bankAccountName || "-"}</td>
                                            <td className="px-4 py-3">{employee.bankAccountNumber || "-"}</td>
                                            <td className="px-4 py-3 text-right">
                                                <button className="inline-flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-xs font-semibold text-white/70 transition hover:bg-white/10 hover:text-white" type="button" onClick={() => openBankEdit(employee)}>
                                                    <FiEdit2 className="size-3.5" />
                                                    Edit
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                )}

                {activeTab === "Archived" && (
                    <section className="grid min-h-0 flex-1 gap-5 xl:grid-cols-2">
                        <ArchivedPanel
                            title="Archived Employee Payroll"
                            isLoading={isPayrollLoading}
                            isError={isPayrollError}
                            emptyText="No archived employee payroll records."
                            rows={employees.map((record) => ({
                                id: record._id,
                                primary: record.employeeName,
                                secondary: record.employeeId,
                                detail: `${record.payPeriod} · ${money(record.netPay)}`,
                                status: record.status,
                                onRestore: () => restoreRecordMutation.mutate(record._id),
                            }))}
                        />
                        <ArchivedPanel
                            title="Archived Payroll Items"
                            isLoading={areArchivedItemsLoading}
                            isError={areArchivedItemsError}
                            emptyText="No archived payroll items."
                            rows={archivedPayrollItems.map((item) => ({
                                id: item._id,
                                primary: item.name,
                                secondary: item.category,
                                detail: [item.second, item.third].filter(Boolean).join(" · "),
                                status: item.status,
                                onRestore: () => restoreItemMutation.mutate(item._id),
                            }))}
                        />
                    </section>
                )}

                {activeTab !== "Employee Payroll" && activeTab !== "Bank Accounts" && activeTab !== "Archived" && (
                    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/10 bg-[#090b13]/80 shadow-2xl shadow-black/20">
                        <div className="flex min-h-14 items-center justify-between border-b border-white/10 px-5">
                            <div>
                                <h3 className="text-base font-semibold text-white">{activeTab}</h3>
                                <p className="mt-1 text-xs text-white/40">
                                    {activeTab === "Deductions"
                                        ? "Add fixed employee deductions such as SSS, benefits, or contributions."
                                        : `Manage ${activeTab.toLowerCase()} for payroll.`}
                                </p>
                            </div>
                            <button className="flex h-9 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-3 text-sm font-semibold text-white transition hover:brightness-110" type="button" onClick={openItemModal}>
                                <FiPlus className="size-4" />
                                Add
                            </button>
                        </div>
                        <div className="content-scroll min-h-0 flex-1 overflow-auto bg-[linear-gradient(to_bottom,#ffffff_0,#ffffff_3rem,transparent_3rem)] [scrollbar-gutter:stable]">
                            <table className="w-full min-w-[54rem] table-fixed border-separate border-spacing-0 text-left">
                                <thead className="sticky top-0 z-10 bg-white text-[0.74rem] font-medium !text-slate-600 shadow-[12px_0_0_#ffffff]">
                                    <tr>
                                        <th className="w-[28%] px-4 py-4">{itemLabels?.name || "Name"}</th>
                                        <th className="w-[22%] px-4 py-4">{itemLabels?.second || "Scope"}</th>
                                        <th className="w-[22%] px-4 py-4">{itemLabels?.third || "Amount"}</th>
                                        <th className="w-[18%] px-4 py-4">{itemLabels?.fourth || "Detail"}</th>
                                        <th className="w-[10%] px-4 py-4 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/10">
                                    {areItemsLoading && <tr><td className="px-4 py-5 text-sm text-white/45" colSpan={5}>Loading {activeTab.toLowerCase()}...</td></tr>}
                                    {areItemsError && <tr><td className="px-4 py-5 text-sm text-red-200" colSpan={5}>Unable to load {activeTab.toLowerCase()}.</td></tr>}
                                    {!areItemsLoading && !areItemsError && payrollItems.length === 0 && <tr><td className="px-4 py-5 text-sm text-white/45" colSpan={5}>No records yet.</td></tr>}
                                    {payrollItems.map((item) => (
                                        <tr key={item._id} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                            <td className="px-4 py-4 font-semibold text-white">{item.name}</td>
                                            <td className="px-4 py-4 text-white/65">{item.second}</td>
                                            <td className="px-4 py-4 text-white/75">{item.third}</td>
                                            <td className="px-4 py-4 text-white/55">{item.fourth || "Today"}</td>
                                            <td className="px-4 py-4 text-right">
                                                <span className="mr-3"><StatusBadge status={item.status} /></span>
                                                <button className="inline-flex size-8 items-center justify-center rounded-lg text-yellow-100/60 transition hover:bg-yellow-400/10 hover:text-yellow-100" type="button" onClick={() => openDeletePrompt({ type: "item", item })} aria-label={`Archive ${item.name}`}>
                                                    <FiArchive className="size-4" />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                )}

                    </section>
                </div>

                {dtrRecord && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setDtrRecord(null);
                            }
                        }}
                    >
                        <section className="modal-panel-enter flex max-h-[90vh] w-full max-w-[68rem] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl shadow-slate-950/25">
                            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                                <div className="min-w-0">
                                    <p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] !text-slate-500">Employee DTR</p>
                                    <h3 className="mt-1 truncate text-lg font-semibold !text-black">{dtrRecord.employeeName}</h3>
                                    <p className="mt-1 text-sm !text-slate-600">{employeeDtr?.payPeriod || dtrRecord.payPeriod} · PH Time</p>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2">
                                    {employeeDtr && employeeDtr.summary.overtimeHours > 0 && (
                                        <button
                                            className="h-9 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                                            type="button"
                                            onClick={approvePotentialOvertime}
                                            disabled={updateOvertimeMutation.isPending}
                                        >
                                            Approve {employeeDtr.summary.overtimeHours}h OT
                                        </button>
                                    )}
                                    {(dtrRecord.overtimeHours || 0) > 0 && (
                                        <button
                                            className="h-9 rounded-lg border border-rose-300 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-60"
                                            type="button"
                                            onClick={clearApprovedOvertime}
                                            disabled={updateOvertimeMutation.isPending}
                                        >
                                            Clear Approved OT
                                        </button>
                                    )}
                                    <button
                                        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white !text-black transition hover:bg-slate-50"
                                        type="button"
                                        onClick={() => setDtrRecord(null)}
                                        aria-label="Close employee DTR"
                                    >
                                        <FiX className="size-4" />
                                    </button>
                                </div>
                            </div>

                            <div className="content-scroll min-h-0 flex-1 overflow-auto p-5">
                                {isDtrLoading && <p className="rounded-lg border border-slate-300 bg-slate-50 p-4 text-sm font-semibold !text-black">Loading DTR...</p>}
                                {isDtrError && <p className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm font-semibold text-rose-700">Unable to load DTR.</p>}
                                {employeeDtr && (
                                    <div className="space-y-4">
                                        <div className="grid gap-3 md:grid-cols-4">
                                            {[
                                                ["Cutoff Working Days", employeeDtr.summary.workingDays],
                                                ["Monthly Rate Days", employeeDtr.summary.monthlyWorkingDays],
                                                ["Basic Pay", money(employeeDtr.summary.basicPay)],
                                                ["Days Present", employeeDtr.summary.attendanceDays],
                                                ["Absent", formatDays(employeeDtr.summary.absentDays)],
                                                ["Late", `${employeeDtr.summary.lateMinutes} min`],
                                                ["Excess Lunch", `${employeeDtr.summary.excessLunchMinutes} min`],
                                                ["Excess Break", `${employeeDtr.summary.excessBreakMinutes} min`],
                                                ["Absence", `${employeeDtr.summary.absenceMinutes} min`],
                                                ["Early Time Out", `${employeeDtr.summary.earlyTimeOutMinutes} min`],
                                                ["Needs Review", employeeDtr.summary.incompleteShiftDays],
                                                ["Regular Hours", formatHoursMinutes(employeeDtr.summary.workedHours)],
                                                ["Potential OT", formatHoursMinutes(employeeDtr.summary.overtimeHours)],
                                                ["Approved OT", formatHoursMinutes(dtrRecord.overtimeHours || 0)],
                                                ["Hourly Rate", money(employeeDtr.summary.hourlyRate)],
                                                ["Per Minute", money(employeeDtr.summary.minuteRate)],
                                                ["Deductions", money(employeeDtr.summary.deductions)],
                                                ["Net Pay", money(employeeDtr.summary.netPay)],
                                            ].map(([label, value]) => (
                                                <div key={label} className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5">
                                                    <p className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] !text-slate-500">{label}</p>
                                                    <p className="mt-1 text-sm font-semibold !text-black">{value}</p>
                                                </div>
                                            ))}
                                        </div>

                                        <div className="overflow-hidden rounded-lg border border-slate-300">
                                            <div className="max-h-[46vh] overflow-auto">
                                                <table className="w-full min-w-[58rem] text-left text-sm">
                                                    <thead className="sticky top-0 z-10 bg-slate-100 text-[0.68rem] font-bold uppercase tracking-[0.12em] !text-slate-600">
                                                        <tr>
                                                            <th className="px-3 py-3">Date</th>
                                                            <th className="px-3 py-3">Status</th>
                                                            <th className="px-3 py-3">Time In</th>
                                                            <th className="px-3 py-3">Time Out</th>
                                                            <th className="px-3 py-3 text-right">Gross</th>
                                                            <th className="px-3 py-3 text-right">Lunch</th>
                                                            <th className="px-3 py-3 text-right">Regular</th>
                                                            <th className="px-3 py-3 text-right">Potential OT</th>
                                                            <th className="px-3 py-3 text-right">Late</th>
                                                            <th className="px-3 py-3 text-right">Lunch Over</th>
                                                            <th className="px-3 py-3 text-right">Break Over</th>
                                                            <th className="px-3 py-3 text-right">Absent</th>
                                                            <th className="px-3 py-3 text-right">Early Out</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-slate-200 bg-white">
                                                        {employeeDtr.rows.map((row) => (
                                                            <tr key={row.dateKey} className={row.status === "Overtime" ? "bg-violet-50/45" : row.status === "Absent" ? "bg-amber-50/35" : ""}>
                                                                <td className="px-3 py-3 !text-black">
                                                                    <span className="font-semibold">{row.date}</span>
                                                                    <span className="ml-2 text-xs !text-slate-500">{row.day}</span>
                                                                </td>
                                                                <td className="px-3 py-3">
                                                                    <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-bold ${dtrStatusClass(row.status)}`}>{row.status === "Overtime" ? "Potential OT" : row.status}</span>
                                                                </td>
                                                                <td className="px-3 py-3 !text-black">{row.timeIn}</td>
                                                                <td className="px-3 py-3 !text-black">{row.timeOut}</td>
                                                                <td className="px-3 py-3 text-right !text-black">{row.grossHours}h</td>
                                                                <td className="px-3 py-3 text-right !text-black">{row.lunchHours}h</td>
                                                                <td className="px-3 py-3 text-right !text-black">{row.regularHours}h</td>
                                                                <td className="px-3 py-3 text-right font-semibold text-violet-700">{row.overtimeHours}h</td>
                                                                <td className="px-3 py-3 text-right font-semibold text-rose-700">{formatHoursMinutes(row.lateHours)}</td>
                                                                <td className="px-3 py-3 text-right font-semibold text-amber-700">{row.excessLunchMinutes} min</td>
                                                                <td className="px-3 py-3 text-right font-semibold text-amber-700">{row.excessBreakMinutes} min</td>
                                                                <td className="px-3 py-3 text-right font-semibold text-rose-700">{row.absenceMinutes} min</td>
                                                                <td className="px-3 py-3 text-right font-semibold text-rose-700">{row.earlyTimeOutMinutes} min</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
                                <button
                                    className="h-9 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold !text-black transition hover:bg-slate-50"
                                    type="button"
                                    onClick={() => setDtrRecord(null)}
                                >
                                    Close
                                </button>
                            </div>
                        </section>
                    </div>
                )}

                {payslipRecord && payslipPreviewRecord && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setPayslipRecord(null);
                            }
                        }}
                    >
                        <section className="modal-panel-enter flex max-h-[94vh] w-full max-w-[58rem] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40">
                            <div className="no-print border-b border-white/10 bg-[radial-gradient(circle_at_12%_0%,rgba(132,44,255,0.26),transparent_35%),#0d1018] px-5 py-4">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-violet-200/70">Generated Payslip</p>
                                        <h3 className="mt-1 truncate text-xl font-semibold text-white">{payslipPreviewRecord.employeeName}</h3>
                                        <p className="mt-1 text-sm text-white/45">{payslipPreviewRecord.employeeId} · {payslipPreviewRecord.payPeriod}</p>
                                    </div>
                                    <div className="flex flex-wrap items-center justify-end gap-2">
                                        <div ref={payslipCutoffPickerRef} className="relative">
                                            <button
                                                className="flex h-10 w-[20rem] max-w-[calc(100vw-3rem)] items-center gap-3 rounded-lg border border-white/15 bg-white px-3 text-left text-sm font-semibold text-slate-950 shadow-sm transition hover:border-violet-300 hover:bg-violet-50 focus:outline-none focus:ring-2 focus:ring-violet-400/40"
                                                type="button"
                                                aria-expanded={isPayslipCutoffOpen}
                                                aria-haspopup="listbox"
                                                aria-label="Select payslip cutoff"
                                                onClick={() => setIsPayslipCutoffOpen((current) => !current)}
                                            >
                                                <span className="shrink-0 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-slate-400">Cutoff</span>
                                                <span className="min-w-0 flex-1 truncate">{selectedPayslipCutoff?.label || payslipCutoffPeriod || "Select cutoff"}</span>
                                                <FiChevronDown className={["size-4 shrink-0 text-violet-600 transition", isPayslipCutoffOpen ? "rotate-180" : ""].join(" ")} aria-hidden="true" />
                                            </button>
                                            {isPayslipCutoffOpen && (
                                                <div className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-[22rem] max-w-[calc(100vw-3rem)] overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-950 shadow-2xl shadow-black/25 ring-1 ring-violet-200/60">
                                                    <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
                                                        <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Payslip cutoff</p>
                                                        <p className="mt-0.5 text-xs text-slate-500">Newest periods first</p>
                                                    </div>
                                                    <div data-cutoff-list className="max-h-72 overflow-y-auto p-1 [scrollbar-color:#8b5cf6_#f1f5f9] [scrollbar-width:thin]" role="listbox">
                                                        {payslipCutoffs.map((option) => {
                                                            const isSelected = option.value === payslipCutoffPeriod;
                                                            const isCurrent = option.value === payslipRecord.payPeriod;

                                                            return (
                                                                <button
                                                                    key={option.value}
                                                                    className={[
                                                                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition",
                                                                        isSelected ? "bg-violet-600 !text-white shadow-sm shadow-violet-500/20" : "!text-slate-700 hover:bg-violet-50 hover:!text-slate-950",
                                                                    ].join(" ")}
                                                                    type="button"
                                                                    role="option"
                                                                    aria-selected={isSelected}
                                                                    onClick={() => {
                                                                        setPayslipCutoffPeriod(option.value);
                                                                        setIsPayslipCutoffOpen(false);
                                                                    }}
                                                                >
                                                                    <span className="min-w-0 flex-1">
                                                                        <span className="block truncate font-semibold">{option.label}</span>
                                                                        {option.payDate !== "-" && (
                                                                            <span className={["mt-0.5 block text-xs", isSelected ? "!text-violet-100" : "!text-slate-500"].join(" ")}>
                                                                                Pay date {option.payDate}
                                                                            </span>
                                                                        )}
                                                                    </span>
                                                                    {isCurrent && (
                                                                        <span className={["rounded-full px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.08em]", isSelected ? "bg-white/20 !text-white" : "bg-violet-100 !text-violet-700"].join(" ")}>
                                                                            Current
                                                                        </span>
                                                                    )}
                                                                    {isSelected && <FiCheck className="size-4 shrink-0 !text-white" aria-hidden="true" />}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        {isPayslipDtrLoading && <span className="text-xs font-semibold text-violet-100/70">Updating...</span>}
                                        <button
                                            className="flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white"
                                            type="button"
                                            onClick={printPayslip}
                                        >
                                            <FiPrinter className="size-4" aria-hidden="true" />
                                            Print / Save PDF
                                        </button>
                                        <button
                                            className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/65 transition hover:bg-white/10 hover:text-white"
                                            type="button"
                                            onClick={() => setPayslipRecord(null)}
                                            aria-label="Close payslip"
                                        >
                                            <FiX className="size-4" />
                                        </button>
                                    </div>
                                </div>

                                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                                    {[
                                        ["Gross Pay", money(payslipPreviewRecord.grossPay)],
                                        ["Deductions", money(payslipPreviewRecord.deductions)],
                                        ["Net Pay", money(payslipPreviewRecord.netPay)],
                                    ].map(([label, value]) => (
                                        <div key={label} className="rounded-lg border border-white/10 bg-white/[0.055] px-4 py-3">
                                            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-white/35">{label}</p>
                                            <p className="mt-1 text-lg font-bold text-white">{value}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="content-scroll min-h-0 flex-1 overflow-auto bg-slate-200 p-6">
                                <div className="mx-auto w-full max-w-[49rem] overflow-hidden rounded-xl shadow-2xl shadow-black/25">
                                    <PayslipDocument record={payslipPreviewRecord} money={money} payrollRunDay={systemSettings?.payrollRunDay} />
                                </div>
                            </div>
                        </section>
                    </div>
                )}

                {itemModalOpen && itemCategory && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setItemModalOpen(false);
                            }
                        }}
                    >
                        <form className="modal-panel-enter w-full max-w-[34rem] rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40" onSubmit={saveItem}>
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{itemCategory}</p>
                                    <h3 className="mt-1 text-base font-semibold text-white">{itemCategory === "Deductions" ? "Add Employee Deduction" : "Add Payroll Item"}</h3>
                                </div>
                                <button className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={() => setItemModalOpen(false)} aria-label="Close modal"><FiX className="size-4" /></button>
                            </div>
                            <div className="grid gap-4 p-5">
                                {[
                                    [itemLabels?.name || "Name", "name", itemCategory === "Deductions" ? "SSS" : ""],
                                    [itemLabels?.second || "Scope", "second", itemCategory === "Deductions" ? "500" : ""],
                                    [itemLabels?.third || "Amount", "third", itemCategory === "Deductions" ? "Philippines employee contribution" : ""],
                                    [itemLabels?.fourth || "Detail", "fourth", itemCategory === "Deductions" ? "Every payroll" : ""],
                                ].map(([label, field, placeholder]) => (
                                    <label key={field}>
                                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{label}</span>
                                        <input
                                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            type={itemCategory === "Deductions" && field === "second" ? "number" : "text"}
                                            min={itemCategory === "Deductions" && field === "second" ? "0" : undefined}
                                            step={itemCategory === "Deductions" && field === "second" ? "0.01" : undefined}
                                            value={String(itemForm[field as keyof typeof itemForm])}
                                            placeholder={placeholder}
                                            onChange={(event) => setItemForm((form) => ({ ...form, [field]: event.target.value }))}
                                        />
                                    </label>
                                ))}
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Status</span>
                                    <select className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none focus:border-[#842cff]" value={itemForm.status} onChange={(event) => setItemForm((form) => ({ ...form, status: event.target.value as PayrollStatus }))}>
                                        {statusOptions.map((status) => <option key={status}>{status}</option>)}
                                    </select>
                                </label>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                                <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={() => setItemModalOpen(false)}>Cancel</button>
                                <button className="h-10 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60" type="submit" disabled={createItemMutation.isPending}>Add Item</button>
                            </div>
                        </form>
                    </div>
                )}

                {bankEditEmployee && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setBankEditEmployee(null);
                            }
                        }}
                    >
                        <form className="modal-panel-enter w-full max-w-[34rem] rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40" onSubmit={saveBankDetails}>
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Bank Account</p>
                                    <h3 className="mt-1 text-base font-semibold text-white">{bankEditEmployee.name}</h3>
                                </div>
                                <button className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={() => setBankEditEmployee(null)} aria-label="Close bank account modal"><FiX className="size-4" /></button>
                            </div>
                            <div className="grid gap-4 p-5">
                                {[
                                    ["Bank name", "bankName"],
                                    ["Account name", "bankAccountName"],
                                    ["Account number", "bankAccountNumber"],
                                ].map(([label, field]) => (
                                    <label key={field}>
                                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{label}</span>
                                        <input
                                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={bankForm[field as keyof typeof bankForm]}
                                            onChange={(event) => setBankForm((form) => ({ ...form, [field]: event.target.value }))}
                                        />
                                    </label>
                                ))}
                            </div>
                            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                                <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={() => setBankEditEmployee(null)}>Cancel</button>
                                <button className="h-10 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60" type="submit" disabled={updateBankMutation.isPending}>Save Bank</button>
                            </div>
                        </form>
                    </div>
                )}

                {paymentTarget && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setPaymentTarget(null);
                            }
                        }}
                    >
                        <div className="modal-panel-enter w-full max-w-[30rem] overflow-hidden rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40">
                            <div className="border-b border-white/10 bg-white/[0.035] px-5 py-4">
                                <div className="flex items-start gap-3">
                                    <span
                                        className={[
                                            "flex size-10 shrink-0 items-center justify-center rounded-lg border",
                                            paymentTarget.action === "paid"
                                                ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100"
                                                : "border-yellow-300/20 bg-yellow-300/10 text-yellow-100",
                                        ].join(" ")}
                                    >
                                        {paymentTarget.action === "paid" ? <FiCheck className="size-5" /> : <FiRotateCcw className="size-5" />}
                                    </span>
                                    <div>
                                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Confirm Payroll Status</p>
                                        <h3 className="mt-1 text-lg font-semibold text-white">
                                            {paymentTarget.action === "paid" ? "Mark this payroll as paid?" : "Set this payroll back to unpaid?"}
                                        </h3>
                                        <p className="mt-1 text-sm leading-6 text-white/55">
                                            {paymentTarget.action === "paid"
                                                ? "This will mark the employee payroll paid and set today's paid date."
                                                : "This will move the record back to Pending and clear the paid date."}
                                        </p>
                                    </div>
                                </div>
                            </div>
                            <div className="p-5">
                                <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                    <p className="text-sm font-semibold text-white">{paymentTarget.record.employeeName}</p>
                                    <p className="mt-1 text-xs text-white/45">
                                        {paymentTarget.record.employeeId} · {paymentTarget.record.payPeriod} · {money(paymentTarget.record.netPay)}
                                    </p>
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                                <button
                                    className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white"
                                    type="button"
                                    onClick={() => setPaymentTarget(null)}
                                >
                                    Cancel
                                </button>
                                <button
                                    className={[
                                        "h-10 rounded-lg px-4 text-sm font-semibold transition disabled:opacity-60",
                                        paymentTarget.action === "paid"
                                            ? "bg-emerald-400 text-black hover:bg-emerald-300"
                                            : "bg-yellow-400 text-black hover:bg-yellow-300",
                                    ].join(" ")}
                                    type="button"
                                    onClick={confirmPaymentStatus}
                                    disabled={markPaidMutation.isPending || markUnpaidMutation.isPending}
                                >
                                    {paymentTarget.action === "paid" ? "Mark Paid" : "Set Unpaid"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {basicPayTarget && (
                    <div className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setBasicPayTarget(null); }}>
                        <form className="modal-panel-enter w-full max-w-[28rem] overflow-hidden rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40" onSubmit={(event) => { event.preventDefault(); const value = Number(basicPayInput); if (Number.isFinite(value) && value >= 0) updateBasicPayMutation.mutate({ employeeId: basicPayTarget.employeeId, basicPay: value }); }}>
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                                <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Monthly Basic Pay</p><h3 className="mt-1 text-lg font-semibold text-white">{basicPayTarget.employeeName}</h3></div>
                                <button className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60" type="button" onClick={() => setBasicPayTarget(null)} aria-label="Close"><FiX className="size-4" /></button>
                            </div>
                            <div className="p-5">
                                <label className="text-xs font-semibold uppercase tracking-[0.14em] text-white/45">Monthly salary for each 6th-5th cycle</label>
                                <input className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none focus:border-[#842cff]" type="number" min="0" step="0.01" required autoFocus value={basicPayInput} onChange={(event) => setBasicPayInput(event.target.value)} />
                                <p className="mt-2 text-xs leading-5 text-white/45">The system divides this by the period's Monday-Friday working days, then by 8 hours and 60 minutes.</p>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                                <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60" type="button" onClick={() => setBasicPayTarget(null)}>Cancel</button>
                                <button className="h-10 rounded-lg bg-[#842cff] px-4 text-sm font-semibold text-white disabled:opacity-60" type="submit" disabled={updateBasicPayMutation.isPending}>Save Basic Pay</button>
                            </div>
                        </form>
                    </div>
                )}

                {deleteTarget && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                closeDeletePrompt();
                            }
                        }}
                    >
                        <div className="modal-panel-enter w-full max-w-[32rem] overflow-hidden rounded-lg border border-yellow-300/20 bg-[#0d1018] shadow-2xl shadow-yellow-950/20">
                            <div className="bg-[radial-gradient(circle_at_15%_20%,rgba(250,204,21,0.18),transparent_35%),linear-gradient(135deg,rgba(250,204,21,0.10),rgba(132,44,255,0.08))] px-5 py-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex items-start gap-3">
                                        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-yellow-300/20 bg-yellow-300/12 text-yellow-100"><FiArchive className="size-5" /></span>
                                        <div>
                                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-yellow-100/55">Archive Payroll</p>
                                            <h3 className="mt-1 text-lg font-semibold text-white">Are you sure?</h3>
                                            <p className="mt-1 text-sm text-yellow-50/65">This keeps the record but removes it from active payroll tables.</p>
                                        </div>
                                    </div>
                                    <button className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20 text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={closeDeletePrompt} aria-label="Close archive confirmation"><FiX className="size-4" /></button>
                                </div>
                            </div>
                            <div className="p-5">
                                <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                    <p className="text-sm font-semibold text-white">{deleteTarget.type === "record" ? deleteTarget.record.employeeName : deleteTarget.item.name}</p>
                                    <p className="mt-1 text-sm text-white/55">{deleteTarget.type === "record" ? deleteTarget.record.employeeId : deleteTarget.item.category}</p>
                                </div>
                                <div className="mt-3 rounded-lg border border-yellow-300/20 bg-yellow-300/10 p-3">
                                    <p className="text-sm leading-6 text-yellow-50/75">Are you sure you want to archive this payroll record?</p>
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                                <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={closeDeletePrompt}>Cancel</button>
                                <button className="h-10 rounded-lg bg-yellow-400 px-4 text-sm font-semibold text-black transition hover:bg-yellow-300 disabled:opacity-60" type="button" onClick={confirmDelete} disabled={archiveRecordMutation.isPending || archiveItemMutation.isPending}>Archive</button>
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </AdminLayout>
    );
}
