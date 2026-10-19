import { Router } from "express";
import { archiveEmployeeAttendance, breakInEmployee, breakOutEmployee, createEmployeeAttendance, lunchBreakInEmployee, lunchBreakOutEmployee, recordEmployeeActivity, timeInEmployee, timeOutEmployee, updateEmployeeAttendance, updateEmployeeWorkedMinutes } from "../controllers/attendanceController";
import { withAttendanceActionLock } from "../middleware/attendanceActionLock";
import { exportHubDays, getHubDay, getHubLive, getHubSummary, listHubDays, saveHubDayNote } from "../controllers/attendanceHubController";
import { getActiveAttendanceSession, getAttendanceHistory, getScopedAttendanceList, getAttendancePolicy, getAttendanceMigrationPreview, previewAttendanceCorrection, requireCurrentAttendanceClient, saveAttendancePolicy, submitAttendanceCommand } from "../controllers/attendanceSessionController";

export const attendanceRouter = Router();

attendanceRouter.get("/employees/:employeeId/attendance/session", getActiveAttendanceSession);
attendanceRouter.get("/employees/:employeeId/attendance/migration-preview", getAttendanceMigrationPreview);
attendanceRouter.post("/employees/:employeeId/attendance/commands", submitAttendanceCommand);
attendanceRouter.post("/employees/:employeeId/attendance/preview", previewAttendanceCorrection);
attendanceRouter.get("/attendance-policy", getAttendancePolicy);
attendanceRouter.put("/attendance-policy", saveAttendancePolicy);

attendanceRouter.get("/attendance-hub/summary", getHubSummary);
attendanceRouter.get("/attendance-hub/live", getHubLive);
attendanceRouter.get("/attendance-hub/days", listHubDays);
attendanceRouter.get("/attendance-hub/export", exportHubDays);
attendanceRouter.get("/attendance-hub/day/:dayKey", getHubDay);
attendanceRouter.post("/attendance-hub/day/:dayKey/note", saveHubDayNote);

attendanceRouter.get("/attendance", getScopedAttendanceList);
attendanceRouter.get("/employees/:employeeId/attendance", getAttendanceHistory);
attendanceRouter.post("/employees/:employeeId/attendance", requireCurrentAttendanceClient, withAttendanceActionLock(createEmployeeAttendance));
attendanceRouter.put("/employees/:employeeId/attendance/:attendanceId", requireCurrentAttendanceClient, withAttendanceActionLock(updateEmployeeAttendance));
attendanceRouter.patch("/employees/:employeeId/attendance/worked-minutes", requireCurrentAttendanceClient, withAttendanceActionLock(updateEmployeeWorkedMinutes));
attendanceRouter.patch("/employees/:employeeId/attendance/:attendanceId/archive", requireCurrentAttendanceClient, withAttendanceActionLock(archiveEmployeeAttendance));
attendanceRouter.post("/employees/:employeeId/attendance/time-in", requireCurrentAttendanceClient, withAttendanceActionLock(timeInEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/time-out", requireCurrentAttendanceClient, withAttendanceActionLock(timeOutEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/break-out", requireCurrentAttendanceClient, withAttendanceActionLock(breakOutEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/break-in", requireCurrentAttendanceClient, withAttendanceActionLock(breakInEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/lunch-break-out", requireCurrentAttendanceClient, withAttendanceActionLock(lunchBreakOutEmployee));
attendanceRouter.post("/employees/:employeeId/attendance/lunch-break-in", requireCurrentAttendanceClient, withAttendanceActionLock(lunchBreakInEmployee));
attendanceRouter.post("/employees/:employeeId/activity", requireCurrentAttendanceClient, withAttendanceActionLock(recordEmployeeActivity));
