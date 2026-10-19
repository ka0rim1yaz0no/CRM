import { Router } from "express";
import {
  createEmployeeNotice,
  deleteEmployeeNotice,
  acknowledgeEmployeeNotice,
  listEmployeeNotices,
  listRecentNotices,
  markEmployeeNoticeRead,
  markEmployeeNoticesRead,
  replyToEmployeeNotice,
  updateEmployeeNotice,
} from "../controllers/noticeController";

export const noticeRouter = Router();

noticeRouter.get("/notices", listRecentNotices);
noticeRouter.get("/employees/:employeeId/notices", listEmployeeNotices);
noticeRouter.post("/employees/:employeeId/notices", createEmployeeNotice);
noticeRouter.patch("/employees/:employeeId/notices/read", markEmployeeNoticesRead);
noticeRouter.patch("/employees/:employeeId/notices/:noticeId", updateEmployeeNotice);
noticeRouter.delete("/employees/:employeeId/notices/:noticeId", deleteEmployeeNotice);
noticeRouter.patch("/employees/:employeeId/notices/:noticeId/read", markEmployeeNoticeRead);
noticeRouter.patch("/employees/:employeeId/notices/:noticeId/acknowledge", acknowledgeEmployeeNotice);
noticeRouter.post("/employees/:employeeId/notices/:noticeId/replies", replyToEmployeeNotice);
