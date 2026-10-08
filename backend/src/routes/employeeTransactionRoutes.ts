import { Router } from "express";
import { listEmployeeRecentActivity, listEmployeeTransactions } from "../controllers/employeeTransactionController";

export const employeeTransactionRouter = Router();

employeeTransactionRouter.get("/employees/:employeeId/transactions", listEmployeeTransactions);
employeeTransactionRouter.get("/employees/:employeeId/recent-activity", listEmployeeRecentActivity);
