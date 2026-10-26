import { runForEachBusiness } from "../config/tenancy";
import { attendanceIntegrityEnabled, payrollAccuracyEnabled } from "../config/rolloutFlags";
import { generateFutureMissingPayroll } from "./payrollMissingGeneration";

let running = false, timer: NodeJS.Timeout | null = null;
export async function runPayrollGeneration() {
    if (running || !payrollAccuracyEnabled() || !attendanceIntegrityEnabled()) return;
    running = true;
    try {
        await runForEachBusiness(async () => {
            try { await generateFutureMissingPayroll(); }
            catch { console.error("AUTOMATIC_PAYROLL_GENERATION_DEFERRED"); }
        });
    } finally { running = false; }
}
export function startPayrollGenerationWorker() {
    if (timer) return;
    void runPayrollGeneration();
    timer = setInterval(() => void runPayrollGeneration(), 5 * 60_000);
    timer.unref();
}
