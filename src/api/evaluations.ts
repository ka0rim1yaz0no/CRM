import { api } from "../lib/api";

export type EmployeeEvaluation = {
    _id: string;
    employee: string | { _id: string; name: string; employeeCode: string; role: string; team: string; status: string; dateHired: string };
    employeeCode: string;
    employeeName: string;
    milestoneMonth: 1 | 3 | 6;
    dueDate: string;
    status: "Draft" | "Completed";
    rating: number | null;
    strengths: string;
    improvementAreas: string;
    managerNotes: string;
    reviewedBy: string;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type EvaluationInput = {
    employeeId?: string;
    milestoneMonth?: number;
    dueDate?: string;
    status: "Draft" | "Completed";
    rating: number | null;
    strengths: string;
    improvementAreas: string;
    managerNotes: string;
    reviewedBy: string;
};

export async function getEvaluations() {
    return (await api.get<EmployeeEvaluation[]>("/evaluations")).data;
}

export async function saveEvaluation(input: EvaluationInput) {
    return (await api.post<EmployeeEvaluation>("/evaluations", input)).data;
}

export async function updateEvaluation(evaluationId: string, input: EvaluationInput) {
    return (await api.patch<EmployeeEvaluation>(`/evaluations/${evaluationId}`, input)).data;
}
