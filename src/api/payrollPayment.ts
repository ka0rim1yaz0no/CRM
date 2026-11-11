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
    const preparation = new AbortController();
    const assertScope = () => {
        if (preparation.signal.aborted) throw new Error("Payment preview was cancelled. Close and reopen payment confirmation.");
        const current = getAuthUser();
        if (getActiveBusinessId() !== businessId || current?.userType !== "admin" || current.sessionToken !== sessionToken || current.user.employeeCode !== employeeCode) {
            throw new Error("Payment session changed. Close and reopen payment confirmation.");
        }
    };
    const options = (target: string) => ({ signal: preparation.signal, timeout: 15000, headers: {
        "X-Business-Id": target, "X-CRM-Admin-Session": sessionToken, "X-CRM-Attendance-Session": "", "Cache-Control": "no-store",
    } });
    const period = savedPayrollPeriod(record.payPeriod);
    if (!period) throw new Error("Choose a dated saved cutoff before changing payment status.");
    const samePeriod = (value: string) => {
        const candidate = savedPayrollPeriod(value);
        return candidate?.start === period.start && candidate.end === period.end;
    };
    type PaymentMoney = Pick<PayrollRecord, "grossPay" | "deductions" | "netPay" | "earnedToDate" | "cutoffEstimate" | "earningsUnavailable" | "savedAmounts">;
    const sameMoney = (left: PaymentMoney, right: PaymentMoney) => {
        // Verify saved ownership first; the current-cutoff preview separately freezes its reviewed calculation.
        const a = (left.earnedToDate || left.cutoffEstimate) && !left.earningsUnavailable ? left.savedAmounts : left;
        const b = (right.earnedToDate || right.cutoffEstimate) && !right.earningsUnavailable ? right.savedAmounts : right;
        return Boolean(a && b && (["grossPay", "deductions", "netPay"] as const)
            .every(key => Number.isFinite(a[key]) && a[key] >= 0 && a[key] === b[key]));
    };
    const readRecords = async (target: string) => {
        assertScope();
        const response = await api.get<PayrollRecord[]>("/payroll/records", { ...options(target), params: { payPeriod: record.payPeriod,
            employeeId: record.employeeId, savedForPayment: true } });
        assertScope();
        if (!Array.isArray(response.data)) throw new Error("Unable to verify the saved cutoff. Refresh Payroll.");
        return response.data;
    };
    const abortPreparation = () => preparation.abort(signal?.reason);
    if (signal?.aborted) abortPreparation(); else signal?.addEventListener("abort", abortPreparation, { once: true });
    const deadline = setTimeout(() => preparation.abort(new Error("Payment preview deadline exceeded.")), 15000);
    try {
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
    if (preview.currentCutoffDraft) {
        const valid = (row: PaymentMoney) => [row.grossPay, row.deductions, row.netPay].every(value => Number.isFinite(value) && value >= 0) &&
            Math.round(row.grossPay * 100) - Math.round(row.deductions * 100) === Math.round(row.netPay * 100);
        if (!paid || !record.currentCutoffDraft || !viewRow || !valid(ownerRow) || !valid(viewRow) || !sameMoney(ownerRow, viewRow)) {
            throw new Error("Current payroll preview changed. Refresh Payroll before approval.");
        }
    } else if (!viewRow || !sameMoney(ownerRow, owner) || !sameMoney(viewRow, source)) throw new Error("Saved amounts changed during payment preview. Refresh Payroll.");
    let submitted = false;
    return { preview, paymentBusinessId, paymentBusinessName: ownerRow.businessName, isCurrent: () => { assertScope(); return true; },
        confirm: async (reason: string, acknowledgeAttendance: boolean) => {
            assertScope();
            if (submitted || !preview.canApply || !reason.trim() || reason.trim().length > 1000 || (preview.warnings.length > 0 && !acknowledgeAttendance)) {
                throw new Error("Refresh the preview and confirm its saved amounts before changing payment status.");
            }
            submitted = true;
            const result = (await api.post<{ applied: boolean }>(`/payroll/records/${encodeURIComponent(owner._id)}/payment-status/confirm`, {
                token: preview.token, paid, reason: reason.trim(), acknowledgeAttendance, confirm: true,
            }, { ...options(paymentBusinessId), signal: undefined })).data;
            if (result.applied !== true) throw new Error("Payment status was not confirmed. Refresh the preview and check the saved status before trying again.");
            return result;
        } };
    } catch (failure) {
        if (preparation.signal.aborted && !signal?.aborted) throw new Error("Payment preview took too long. No payment status was changed. Refresh the preview to try again.", { cause: failure });
        throw failure;
    } finally {
        clearTimeout(deadline); signal?.removeEventListener("abort", abortPreparation);
    }
}
