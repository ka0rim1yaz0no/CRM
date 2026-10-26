import type { Request, Response } from "express";
import { payrollAccuracyEnabled } from "../config/rolloutFlags";
import { applyPayrollCutoff, previewPayrollCutoff } from "../services/payrollRecomputeService";
import { applyPayrollWorkedHours, previewPayrollWorkedHours } from "../services/payrollWorkedHoursService";
import { confirmPayrollPaymentStatus, previewPayrollPaymentStatus } from "../services/payrollPaymentStatusService";

export function payrollAccuracyConfig(_request: Request, response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.json({ enabled: payrollAccuracyEnabled(), workedHoursEditingEnabled: payrollAccuracyEnabled(), paymentStatusPreviewEnabled: payrollAccuracyEnabled(), cutoffSelectionEnabled: payrollAccuracyEnabled(), employeeRosterEnabled: payrollAccuracyEnabled() });
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
export async function previewWorkedHours(request: Request, response: Response) {
  if (!payrollAccuracyEnabled()) { response.status(404).json({ message: "Payroll accuracy is disabled" }); return; }
  response.setHeader("Cache-Control", "no-store");
  response.json(await previewPayrollWorkedHours(String(request.params.id), request.body.workedMinutes));
}
export async function confirmWorkedHours(request: Request, response: Response) {
  if (!payrollAccuracyEnabled()) { response.status(404).json({ message: "Payroll accuracy is disabled" }); return; }
  response.json(await applyPayrollWorkedHours(request));
}
export async function previewPaymentStatus(request: Request, response: Response) {
  if (!payrollAccuracyEnabled()) { response.status(404).json({ message: "Payroll accuracy is disabled" }); return; }
  response.setHeader("Cache-Control", "no-store");
  response.json(await previewPayrollPaymentStatus(String(request.params.id), request.body.paid));
}
export async function confirmPaymentStatus(request: Request, response: Response) {
  if (!payrollAccuracyEnabled()) { response.status(404).json({ message: "Payroll accuracy is disabled" }); return; }
  response.json(await confirmPayrollPaymentStatus(request));
}
