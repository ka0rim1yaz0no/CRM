import { Router } from "express";
import { verifiedAdminOnly } from "../middleware/businessAccess";
import { payrollAccuracyConfig, previewPayroll, confirmPayroll, previewWorkedHours, confirmWorkedHours, previewPaymentStatus, confirmPaymentStatus } from "../controllers/payrollAccuracyController";
import {
  archivePayrollItem,
  archivePayrollRecord,
  createPayrollItem,
  createPayrollRecord,
  getPayrollDtr,
  listPayrollItems,
  listPayrollCutoffs,
  listPayrollRosterGaps,
  listPayrollRecords,
  listPayrollStats,
  markPayrollRecordPaid,
  markPayrollRecordUnpaid,
  restorePayrollItem,
  restorePayrollRecord,
  runPayroll,
  updatePayrollOvertime,
  updatePayrollRecord,
  updateEmployeeBasicPay,
  updatePayrollWorkedMinutes,
} from "../controllers/payrollController";

export const payrollRouter = Router();
payrollRouter.use(verifiedAdminOnly);
payrollRouter.get("/accuracy-config", payrollAccuracyConfig);
payrollRouter.post("/recompute/preview", previewPayroll);
payrollRouter.post("/recompute/confirm", confirmPayroll);

payrollRouter.get("/stats", listPayrollStats);
payrollRouter.get("/cutoffs", listPayrollCutoffs);
payrollRouter.get("/roster-gaps", listPayrollRosterGaps);
payrollRouter.get("/dtr/:employeeId", getPayrollDtr);
payrollRouter.get("/records", listPayrollRecords);
payrollRouter.post("/records", createPayrollRecord);
payrollRouter.put("/records/:id", updatePayrollRecord);
payrollRouter.patch("/records/:id/overtime", updatePayrollOvertime);
payrollRouter.patch("/records/:id/worked-minutes", updatePayrollWorkedMinutes);
payrollRouter.post("/records/:id/worked-minutes/preview", previewWorkedHours);
payrollRouter.post("/records/:id/worked-minutes/confirm", confirmWorkedHours);
payrollRouter.post("/records/:id/payment-status/preview", previewPaymentStatus);
payrollRouter.post("/records/:id/payment-status/confirm", confirmPaymentStatus);
payrollRouter.patch("/employees/:employeeId/basic-pay", updateEmployeeBasicPay);
payrollRouter.patch("/records/:id/paid", markPayrollRecordPaid);
payrollRouter.patch("/records/:id/unpaid", markPayrollRecordUnpaid);
payrollRouter.patch("/records/:id/archive", archivePayrollRecord);
payrollRouter.patch("/records/:id/restore", restorePayrollRecord);
payrollRouter.post("/run", runPayroll);
payrollRouter.get("/items", listPayrollItems);
payrollRouter.post("/items", createPayrollItem);
payrollRouter.patch("/items/:id/archive", archivePayrollItem);
payrollRouter.patch("/items/:id/restore", restorePayrollItem);
