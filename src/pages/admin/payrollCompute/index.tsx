import { useQuery } from "@tanstack/react-query";
import AdminLayout from "../adminLayout";
import { getPayrollDtr, getPayrollRecords, type PayrollDtr, type PayrollRecord } from "../../../api/payroll";
import { getActiveBusinessId } from "../../../api/businessStorage";
import { payrollDeductionDisplayRows, payrollDeductionDisplayTotal } from "../../../../shared/payrollPresentation";
import { isEarnedPayrollVersion } from "../../../../shared/payrollEarnings";

type PayrollComputeRow = {
    record: PayrollRecord;
    dtr: PayrollDtr | null;
};

function money(value = 0) {
    return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(value);
}

function round(value = 0) {
    return Math.round(value * 100) / 100;
}

function hours(value = 0) {
    const totalMinutes = Math.round(Math.max(value, 0) * 60);
    const hourValue = Math.floor(totalMinutes / 60);
    const minuteValue = totalMinutes % 60;

    if (!hourValue && !minuteValue) return "0m";
    if (!hourValue) return `${minuteValue}m`;
    return minuteValue ? `${hourValue}h ${minuteValue}m` : `${hourValue}h`;
}

function computePayroll(record: PayrollRecord) {
    const scheduledHours = Number(record.scheduledHours || 0);
    const approvedOtHours = Number(record.overtimeHours || 0);
    const grossPay = Number(record.grossPay || 0);
    const deductions = Number(record.deductions || 0);
    const basePay = Number(record.basicPay ?? grossPay);
    const workingDays = Number(record.workingDays || 0);
    const regularHoursPerDay = record.paidHoursPerDay;
    const hourlyRate = record.hourlyRate ?? Number(record.minuteRate || 0) * 60;
    const dailyRate = regularHoursPerDay != null ? hourlyRate * regularHoursPerDay : null;
    const approvedOtPay = isEarnedPayrollVersion(record.calculationVersion) ? approvedOtHours * hourlyRate : grossPay - basePay;
    const regularPay = isEarnedPayrollVersion(record.calculationVersion) ? grossPay - approvedOtPay : basePay;
    const deductionHours = hourlyRate > 0 ? deductions / hourlyRate : 0;
    const netPay = record.netPay;

    return {
        scheduledHours,
        approvedOtHours,
        grossPay,
        deductions,
        hourlyRate,
        workingDays,
        dailyRate,
        basePay,
        approvedOtPay,
        regularPay,
        deductionHours,
        netPay,
        regularHoursPerDay,
    };
}

function renderRecord({ record, dtr }: PayrollComputeRow) {
    if (record.earningsUnavailable) return `${record.employeeName}: current earned pay needs review; saved payroll and payment status are unchanged.`;
    const computed = computePayroll(record);
    const dtrSummary = dtr?.summary;
    const dtrRows = dtr?.rows || [];

    return [
        "============================================================",
        `${record.employeeName} (${record.employeeId})`,
        `Pay period: ${record.payPeriod}`,
        `Pay date: ${record.paidOn || "-"}`,
        "",
        "PAY RATE",
        `Scheduled hours = ${round(computed.scheduledHours)}h`,
        `Monthly-cycle working days = ${round(computed.workingDays)} days`,
        `Cutoff basic pay = ${money(computed.basePay)}`,
        `Monthly salary = ${money(computed.basePay)} x 2 = ${money(computed.basePay * 2)}`,
        computed.dailyRate == null ? "Daily paid hours/rate: not snapshotted on this stored cutoff" :
            `Daily rate = ${money(computed.basePay * 2)} / ${round(computed.workingDays)} days = ${money(computed.dailyRate)}`,
        `Stored hourly rate = ${money(computed.hourlyRate)}${computed.regularHoursPerDay != null ? `; paid day ${computed.regularHoursPerDay}h` : ""}`,
        "",
        "EARNINGS",
        `${isEarnedPayrollVersion(record.calculationVersion) ? "Earned regular pay" : "Basic pay"} = ${money(computed.regularPay)}`,
        `Approved OT pay = ${hours(computed.approvedOtHours)} x ${money(computed.hourlyRate)} = ${money(computed.approvedOtPay)}`,
        `Gross pay = ${money(computed.regularPay)} + ${money(computed.approvedOtPay)} = ${money(computed.grossPay)}`,
        "",
        "DEDUCTIONS",
        ...payrollDeductionDisplayRows(record).map(row => {
            const amount = row.amount ?? row.informationalAmount;
            return `${row.label}: ${row.minutes} min = ${amount === undefined ? "--" : money(amount)}${row.note ? `; ${row.note}` : ""}`;
        }),
        `Total displayed deductions = ${payrollDeductionDisplayTotal(record) === null ? "Unavailable" : money(payrollDeductionDisplayTotal(record)!)}`,
        `Applied to net pay = ${money(computed.deductions)}`,
        `Attendance deduction hours = ${money(computed.deductions)} / ${money(computed.hourlyRate)} = ${hours(computed.deductionHours)}`,
        `Attendance deductions = ${hours(computed.deductionHours)} x ${money(computed.hourlyRate)} = ${money(computed.deductions)}`,
        "",
        "NET PAY",
        `Net pay = ${money(computed.grossPay)} - ${money(computed.deductions)} = ${money(computed.netPay)}`,
        "",
        "ATTENDANCE NOTES",
        `Days present = ${record.attendanceDays || 0}`,
        `Absent = ${record.absentDays || 0} day(s), ${hours(record.absentHours || 0)}`,
        `Late = ${record.lateDays || 0} day(s), ${hours(record.lateHours || 0)}`,
        `Worked regular hours = ${hours(record.workedHours || 0)}`,
        `Non-billable Off the Phone = ${record.nonBillableOffPhoneMinutes ?? 0} min (included in saved deductions)`,
        "Late time is shown for audit. Salary deduction follows the attendance deduction hours above.",
        dtrSummary
            ? [
                "",
                "DTR SUMMARY FROM API",
                `Working days: ${dtrSummary.workingDays}`,
                `Scheduled hours: ${hours(dtrSummary.scheduledHours)}`,
                `Regular worked: ${hours(dtrSummary.workedHours)}`,
                `Missing/deduction hours: ${hours(dtrSummary.missingHours)}`,
                `Potential OT: ${hours(dtrSummary.overtimeHours)}`,
            ].join("\n")
            : "",
        dtrRows.length
            ? [
                "",
                "DTR ROWS",
                "Date | Status | Time In | Time Out | Regular | Missing | Late | Potential OT",
                ...dtrRows.map((row) => `${row.date} ${row.day} | ${row.status} | ${row.timeIn} | ${row.timeOut} | ${hours(row.regularHours)} | ${hours(row.missingHours)} | ${hours(row.lateHours)} | ${hours(row.overtimeHours)}`),
            ].join("\n")
            : "",
        "",
    ].join("\n");
}

export default function PayrollComputePage() {
    const { data = [], isLoading, isError } = useQuery({
        queryKey: ["payroll-compute", getActiveBusinessId()],
        queryFn: async () => {
            const records = await getPayrollRecords({ archived: false });
            const dtrs = await Promise.all(records.map((record) => getPayrollDtr(record.employeeId, record.payPeriod).catch(() => null)));
            return records.map((record, index) => ({ record, dtr: dtrs[index] }));
        },
    });

    return (
        <AdminLayout>
            <div className="min-h-full bg-white p-6 text-black">
                <h2 className="text-xl font-semibold text-black">Temporary Payroll Compute</h2>
                <p className="mt-1 text-sm text-slate-700">Route: /admin/payrollCompute</p>
                {isLoading && <pre className="mt-4 whitespace-pre-wrap text-sm text-black">Loading payroll computation...</pre>}
                {isError && <pre className="mt-4 whitespace-pre-wrap text-sm text-red-700">Unable to load payroll computation.</pre>}
                {!isLoading && !isError && (
                    <pre className="mt-4 overflow-auto whitespace-pre-wrap rounded border border-slate-300 bg-slate-50 p-4 text-sm leading-6 text-black">
                        {data.length ? data.map(renderRecord).join("\n") : "No payroll records found."}
                    </pre>
                )}
            </div>
        </AdminLayout>
    );
}
