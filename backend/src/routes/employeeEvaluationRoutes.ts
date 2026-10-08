import { Router } from "express";
import { listEmployeeEvaluations, saveEmployeeEvaluation, updateEmployeeEvaluation } from "../controllers/employeeEvaluationController";

export const employeeEvaluationRouter = Router();

employeeEvaluationRouter.get("/", listEmployeeEvaluations);
employeeEvaluationRouter.post("/", saveEmployeeEvaluation);
employeeEvaluationRouter.patch("/:evaluationId", updateEmployeeEvaluation);
