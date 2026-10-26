import type { Request, Response } from "express";
import { Types } from "mongoose";
import { signedCrmIdentity, signedEmployeeInBusiness } from "../middleware/legacyAuthentication";
import { Employee } from "../models/Employee";
import { employeePayments } from "../services/employeePayments";

export async function getEmployeePayments(request: Request, response: Response) {
    response.setHeader("Cache-Control", "no-store, private");
    response.setHeader("Vary", "X-Business-Id, X-CRM-Admin-Session, X-CRM-Attendance-Session");
    const actor = signedCrmIdentity(request.header("x-crm-admin-session"), request.header("x-crm-attendance-session"));
    if (!actor) { response.status(401).json({ code: "CRM_SESSION_REQUIRED", message: "Sign in again to view payments." }); return; }
    if (actor.access === "tracker") { response.status(403).json({ message: "Payment access is not permitted." }); return; }
    const id = String(request.params.id || "");
    if (!Types.ObjectId.isValid(id)) { response.status(400).json({ message: "Invalid employee." }); return; }
    const employee = actor.type === "employee"
        ? await signedEmployeeInBusiness(actor.code, request.business?.id || "")
        : await Employee.findOne({ _id: id, status: { $ne: "Archived" } }).select("_id employeeCode").lean();
    if (!employee || String(employee._id) !== id || !employee.employeeCode) { response.status(403).json({ message: "Payment access is not permitted." }); return; }
    const page = Number(request.query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) { response.status(400).json({ message: "Invalid payment page." }); return; }
    const view = String(request.query.view || "current");
    if (view !== "current" && view !== "history") { response.status(400).json({ message: "Invalid payment cutoff view." }); return; }
    response.json(await employeePayments(employee.employeeCode, page, view));
}
