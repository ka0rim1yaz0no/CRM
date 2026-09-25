import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { getAuthUser } from "../api/authStorage";
import {
    activateCallBridgeForEmployee,
    getCallBridgeStatus,
    markCallBridgeDialStarted,
    releaseCallBridgeCall,
    reserveCallBridgeCall,
} from "../api/callBridge";
import { getEmployeeSummary, normalizeEmployeeAvailabilityStatus } from "../api/employees";
import { getLead, getNextAutoCallLead, recordLeadCall, type Lead } from "../api/leads";
import {
    AUTO_CALL_API_TIMEOUT_MS,
    AUTO_CALL_CHECK_INTERVAL_MS,
    AUTO_CALL_CONFIRM_POLL_MS,
    AUTO_CALL_CONFIRM_TIMEOUT_MS,
    AUTO_CALL_FAILURE_COOLDOWN_MS,
    AUTO_CALL_MIN_INTERVAL_MS,
    clearAutoCallPendingComment,
    getAutoCallPendingComment,
    getEmployeeCommentMarker,
    isSalesRole,
    isWithinAutoCallWindow,
    millisecondsUntilAutoCallWindowStart,
    millisecondsUntilNextPhilippineDay,
    startAutoCallPendingComment,
} from "../lib/employeeAutoCall";
import { normalizePhoneForCall } from "../lib/phoneNumber";

const AUTO_CALL_STORAGE_PREFIX = "crm:employee-auto-call";
const AUTO_CALL_FAILURE_STORAGE_PREFIX = "crm:employee-auto-call-failures";

function wait(milliseconds: number) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function readFailureCooldowns(storageKey: string, now: number) {
    try {
        const storedValue = JSON.parse(window.localStorage.getItem(storageKey) || "{}") as Record<string, unknown>;
        return Object.fromEntries(
            Object.entries(storedValue)
                .map(([leadId, expiresAt]) => [leadId, Number(expiresAt)] as const)
                .filter(([, expiresAt]) => Number.isFinite(expiresAt) && expiresAt > now)
        );
    } catch {
        return {};
    }
}

function saveFailureCooldowns(storageKey: string, cooldowns: Record<string, number>) {
    try {
        window.localStorage.setItem(storageKey, JSON.stringify(cooldowns));
    } catch {
        // A blocked storage write should not prevent a confirmed call from being handled.
    }
}

async function waitForConfirmedCall(employeeCode: string, previousCallEndedAt: string | null) {
    const confirmationDeadline = Date.now() + AUTO_CALL_CONFIRM_TIMEOUT_MS;
    const previousCallEndedTime = previousCallEndedAt ? new Date(previousCallEndedAt).getTime() : 0;

    while (Date.now() < confirmationDeadline) {
        await wait(AUTO_CALL_CONFIRM_POLL_MS);

        try {
            const bridgeStatus = await getCallBridgeStatus(employeeCode, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
            const lastCallEndedAt = bridgeStatus.lastCallEndedAt ? new Date(bridgeStatus.lastCallEndedAt).getTime() : 0;

            if (bridgeStatus.state === "active" || lastCallEndedAt > previousCallEndedTime) {
                return true;
            }
        } catch {
            // Keep watching until the confirmation window closes.
        }
    }

    return false;
}

function launchPhoneCall(phone: string) {
    const link = document.createElement("a");
    link.href = `tel:${phone.trim()}`;
    link.hidden = true;
    link.setAttribute("aria-hidden", "true");
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function isLeadAssignedToEmployee(lead: Lead, employeeId: string, employeeNames: string[]) {
    const assignedEmployeeId = String(lead.assignedAgent?._id || "").trim();
    const assignedAgentName = String(lead.assignedAgentName || "").trim().toLowerCase();
    const normalizedEmployeeNames = employeeNames.map((name) => String(name).trim().toLowerCase()).filter(Boolean);

    return assignedEmployeeId === employeeId || normalizedEmployeeNames.includes(assignedAgentName);
}

function isMissingLeadError(error: unknown) {
    return (error as { response?: { status?: number } })?.response?.status === 404;
}

function getTerminalLeadReservationErrorCode(error: unknown) {
    const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
    return code === "LEAD_ALREADY_COMMENTED" || code === "LEAD_NOT_FOUND" ? code : null;
}

export default function EmployeeAutoCaller() {
    const isChecking = useRef(false);
    const navigate = useNavigate();

    useEffect(() => {
        const initialAuthUser = getAuthUser();

        if (initialAuthUser?.userType !== "employee") {
            return;
        }

        const employeeCode = String(initialAuthUser.user.employeeCode || "").trim();

        if (!employeeCode || !isSalesRole(initialAuthUser.user.role)) {
            return;
        }

        let isDisposed = false;
        let activationPending = false;

        const activateComputerForCurrentEmployee = async () => {
            const authUser = getAuthUser();

            if (
                isDisposed ||
                activationPending ||
                authUser?.userType !== "employee" ||
                String(authUser.user.employeeCode || "").trim() !== employeeCode
            ) {
                return;
            }

            activationPending = true;

            try {
                await activateCallBridgeForEmployee(employeeCode, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
            } catch {
                // Busy and temporary network states are retried without interrupting CRM use.
            } finally {
                activationPending = false;
            }
        };

        void activateComputerForCurrentEmployee();
        const intervalId = window.setInterval(() => {
            void activateComputerForCurrentEmployee();
        }, AUTO_CALL_CHECK_INTERVAL_MS);

        return () => {
            isDisposed = true;
            window.clearInterval(intervalId);
        };
    }, []);

    useEffect(() => {
        const initialAuthUser = getAuthUser();

        if (initialAuthUser?.userType !== "employee") {
            return;
        }

        const employeeId = initialAuthUser.user._id;
        const employeeCode = String(initialAuthUser.user.employeeCode || employeeId).trim();
        const lastCallStorageKey = `${AUTO_CALL_STORAGE_PREFIX}:${employeeCode}`;
        const failureStorageKey = `${AUTO_CALL_FAILURE_STORAGE_PREFIX}:${employeeCode}`;
        let isDisposed = false;
        let intervalId: number | undefined;
        let startTimeoutId: number | undefined;
        let redialTimeoutId: number | undefined;
        let redialDeadline = 0;

        const triggerAutoCall = async () => {
            if (isDisposed || isChecking.current || !isWithinAutoCallWindow()) {
                return;
            }

            const authUser = getAuthUser();

            if (authUser?.userType !== "employee" || authUser.user._id !== employeeId) {
                return;
            }

            isChecking.current = true;
            let reservedEmployeeCode = "";
            let callWasLaunched = false;

            try {
                const employee = await getEmployeeSummary(employeeId, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });

                if (!isSalesRole(employee.role) || normalizeEmployeeAvailabilityStatus(employee.availabilityStatus) !== "ONLINE") {
                    return;
                }

                const now = Date.now();

                const lastCallAt = Number(window.localStorage.getItem(lastCallStorageKey) || 0);

                if (Number.isFinite(lastCallAt) && now - lastCallAt < AUTO_CALL_MIN_INTERVAL_MS) {
                    return;
                }

                const bridgeStatus = await getCallBridgeStatus(employee.employeeCode, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });

                if (!bridgeStatus.ready) {
                    const deadline = bridgeStatus.nextCallAllowedAt ? new Date(bridgeStatus.nextCallAllowedAt).getTime() : 0;
                    if (deadline > Date.now() && deadline !== redialDeadline) {
                        window.clearTimeout(redialTimeoutId);
                        redialDeadline = deadline;
                        redialTimeoutId = window.setTimeout(() => {
                            redialDeadline = 0;
                            void triggerAutoCall();
                        }, deadline - Date.now() + 50);
                    }
                    return;
                }

                window.clearTimeout(redialTimeoutId);
                redialDeadline = 0;

                const employeeNames = Array.from(
                    new Set([employee.name, employee.employeeCode, ...(employee.aliases || [])].filter(Boolean))
                );
                const failureCooldowns = readFailureCooldowns(failureStorageKey, now);
                saveFailureCooldowns(failureStorageKey, failureCooldowns);
                let pendingComment = getAutoCallPendingComment(employee.employeeCode);
                let nextAutoCallLead: Awaited<ReturnType<typeof getNextAutoCallLead>> = null;

                if (pendingComment) {
                    const pendingLeadId = pendingComment.leadId;

                    try {
                        const pendingLead = await getLead(pendingLeadId, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
                        const normalizedPhone = normalizePhoneForCall(pendingLead.phone);
                        const commentWasAdded =
                            getEmployeeCommentMarker(pendingLead.comments) !== pendingComment.baselineCommentMarker;
                        const remainsCallable =
                            (pendingLead.status === "NEW" || pendingLead.status === "Follow up") &&
                            isLeadAssignedToEmployee(pendingLead, employeeId, employeeNames) &&
                            Boolean(normalizedPhone);

                        if (commentWasAdded || !remainsCallable) {
                            clearAutoCallPendingComment(employee.employeeCode, pendingLead._id);
                            pendingComment = null;
                        } else if (normalizedPhone) {
                            nextAutoCallLead = {
                                lead: pendingLead,
                                normalizedPhone,
                                queue: pendingLead.status === "Follow up" ? "Follow up" : "NEW",
                            };
                        }
                    } catch (error) {
                        if (!isMissingLeadError(error)) {
                            throw error;
                        }

                        clearAutoCallPendingComment(employee.employeeCode, pendingLeadId);
                        pendingComment = null;
                    }
                }

                if (!nextAutoCallLead) {
                    nextAutoCallLead = await getNextAutoCallLead({
                        employeeId,
                        employeeNames,
                        excludedLeadIds: Object.keys(failureCooldowns),
                    }, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
                }
                const firstCallableLead = nextAutoCallLead?.lead;
                const normalizedPhone = nextAutoCallLead?.normalizedPhone;

                if (!firstCallableLead || !normalizedPhone || isDisposed) {
                    return;
                }

                let reservation: Awaited<ReturnType<typeof reserveCallBridgeCall>>;

                try {
                    reservation = await reserveCallBridgeCall(employee.employeeCode, {
                        timeoutMs: AUTO_CALL_API_TIMEOUT_MS,
                        leadId: firstCallableLead._id,
                    });
                } catch (error) {
                    const terminalErrorCode = getTerminalLeadReservationErrorCode(error);

                    if (terminalErrorCode) {
                        clearAutoCallPendingComment(employee.employeeCode, firstCallableLead._id);
                        const failedAt = Date.now();
                        const cooldownDuration = terminalErrorCode === "LEAD_ALREADY_COMMENTED"
                            ? millisecondsUntilNextPhilippineDay(new Date(failedAt))
                            : AUTO_CALL_FAILURE_COOLDOWN_MS;
                        saveFailureCooldowns(failureStorageKey, {
                            ...readFailureCooldowns(failureStorageKey, failedAt),
                            [firstCallableLead._id]: failedAt + cooldownDuration,
                        });
                    }
                    return;
                }

                if (!reservation.allowed) {
                    return;
                }
                reservedEmployeeCode = employee.employeeCode;
                if (isDisposed) return;

                const currentPendingComment = getAutoCallPendingComment(employee.employeeCode);
                const selectedPendingLeadId = pendingComment?.leadId || "";

                if ((currentPendingComment?.leadId || "") !== selectedPendingLeadId) {
                    return;
                }

                if (isDisposed || !isWithinAutoCallWindow()) {
                    return;
                }

                const employeeBeforeCall = await getEmployeeSummary(employeeId, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });

                if (
                    !isSalesRole(employeeBeforeCall.role) ||
                    normalizeEmployeeAvailabilityStatus(employeeBeforeCall.availabilityStatus) !== "ONLINE"
                ) {
                    return;
                }

                const leadBeforeCall = await getLead(firstCallableLead._id, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
                const expectedCommentMarker = pendingComment?.leadId === firstCallableLead._id
                    ? pendingComment.baselineCommentMarker
                    : getEmployeeCommentMarker(firstCallableLead.comments);

                if (getEmployeeCommentMarker(leadBeforeCall.comments) !== expectedCommentMarker) {
                    clearAutoCallPendingComment(employee.employeeCode, firstCallableLead._id);
                    return;
                }

                if (!isDisposed) {
                    startAutoCallPendingComment(
                        employee.employeeCode,
                        firstCallableLead._id,
                        getEmployeeCommentMarker(firstCallableLead.comments)
                    );

                    const launchedAt = Date.now();
                    window.localStorage.setItem(lastCallStorageKey, String(launchedAt));
                    navigate(`/leads?lead=${encodeURIComponent(firstCallableLead._id)}`, {
                        state: { autoCallLead: firstCallableLead },
                    });
                    await wait(150);

                    try {
                        await markCallBridgeDialStarted(employee.employeeCode, {
                            timeoutMs: AUTO_CALL_API_TIMEOUT_MS,
                            leadId: firstCallableLead._id,
                        });
                    } catch {
                        clearAutoCallPendingComment(employee.employeeCode, firstCallableLead._id);
                        return;
                    }

                    const pendingImmediatelyBeforeDial = getAutoCallPendingComment(employee.employeeCode);
                    const leadImmediatelyBeforeDial = await getLead(firstCallableLead._id, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });

                    if (
                        pendingImmediatelyBeforeDial?.leadId !== firstCallableLead._id ||
                        getEmployeeCommentMarker(leadImmediatelyBeforeDial.comments) !== expectedCommentMarker
                    ) {
                        clearAutoCallPendingComment(employee.employeeCode, firstCallableLead._id);
                        return;
                    }

                    launchPhoneCall(normalizedPhone);
                    callWasLaunched = true;

                    const callConfirmed = await waitForConfirmedCall(employee.employeeCode, bridgeStatus.lastCallEndedAt);

                    if (!callConfirmed) {
                        clearAutoCallPendingComment(employee.employeeCode, firstCallableLead._id);
                        saveFailureCooldowns(failureStorageKey, {
                            ...readFailureCooldowns(failureStorageKey, Date.now()),
                            [firstCallableLead._id]: Date.now() + AUTO_CALL_FAILURE_COOLDOWN_MS,
                        });
                    }

                    try {
                        await recordLeadCall(
                            firstCallableLead._id,
                            {
                                activityActorName: employee.name,
                                activityActorType: "employee",
                                callOutcome: callConfirmed ? "confirmed" : "failed",
                            },
                            { timeoutMs: AUTO_CALL_API_TIMEOUT_MS }
                        );
                    } catch {
                        // The next cycle must continue even if activity logging is unavailable.
                    }

                    if (!callConfirmed) {
                        try {
                            await releaseCallBridgeCall(employee.employeeCode, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
                        } catch {
                            // The original lease expires automatically if release cannot be confirmed.
                        }
                    }
                }
            } catch {
                // A timed-out or unavailable dependency is retried by the next cycle.
            } finally {
                if (reservedEmployeeCode && !callWasLaunched) {
                    try {
                        await releaseCallBridgeCall(reservedEmployeeCode, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
                    } catch {
                        // The lease still expires if the cleanup request cannot reach the server.
                    }
                }
                isChecking.current = false;
            }
        };

        const startAutoCallCycle = () => {
            if (isDisposed) {
                return;
            }

            void triggerAutoCall();
            intervalId = window.setInterval(() => {
                void triggerAutoCall();
            }, AUTO_CALL_CHECK_INTERVAL_MS);
        };

        const startDelay = millisecondsUntilAutoCallWindowStart();

        if (startDelay === 0) {
            startAutoCallCycle();
        } else {
            startTimeoutId = window.setTimeout(startAutoCallCycle, startDelay);
        }

        return () => {
            isDisposed = true;
            window.clearTimeout(startTimeoutId);
            window.clearTimeout(redialTimeoutId);
            window.clearInterval(intervalId);
            isChecking.current = false;
        };
    }, [navigate]);

    return null;
}
