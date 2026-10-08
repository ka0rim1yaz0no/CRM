import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Employee } from "../models/Employee";
import { EmployeeEvaluation } from "../models/EmployeeEvaluation";
import { recordEmployeeTransaction } from "./employeeTransactionController";
import { syncSharedEmployeeRecords, syncSharedEmployeeRecordsToAllBusinesses } from "../services/employeeRecordSyncService";

const allowedMilestones = new Set([1, 3, 6]);

function parseDueDate(value: unknown) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function evaluationValues(body: Record<string, unknown>) {
  const status = body.status === "Completed" ? "Completed" : "Draft";
  const ratingValue = Number(body.rating);
  return {
    status,
    rating: Number.isFinite(ratingValue) && ratingValue >= 1 && ratingValue <= 5 ? ratingValue : null,
    strengths: String(body.strengths || "").trim(),
    improvementAreas: String(body.improvementAreas || "").trim(),
    managerNotes: String(body.managerNotes || "").trim(),
    reviewedBy: String(body.reviewedBy || "Admin").trim() || "Admin",
    completedAt: status === "Completed" ? new Date() : null,
  } as const;
}

export async function listEmployeeEvaluations(request: Request, response: Response) {
  if (request.business?.id) await syncSharedEmployeeRecords(request.business.id);
  const evaluations = await EmployeeEvaluation.find()
    .populate({ path: "employee", select: "name employeeCode role team status dateHired" })
    .sort({ dueDate: 1, employeeName: 1 });
  response.json(evaluations);
}

export async function saveEmployeeEvaluation(request: Request, response: Response) {
  const employeeId = String(request.body.employeeId || "");
  const milestoneMonth = Number(request.body.milestoneMonth);
  const dueDate = parseDueDate(request.body.dueDate);

  if (!Types.ObjectId.isValid(employeeId) || !allowedMilestones.has(milestoneMonth) || !dueDate) {
    response.status(400).json({ message: "Employee, milestone, and due date are required." });
    return;
  }
  const typedMilestone = milestoneMonth as 1 | 3 | 6;

  const employee = await Employee.findById(employeeId).select("name employeeCode").lean();
  if (!employee) {
    response.status(404).json({ message: "Employee not found." });
    return;
  }

  const values = evaluationValues(request.body as Record<string, unknown>);
  if (values.status === "Completed" && values.rating === null) {
    response.status(400).json({ message: "A rating is required to complete an evaluation." });
    return;
  }

  let evaluation = await EmployeeEvaluation.findOne({ employeeCode: employee.employeeCode, milestoneMonth: typedMilestone, dueDate });

  if (evaluation) {
    evaluation.set({
      employee: employee._id,
      employeeName: employee.name,
      ...values,
      completedAt: values.status === "Completed" ? evaluation.completedAt || values.completedAt : null,
    });
    await evaluation.save();
  } else {
    evaluation = await EmployeeEvaluation.create({
      employee: employee._id,
      employeeCode: employee.employeeCode,
      employeeName: employee.name,
      milestoneMonth: typedMilestone,
      dueDate,
      ...values,
    });
  }

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "System",
    title: values.status === "Completed" ? "Evaluation completed" : "Evaluation draft saved",
    description: `${values.reviewedBy} ${values.status === "Completed" ? "completed" : "saved"} the ${milestoneMonth}-month evaluation.`,
    metadata: { evaluationId: evaluation.id, milestoneMonth: typedMilestone, dueDate },
  });
  await syncSharedEmployeeRecordsToAllBusinesses();

  response.json(evaluation);
}

export async function updateEmployeeEvaluation(request: Request, response: Response) {
  if (!Types.ObjectId.isValid(String(request.params.evaluationId))) {
    response.status(400).json({ message: "Invalid evaluation id." });
    return;
  }

  const values = evaluationValues(request.body as Record<string, unknown>);
  if (values.status === "Completed" && values.rating === null) {
    response.status(400).json({ message: "A rating is required to complete an evaluation." });
    return;
  }

  const evaluation = await EmployeeEvaluation.findById(request.params.evaluationId);
  if (!evaluation) {
    response.status(404).json({ message: "Evaluation not found." });
    return;
  }
  evaluation.set({
    ...values,
    completedAt: values.status === "Completed" ? evaluation.completedAt || values.completedAt : null,
  });
  await evaluation.save();

  await recordEmployeeTransaction({
    employee: evaluation.employee,
    category: "System",
    title: values.status === "Completed" ? "Evaluation completed" : "Evaluation draft updated",
    description: `${values.reviewedBy} ${values.status === "Completed" ? "completed" : "updated"} the ${evaluation.milestoneMonth}-month evaluation.`,
    metadata: { evaluationId: String(evaluation._id), milestoneMonth: evaluation.milestoneMonth },
  });
  await syncSharedEmployeeRecordsToAllBusinesses();

  response.json(evaluation);
}
