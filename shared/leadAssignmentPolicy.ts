export type SalesEmployee = { role?: unknown; team?: unknown; status?: unknown };

export function isSalesEmployee(employee: SalesEmployee) {
    return /sales/i.test(String(employee.role || "")) || /sales/i.test(String(employee.team || ""));
}

export function isEligibleLeadRecipient(employee: SalesEmployee) {
    return isSalesEmployee(employee) && (employee.status === "Active" || employee.status === "Training");
}

export function leadOwnerId(lead: { assignedAgent?: unknown }) {
    const owner = lead.assignedAgent;
    return String(owner && typeof owner === "object" && "_id" in owner ? owner._id : owner || "");
}

export function leadBelongsToEmployee(lead: { assignedAgent?: unknown; assignedAgentName?: string }, employeeId: string, names: string[]) {
    const ownerId = leadOwnerId(lead);
    return ownerId ? ownerId === employeeId : names.includes(lead.assignedAgentName || "");
}
