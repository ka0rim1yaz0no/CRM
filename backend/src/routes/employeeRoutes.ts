import { Router } from "express";
import { getEmployeePayments } from "../controllers/employeePaymentsController";
import {
  archiveEmployee,
  createEmployee,
  deleteEmployee,
  getEmployee,
  listEmployees,
  updateEmployee,
  updateEmployeeBankDetails,
  updateEmployeeProfile,
} from "../controllers/employeeController";

export const employeeRouter = Router();

employeeRouter.get("/", listEmployees);
employeeRouter.get("/:id/payments", getEmployeePayments);
employeeRouter.get("/:id", getEmployee);
employeeRouter.post("/", createEmployee);
employeeRouter.patch("/:id/profile", updateEmployeeProfile);
employeeRouter.patch("/:id/bank", updateEmployeeBankDetails);
employeeRouter.put("/:id", updateEmployee);
employeeRouter.patch("/:id/archive", archiveEmployee);
employeeRouter.delete("/:id", deleteEmployee);
