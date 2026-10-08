import { Router } from "express";
import {
  archivePayrollItem,
  archivePayrollRecord,
  createPayrollItem,
  createPayrollRecord,
  getPayrollDtr,
  listPayrollItems,
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
} from "../controllers/payrollController";

export const payrollRouter = Router();

payrollRouter.get("/stats", listPayrollStats);
payrollRouter.get("/dtr/:employeeId", getPayrollDtr);
payrollRouter.get("/records", listPayrollRecords);
payrollRouter.post("/records", createPayrollRecord);
payrollRouter.put("/records/:id", updatePayrollRecord);
payrollRouter.patch("/records/:id/overtime", updatePayrollOvertime);
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
