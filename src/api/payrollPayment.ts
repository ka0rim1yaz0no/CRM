import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";
import { getActiveBusinessId } from "./businessStorage";
import { savedPayrollPeriod } from "../../shared/payrollPeriod";
import type { PayrollPaymentPreview, PayrollRecord } from "./payroll";

export async function preparePayrollPayment(record: PayrollRecord, paid: boolean, businessId: string, signal?: AbortSignal) {
    const auth = getAuthUser();
    if (auth?.userType !== "admin" || !auth.sessionToken || auth.access === "tracker" || getActiveBusinessId() !== businessId) {
        throw new Error("Sign in again as an administrator and reopen payment confirmation.");
    }
    const sessionToken = auth.sessionToken, employeeCode = auth.user.employeeCode;
    const assertScope = () => {
        const current = getAuthUser();
        if (getActiveBusinessId() !== businessId || current?.userType !== "admin" || current.sessionToken !== sessionToken || current.user.employeeCode !== employeeCode) {
            throw new Error("Payment session changed. Close and reopen payment confirmation.");
        }
    };
    const options = (target: string) => ({ signal, timeout: 15000, headers: {
        "X-Business-Id": target, "X-CRM-Admin-Session": sessionToken, "X-CRM-Attendance-Session": "", "Cache-Control": "no-store",
    } });
    const period = savedPayrollPeriod(record.payPeriod);
    if (!period) throw new Error("Choose a dated saved cutoff before changing payment status.");
    const samePeriod = (value: string) => {
        const candidate = savedPayrollPeriod(value);
        return candidate?.start === period.start && candidate.end === period.end;
    };
    type PaymentMoney = Pick<PayrollRecord, "grossPay" | "deductions" | "netPay" | "earnedToDate" | "savedAmounts">;
    const sameMoney = (left: PaymentMoney, right: PaymentMoney) => {
        // Payment confirmation settles saved amounts, not a moving earned-pay projection.
        const a = left.earnedToDate ? left.savedAmounts : left, b = right.earnedToDate ? right.savedAmounts : right;
        return Boolean(a && b && (["grossPay", "deductions", "netPay"] as const)
            .every(key => Number.isFinite(a[key]) && a[key] >= 0 && a[key] === b[key]));
    };
    const readRecords = async (target: string) => {
        assertScope();
        const response = await api.get<PayrollRecord[]>("/payroll/records", { ...options(target), params: { payPeriod: record.payPeriod } });
        assertScope();
        if (!Array.isArray(response.data)) throw new Error("Unable to verify the saved cutoff. Refresh Payroll.");
        return response.data;
    };
    const viewed = (await readRecords(businessId)).filter(item => item._id === record._id && item.employeeId === record.employeeId && !item.isArchived && samePeriod(item.payPeriod));
    if (viewed.length !== 1 || !sameMoney(viewed[0], record) || viewed[0].payrollOwnerBusinessId !== record.payrollOwnerBusinessId) {
        throw new Error("Saved payroll changed. Refresh Payroll before changing payment status.");
    }
    const source = viewed[0], paymentBusinessId = source.payrollOwnerBusinessId || businessId;
    if (auth.allowedBusinesses?.length && !auth.allowedBusinesses.some(item => item.id === paymentBusinessId)) {
        throw new Error("You do not have access to this cutoff's owning business.");
    }
    const candidates = paymentBusinessId === businessId ? viewed : (await readRecords(paymentBusinessId))
        .filter(item => item.employeeId === source.employeeId && !item.isArchived && samePeriod(item.payPeriod));
    if (candidates.length !== 1) throw new Error("The owning business has no unambiguous matching cutoff. Payroll review is required.");
    const owner = candidates[0];
    if ((owner.payrollOwnerBusinessId || paymentBusinessId) !== paymentBusinessId || !sameMoney(source, owner)) {
        throw new Error("Saved payroll amounts or ownership differ between businesses. Resolve the saved records before payment.");
    }
    assertScope();
    const preview = (await api.post<PayrollPaymentPreview>(`/payroll/records/${encodeURIComponent(owner._id)}/payment-status/preview`, { paid }, options(paymentBusinessId))).data;
    assertScope();
    const ownerRow = preview.rows.find(item => item.businessId === paymentBusinessId), viewRow = preview.rows.find(item => item.businessId === businessId);
    if (preview.id !== owner._id || preview.paid !== paid || !samePeriod(preview.payPeriod) || !preview.businessIds.includes(businessId) || !preview.businessIds.includes(paymentBusinessId) || !ownerRow) {
        throw new Error("Payment preview context changed. Refresh Payroll.");
    }
    if (!viewRow || !sameMoney(ownerRow, owner) || !sameMoney(viewRow, source)) throw new Error("Saved amounts changed during payment preview. Refresh Payroll.");
    let submitted = false;
    return { preview, paymentBusinessId, paymentBusinessName: ownerRow.businessName, isCurrent: () => { assertScope(); return true; },
        confirm: async (reason: string, acknowledgeAttendance: boolean) => {
            assertScope();
            if (submitted || !preview.canApply || !reason.trim() || reason.trim().length > 1000 || (preview.warnings.length > 0 && !acknowledgeAttendance)) {
                throw new Error("Refresh the preview and confirm its saved amounts before changing payment status.");
            }
            submitted = true;
            return (await api.post<{ applied: boolean }>(`/payroll/records/${encodeURIComponent(owner._id)}/payment-status/confirm`, {
                token: preview.token, paid, reason: reason.trim(), acknowledgeAttendance, confirm: true,
            }, { ...options(paymentBusinessId), signal: undefined })).data;
        } };
}
