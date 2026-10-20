import type { Request, Response } from "express";
import { payrollAccuracyEnabled } from "../config/rolloutFlags";
import { applyPayrollCutoff, previewPayrollCutoff } from "../services/payrollRecomputeService";

export function payrollAccuracyConfig(_request: Request, response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.json({ enabled: payrollAccuracyEnabled() });
}
export async function previewPayroll(request: Request, response: Response) {
  if (!payrollAccuracyEnabled()) { response.status(404).json({ message: "Payroll accuracy is disabled" }); return; }
  const preview = await previewPayrollCutoff(String(request.body.payPeriod || ""), request.body.overtimeApprovals);
  response.setHeader("Cache-Control", "no-store");
  response.json({ payPeriod: preview.payPeriod, token: preview.token, rows: preview.rows, totalDifference: preview.totalDifference, canApply: preview.canApply });
}
export async function confirmPayroll(request: Request, response: Response) {
  if (!payrollAccuracyEnabled()) { response.status(404).json({ message: "Payroll accuracy is disabled" }); return; }
  response.json(await applyPayrollCutoff(request));
}
