import { Router } from "express";
import { archiveEmployeeAttendance, breakInEmployee, breakOutEmployee, createEmployeeAttendance, listEmployeeAttendance, listEmployeesAttendance, lunchBreakInEmployee, lunchBreakOutEmployee, recordEmployeeActivity, timeInEmployee, timeOutEmployee, updateEmployeeAttendance } from "../controllers/attendanceController";

export const attendanceRouter = Router();

attendanceRouter.get("/attendance", listEmployeesAttendance);
attendanceRouter.get("/employees/:employeeId/attendance", listEmployeeAttendance);
attendanceRouter.post("/employees/:employeeId/attendance", createEmployeeAttendance);
attendanceRouter.put("/employees/:employeeId/attendance/:attendanceId", updateEmployeeAttendance);
attendanceRouter.patch("/employees/:employeeId/attendance/:attendanceId/archive", archiveEmployeeAttendance);
attendanceRouter.post("/employees/:employeeId/attendance/time-in", timeInEmployee);
attendanceRouter.post("/employees/:employeeId/attendance/time-out", timeOutEmployee);
attendanceRouter.post("/employees/:employeeId/attendance/break-out", breakOutEmployee);
attendanceRouter.post("/employees/:employeeId/attendance/break-in", breakInEmployee);
attendanceRouter.post("/employees/:employeeId/attendance/lunch-break-out", lunchBreakOutEmployee);
attendanceRouter.post("/employees/:employeeId/attendance/lunch-break-in", lunchBreakInEmployee);
attendanceRouter.post("/employees/:employeeId/activity", recordEmployeeActivity);
