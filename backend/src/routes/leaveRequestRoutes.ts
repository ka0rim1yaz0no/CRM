import { Router } from "express";
import {
  approveLeaveRequest,
  commentLeaveRequest,
  createEmployeeLeaveRequest,
  listEmployeeLeaveRequests,
  listLeaveRequests,
  rejectLeaveRequest,
  replyToLeaveRequest,
  updateEmployeeLeaveRequest,
} from "../controllers/leaveRequestController";

export const leaveRequestRouter = Router();

leaveRequestRouter.get("/leave-requests", listLeaveRequests);
leaveRequestRouter.get("/employees/:employeeId/leave-requests", listEmployeeLeaveRequests);
leaveRequestRouter.post("/employees/:employeeId/leave-requests", createEmployeeLeaveRequest);
leaveRequestRouter.patch("/employees/:employeeId/leave-requests/:requestId", updateEmployeeLeaveRequest);
leaveRequestRouter.patch("/employees/:employeeId/leave-requests/:requestId/replies", replyToLeaveRequest);
leaveRequestRouter.patch("/leave-requests/:requestId/comment", commentLeaveRequest);
leaveRequestRouter.patch("/leave-requests/:requestId/approve", approveLeaveRequest);
leaveRequestRouter.patch("/leave-requests/:requestId/reject", rejectLeaveRequest);
