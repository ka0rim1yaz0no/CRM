type DetailScope = { businessId: string; employeeId: string; employeeSession?: string };
type HandoffReadTicket = { scope: string; leadId: string; revision: number; previousRevision: number | undefined };

export function createLeadDetailReadGuard(scope: DetailScope) {
    const key = JSON.stringify([scope.businessId, scope.employeeId, scope.employeeSession]);
    const blocked = new Map<string, number>();
    return {
        matchesScope: (businessId: string, employeeSession?: string) => businessId === scope.businessId && employeeSession === scope.employeeSession,
        canRead: (leadId: string) => !blocked.has(leadId),
        block(leadId: string, revision: number): HandoffReadTicket {
            const ticket = { scope: key, leadId, revision, previousRevision: blocked.get(leadId) };
            blocked.set(leadId, revision);
            return ticket;
        },
        restore(ticket: HandoffReadTicket) {
            if (ticket.scope !== key || blocked.get(ticket.leadId) !== ticket.revision) return false;
            if (ticket.previousRevision === undefined) blocked.delete(ticket.leadId);
            else blocked.set(ticket.leadId, ticket.previousRevision);
            return true;
        },
        ownedAgain(leadId: string, revision: number) {
            const blockedRevision = blocked.get(leadId);
            if (blockedRevision === undefined || revision <= blockedRevision) return false;
            blocked.delete(leadId);
            return true;
        },
    };
}
