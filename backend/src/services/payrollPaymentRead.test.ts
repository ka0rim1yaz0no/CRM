import assert from "node:assert/strict";
import test from "node:test";
import { currentCutoffLiveFrom } from "../config/payrollEarnings";
import { liveCurrentPayrollRecord } from "./payrollPaymentRead";

test("live current payroll never includes restored periods, future cutoffs or already paid records", () => {
    const before = process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;
    process.env.CRM_CURRENT_CUTOFF_LIVE_FROM = "2026-11-06";
    try {
        const current = "Nov 6, 2026 - Nov 20, 2026";
        assert.equal(liveCurrentPayrollRecord({ payPeriod: "Oct 21, 2026 - Nov 5, 2026", status: "Pending" }, current), false);
        assert.equal(liveCurrentPayrollRecord({ payPeriod: current, status: "Pending" }, current), true);
        assert.equal(liveCurrentPayrollRecord({ payPeriod: current, status: "Review" }, current), true);
        for (const status of ["Paid", "Completed"]) assert.equal(liveCurrentPayrollRecord({ payPeriod: current, status }, current), false);
        assert.equal(liveCurrentPayrollRecord({ payPeriod: "Nov 21, 2026 - Dec 5, 2026", status: "Pending" }, current), false);
        assert.equal(liveCurrentPayrollRecord({ payPeriod: current, status: "Pending" }, "Nov 21, 2026 - Dec 5, 2026"), true);
    } finally { if (before === undefined) delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM; else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM = before; }
});

test("the rollout cannot be backdated into restored payroll or accept impossible dates", () => {
    const before = process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;
    try {
        for (const value of ["2026-11-05", "2026-10-21", "2027-02-31", "invalid"]) {
            process.env.CRM_CURRENT_CUTOFF_LIVE_FROM = value;
            assert.throws(currentCutoffLiveFrom, /restored cutoffs|invalid activation date/);
        }
    } finally { if (before === undefined) delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM; else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM = before; }
});

test("an inactive current-draft rollout retains saved-only payment behavior", () => {
    const before = process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;
    delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;
    try { assert.equal(liveCurrentPayrollRecord({ payPeriod: "Nov 6, 2026 - Nov 20, 2026", status: "Pending" }, "Nov 6, 2026 - Nov 20, 2026"), false); }
    finally { if (before !== undefined) process.env.CRM_CURRENT_CUTOFF_LIVE_FROM = before; }
});
