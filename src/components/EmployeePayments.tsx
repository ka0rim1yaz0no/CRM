import { useSyncExternalStore, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FiAlertTriangle, FiChevronDown, FiChevronLeft, FiChevronRight, FiRefreshCw } from "react-icons/fi";
import { getEmployeePayments } from "../api/employeePayments";
import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { payrollDeductionDisplayRows } from "../../shared/payrollPresentation";
import { isEarnedPayrollVersion } from "../../shared/payrollEarnings";
import type { EmployeePayment } from "../../shared/employeePayments";
import { savedPayrollPeriod } from "../../shared/payrollPeriod";
import { payrollPaymentStatus } from "../../shared/payrollPaymentStatus";
import { savedPayrollDisplayRates } from "../../shared/payrollSavedRates";
import "./employeePayments.css";

function subscribe(listener: () => void) {
    const events = ["crm:auth-changed", "crm:business-changed", "storage"];
    for (const event of events) window.addEventListener(event, listener);
    return () => { for (const event of events) window.removeEventListener(event, listener); };
}
function identityKey() {
    const auth = getAuthUser();
    return JSON.stringify([getActiveBusinessId(), auth?.userType === "employee" ? auth.user._id : ""]);
}
function calendarDate(value: string | null) {
    if (!value) return "Not recorded";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
const quantity = (value: number | null, unit = "") => value === null ? "Not recorded" : `${Number(value.toFixed(2)).toLocaleString("en-US")}${unit}`;

function PaymentDetails({ item, money }: { item: EmployeePayment; money: (value: number) => string }) {
    if (item.earningsUnavailable) return <p className="employee-payments-error" role="status">Current earnings need payroll review. Saved amounts and payment status have not changed.</p>;
    const deductionRows = payrollDeductionDisplayRows(item);
    const rates = savedPayrollDisplayRates(item);
    const values: Array<[string, string, string?]> = [
        ["Pay type", item.payType], ["Department", item.department],
        ["Scheduled pay date", calendarDate(item.scheduledPayDate)],
        ["Payment date", item.status === "Paid" ? calendarDate(item.paidOn) : "Not paid"],
        ["Basic pay (monthly)", rates.monthlyBasicPay === null ? "Not recorded" : money(rates.monthlyBasicPay), rates.calculated.includes("monthlyBasicPay") ? "Calculated from saved semi-monthly cutoff basic pay" : undefined],
        ["Hourly rate", rates.hourlyRate === null ? "Not recorded" : money(rates.hourlyRate), rates.calculated.includes("hourlyRate") ? "Calculated from saved payroll rates" : undefined],
        ["Minute rate", item.minuteRate === null ? "Not recorded" : money(item.minuteRate)],
        ["Paid hours / day", quantity(rates.paidHoursPerDay, "h"), rates.calculated.includes("paidHoursPerDay") ? "Calculated from saved basic pay, working days and hourly rate" : undefined],
    ];
    return <div className="employee-payment-details">
        <div className="employee-payment-breakdown">
            <section aria-label="Earnings"><h3>Earnings</h3><dl>
                <div><dt>{isEarnedPayrollVersion(item.calculationVersion) ? "Earned pay" : "Basic pay (cutoff)"}</dt><dd>{isEarnedPayrollVersion(item.calculationVersion) ? money(item.grossPay) : item.basicPay === null ? "Not recorded" : money(item.basicPay)}</dd></div>
                {!isEarnedPayrollVersion(item.calculationVersion) && item.basicPay !== null && item.grossPay > item.basicPay && <div><dt>Additional earnings</dt><dd>{money(Math.round((item.grossPay - item.basicPay) * 100) / 100)}</dd></div>}
                <div><dt>Overtime</dt><dd>{quantity(item.overtimeHours, "h")} / {item.overtimeApproved ? "Approved" : "Not approved"}</dd></div>
                <div className="employee-payment-total"><dt>Gross pay</dt><dd>{money(item.grossPay)}</dd></div>
            </dl></section>
            <section aria-label="Deductions"><h3>Deductions</h3><dl>
                {deductionRows.map(row => <div key={row.label}><dt>{row.label} <span>{row.minutes}m</span>{row.note && <small>{row.note}</small>}</dt><dd>{row.amount === null ? "--" : money(row.amount)}</dd></div>)}
                <div className="employee-payment-total"><dt>Total deductions</dt><dd>{money(item.deductions)}</dd></div>
            </dl></section>
            <section aria-label="Attendance"><h3>Attendance</h3><dl>
                {([["Monthly working days", quantity(item.workingDays)], ["Days attended", quantity(item.attendanceDays)], ["Days absent", quantity(item.absentDays)],
                    ["Worked", quantity(item.workedHours, "h")], ["Scheduled", quantity(item.scheduledHours, "h")],
                    ["Deductible time", quantity(item.deductibleMinutes, "m")], ["Incomplete shifts", quantity(item.incompleteShiftDays)]]).map(([label, value]) =>
                    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl></section>
        </div>
        <dl className="employee-payment-meta">{values.map(([label, value, title]) => <div key={label}><dt>{label}</dt><dd title={title}>{value}</dd></div>)}</dl>
        <div className="employee-payment-net"><span>{item.earnedToDate ? "Net pay earned to date" : "Net pay"}</span><strong>{money(item.netPay)}</strong></div>
        {item.earnedToDate && item.earningsAsOf && <p className="employee-payments-start">As of {new Date(item.earningsAsOf).toLocaleString("en-PH", { timeZone: "Asia/Manila" })} PH</p>}
    </div>;
}

function PaymentsLedger({ employeeId, businessId }: { employeeId: string; businessId: string }) {
    const [page, setPage] = useState(1);
    const [view, setView] = useState<"current" | "history">("current");
    const query = useQuery({ queryKey: ["employee-payments", businessId, employeeId, view, page],
        queryFn: ({ signal }) => getEmployeePayments(employeeId, businessId, page, signal, view), enabled: Boolean(employeeId && businessId),
        staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: "always", refetchInterval: 30000 });
    const data = query.data;
    const money = (value: number) => new Intl.NumberFormat("en-PH", { style: "currency", currency: data?.currencyCode || "PHP" }).format(value);
    const pages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || 20)));
    return <section className="employee-payments" aria-label="Payments" aria-busy={query.isFetching}>
        <header className="employee-payments-heading"><div><h2>Payments</h2>
            {data && <p>{data.business.name} <span aria-hidden="true">/</span> Current cutoff: {data.currentPayPeriod}</p>}
        </div><div className="employee-payments-controls"><label>Cutoff<select aria-label="Payment cutoff view" value={view} onChange={event => { setView(event.target.value as "current" | "history"); setPage(1); }}><option value="current">Current cutoff</option><option value="history">Full cutoff history</option></select></label><button type="button" title="Refresh payments" aria-label="Refresh payments" disabled={query.isFetching} onClick={() => void query.refetch()}><FiRefreshCw aria-hidden="true" /></button></div></header>
        {query.isError && <p className="employee-payments-error" role="alert">Payments could not refresh. Try again.</p>}
        {query.isPending && <p role="status">Loading payments...</p>}
        {!query.isPending && !data && !query.isError && <p>Sign in to view payments.</p>}
        {data?.setupPending && <p role="status">Payment history is being prepared.</p>}
        {data && !data.setupPending && <>
            <p className="employee-payments-start">History starts with {data.initialPayPeriod}.</p>
            {data.reviewCount > 0 && <p className="employee-payments-error" role="status">{data.reviewCount} cutoff record{data.reviewCount === 1 ? " needs" : "s need"} payroll review.</p>}
            {data.items.length === 0 && <p className="employee-payments-empty">{page === 1 ? "Payroll not yet released." : "No payments on this page."}</p>}
            {data.items.length > 0 && <div className="employee-payment-column-head" aria-hidden="true"><span>Cutoff</span><span>Gross pay</span><span>Deductions</span><span>Net pay</span><span>Status</span><span /></div>}
            {data.items.map(item => <details className="employee-payment" key={item.id}>
                <summary><span className="employee-payment-cutoff">{savedPayrollPeriod(item.payPeriod)?.label || item.payPeriod}</span>
                    <span className="employee-payment-amount"><small>Gross pay</small>{item.earningsUnavailable ? "Unavailable" : money(item.grossPay)}</span>
                    <span className="employee-payment-amount"><small>Deductions</small>{item.earningsUnavailable ? "Unavailable" : money(item.deductions)}</span>
                    <strong className="employee-payment-amount" title={item.earnedToDate ? "Earned to date" : undefined}><small>{item.earnedToDate ? "Earned net pay" : "Net pay"}</small>{item.earningsUnavailable ? "Unavailable" : money(item.netPay)}</strong>
                    <span className="employee-payment-status" data-paid={item.status === "Paid"}>{payrollPaymentStatus(item.status)}{item.requiresReview && <FiAlertTriangle role="img" aria-label="Conflicting saved payroll entries" title="Conflicting saved payroll entries" />}</span><FiChevronDown aria-hidden="true" />
                </summary><PaymentDetails item={item} money={money} />
            </details>)}
            {(pages > 1 || page > 1) && <nav className="employee-payment-pagination" aria-label="Payment pages">
                <button type="button" title="Previous payment page" aria-label="Previous payment page" disabled={page <= 1 || query.isFetching} onClick={() => setPage(value => value - 1)}><FiChevronLeft aria-hidden="true" /></button>
                <span>Page {page} of {pages}</span><button type="button" title="Next payment page" aria-label="Next payment page" disabled={page >= pages || query.isFetching} onClick={() => setPage(value => value + 1)}><FiChevronRight aria-hidden="true" /></button>
            </nav>}
        </>}
    </section>;
}

export default function EmployeePayments() {
    const identity = useSyncExternalStore(subscribe, identityKey);
    const [businessId, employeeId] = JSON.parse(identity) as [string, string];
    return <PaymentsLedger key={identity} employeeId={employeeId} businessId={businessId} />;
}
