import { Router } from "express";
import { archiveEmployeeAttendance, breakInEmployee, breakOutEmployee, createEmployeeAttendance, listEmployeeAttendance, listEmployeesAttendance, lunchBreakInEmployee, lunchBreakOutEmployee, recordEmployeeActivity, timeInEmployee, timeOutEmployee, updateEmployeeAttendance, updateEmployeeWorkedMinutes } from "../controllers/attendanceController";
import { withAttendanceActionLock } from "../middleware/attendanceActionLock";

export const attendanceRouter = Router();

attendanceRouter.get("/attendance", listEmployeesAttendance);
attendanceRouter.get("/employees/:employeeId/attendance", listEmployeeAttendance);
attendanceRouter.post("/employees/:employeeId/attendance", withAttendanceActionLock(createEmployeeAttendance));
attendanceRouter.put("/employees/:employeeId/attendance/:attendanceId", withAttendanceActionLock(updateEmployeeAttendance));
attendanceRouter.patch("/employees/:employeeId/attendance/worked-minutes", withAttendanceActionLock(updateEmployeeWorkedMinutes));
attendanceRouter.patch("/employees/:employeeId/attendance/:attendanceId/archive", withAttendanceActionLock(archiveEmployeeAttendance));
attendanceRouter.post("/employees/:employeeId/attendance/time-in", withAttendanceActionLock(timeInEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/time-out", withAttendanceActionLock(timeOutEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/break-out", withAttendanceActionLock(breakOutEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/break-in", withAttendanceActionLock(breakInEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/lunch-break-out", withAttendanceActionLock(lunchBreakOutEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/lunch-break-in", withAttendanceActionLock(lunchBreakInEmployee));
attendanceRouter.post("/employees/:employeeId/activity", withAttendanceActionLock(recordEmployeeActivity));
