import { api } from "../lib/api";

export type EmployeeStatus = "Active" | "Training" | "Paused" | "Archived";
export type ContactRelationships = "Father" | "Mother" | "Sibling" | "Spouse" | "Relative" | "Friend";
export type EmployeeAvailabilityStatus = "ONLINE" | "OFFLINE" | "BREAK" | "LUNCH" | "OFF THE PHONE";
export const employeeAvailabilityStatuses: EmployeeAvailabilityStatus[] = ["ONLINE", "OFFLINE", "BREAK", "LUNCH", "OFF THE PHONE"];

export function normalizeEmployeeAvailabilityStatus(value?: string | null): EmployeeAvailabilityStatus {
    const status = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");

    if (status === "ONLINE") return "ONLINE";
    if (status === "OFFLINE") return "OFFLINE";
    if (status === "BREAK" || status === "ON BREAK") return "BREAK";
    if (status === "LUNCH" || status === "LUNCH BREAK") return "LUNCH";
    if (status === "OFF THE PHONE" || status === "IDLE" || status === "COACHING") return "OFF THE PHONE";

    return "OFFLINE";
}

export type Employee = {
    _id: string;
    name: string;
    dateHired: string;
    terminationDate?: string;
    employeeCode: string;
    aliases?: string[];
    role: string;
    team: string;
    company?: string;
    email: string;
    phone: string;
    profileImage?: string;
    personalPhone?: string;
    personalEmail?: string;
    personalAddress?: string;
    emergencyContact?: string;
    contactRelationship?: ContactRelationships;
    emergencyContactNumber?: string;
    personalNotes?: string;
    bankName?: string;
    bankAccountName?: string;
    bankAccountNumber?: string;
    bankRoutingNumber?: string;
    salary: number;
    status: EmployeeStatus;
    availabilityStatus?: EmployeeAvailabilityStatus;
    businessAccessIds?: string[];
};

export type EmployeeInput = Omit<Employee, "_id">;

export type EmployeeProfileInput = Pick<
    Employee,
    "personalPhone" | "personalEmail" | "personalAddress" | "emergencyContact" | "personalNotes" | "contactRelationship" | "emergencyContactNumber" |
    "bankName" | "bankAccountName" | "bankAccountNumber"
>;

export type EmployeeProfileUpdateResponse = {
    message: string;
    employee: Employee;
};

export type EmployeeBankInput = Pick<
    Employee,
    "bankName" | "bankAccountName" | "bankAccountNumber"
>;

type EmployeeListParams = {
    includeArchived?: boolean;
};

function hasEmployeeListParams(params: unknown): params is EmployeeListParams {
    return Boolean(params && typeof params === "object" && "includeArchived" in params);
}

function employeeListParams(params?: unknown) {
    return {
        includeArchived: hasEmployeeListParams(params) && params.includeArchived ? "true" : undefined,
    };
}

export async function getEmployees(params?: EmployeeListParams | unknown) {
    const response = await api.get<Employee[]>("/employees", { params: employeeListParams(params) });
    return response.data;
}

export async function getEmployeeSummaries(params?: EmployeeListParams | unknown) {
    const response = await api.get<Employee[]>("/employees", { params: { summary: true, ...employeeListParams(params) } });
    return response.data;
}

export async function getEmployee(id: string, options: { timeoutMs?: number } = {}) {
    const response = await api.get<Employee>(`/employees/${id}`, { timeout: options.timeoutMs });
    return response.data;
}

export async function getEmployeeSummary(id: string, options: { timeoutMs?: number } = {}) {
    const response = await api.get<Employee>(`/employees/${id}`, {
        params: { summary: true },
        timeout: options.timeoutMs,
    });
    return response.data;
}

export async function createEmployee(employee: EmployeeInput) {
    const response = await api.post<Employee>("/employees", employee);
    return response.data;
}

export async function updateEmployee(id: string, employee: EmployeeInput) {
    const response = await api.put<Employee>(`/employees/${id}`, employee);
    return response.data;
}

export async function updateEmployeeProfile(id: string, employee: EmployeeProfileInput) {
    const response = await api.patch<EmployeeProfileUpdateResponse>(`/employees/${id}/profile`, employee);
    return response.data;
}

export async function updateEmployeeBankDetails(id: string, bank: EmployeeBankInput) {
    const response = await api.patch<Employee>(`/employees/${id}/bank`, bank);
    return response.data;
}

export async function archiveEmployee(id: string) {
    const response = await api.patch<Employee>(`/employees/${id}/archive`);
    return response.data;
}

export async function deleteEmployee(id: string) {
    const response = await api.delete<Employee>(`/employees/${id}`);
    return response.data;
}
