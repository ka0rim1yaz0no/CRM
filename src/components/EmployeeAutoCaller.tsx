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
import { getLead, getNextAutoCallLead, recordLeadCall } from "../api/leads";
import {
    AUTO_CALL_API_TIMEOUT_MS,
    AUTO_CALL_CHECK_INTERVAL_MS,
    AUTO_CALL_CONFIRM_POLL_MS,
    AUTO_CALL_CONFIRM_TIMEOUT_MS,
    AUTO_CALL_MIN_INTERVAL_MS,
    clearAutoCallPendingComment,
    getAutoCallPendingComment,
    getEmployeeCommentMarker,
    isSalesRole,
    isWithinAutoCallWindow,
    millisecondsUntilAutoCallWindowStart,
    startAutoCallPendingComment,
    isLeadEligibleForAutoCall,
} from "../lib/employeeAutoCall";
import { getRingCentralCallUrl, normalizePhoneForCall } from "../lib/phoneNumber";

const AUTO_CALL_STORAGE_PREFIX = "crm:employee-auto-call";

function wait(milliseconds: number) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForConfirmedCall(
    employeeCode: string,
    previousCallEndedAt: string | null
) {
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

function launchPhoneCall(phone: string, provider: "nextiva" | "ringcentral") {
    const target = phone.trim();
    if (provider === "ringcentral") {
        const callUrl = getRingCentralCallUrl(target);
        if (callUrl) {
            window.location.assign(callUrl);
        }
        return;
    }

    const link = document.createElement("a");
    link.href = `tel:${target}`;
    link.hidden = true;
    link.setAttribute("aria-hidden", "true");
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function getTerminalLeadReservationErrorCode(error: unknown) {
    const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
    return code === "LEAD_ALREADY_COMMENTED" || code === "LEAD_NOT_ASSIGNED" || code === "LEAD_NOT_FOUND" || code === "LEAD_NOT_CALLABLE" ? code : null;
}

function isLeadAssignedToEmployee(
    lead: Awaited<ReturnType<typeof getLead>>,
    employeeId: string,
    employeeNames: string[]
) {
    const assignedAgentId = typeof lead.assignedAgent === "object" && lead.assignedAgent
        ? String(lead.assignedAgent._id || "")
        : String(lead.assignedAgent || "");
    const normalizedEmployeeNames = new Set(employeeNames.map((value) => value.trim().toLowerCase()).filter(Boolean));

    return assignedAgentId === employeeId || normalizedEmployeeNames.has(String(lead.assignedAgentName || "").trim().toLowerCase());
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
            let reservedLeadId = "";
            let reservationToken = "";
            let callWasLaunched = false;
            let providerCallConfirmed = false;

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
                let pendingComment = getAutoCallPendingComment(employee.employeeCode);

                let queueAutoCallLead: Awaited<ReturnType<typeof getNextAutoCallLead>> = null;

                if (pendingComment) {
                    const pendingLeadId = pendingComment.leadId;
                    const baselineCommentMarker = pendingComment.baselineCommentMarker;

                    try {
                        const pendingLead = await getLead(pendingLeadId, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
                        const pendingPhone = normalizePhoneForCall(pendingLead.phone);
                        const commentUnchanged = getEmployeeCommentMarker(pendingLead.comments) === baselineCommentMarker;
                        const stillAssigned = isLeadAssignedToEmployee(pendingLead, employeeId, employeeNames);

                        if (
                            commentUnchanged &&
                            stillAssigned &&
                            pendingPhone &&
                            isLeadEligibleForAutoCall(pendingLead, new Date(), employeeNames)
                        ) {
                            queueAutoCallLead = {
                                lead: pendingLead,
                                normalizedPhone: pendingPhone,
                                queue: pendingLead.status === "Follow up" ? "Follow up" : "NEW",
                            };
                        } else {
                            clearAutoCallPendingComment(employee.employeeCode, pendingLeadId);
                            pendingComment = null;
                        }
                    } catch {
                        clearAutoCallPendingComment(employee.employeeCode, pendingLeadId);
                        pendingComment = null;
                    }
                }

                if (!queueAutoCallLead) {
                    queueAutoCallLead = await getNextAutoCallLead({
                        employeeId,
                        employeeNames,
                    }, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
                }

                const firstCallableLead = queueAutoCallLead?.lead;
                const normalizedPhone = queueAutoCallLead?.normalizedPhone;

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
                    }
                    return;
                }

                if (!reservation.allowed) {
                    return;
                }
                reservedEmployeeCode = employee.employeeCode;
                reservedLeadId = firstCallableLead._id;
                reservationToken = reservation.reservationToken;
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
                            reservationToken,
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

                    launchPhoneCall(normalizedPhone, bridgeStatus.provider);
                    callWasLaunched = true;

                    const callConfirmed = await waitForConfirmedCall(
                        employee.employeeCode,
                        bridgeStatus.lastCallEndedAt
                    );
                    providerCallConfirmed = callConfirmed;

                    if (!callConfirmed) {
                        // Keep the first lead selected so a missed provider confirmation cannot advance the queue.
                    }

                    try {
                        await recordLeadCall(
                            firstCallableLead._id,
                            {
                                activityActorName: employee.name,
                                activityActorType: "employee",
                                employeeId: employee._id,
                                callOutcome: callConfirmed ? "confirmed" : "failed",
                            },
                            { timeoutMs: AUTO_CALL_API_TIMEOUT_MS }
                        );
                    } catch {
                        // The next cycle must continue even if activity logging is unavailable.
                    }

                }
            } catch {
                // A timed-out or unavailable dependency is retried by the next cycle.
            } finally {
                if (reservedEmployeeCode && (!callWasLaunched || !providerCallConfirmed)) {
                    try {
                        await releaseCallBridgeCall(reservedEmployeeCode, {
                            timeoutMs: AUTO_CALL_API_TIMEOUT_MS,
                            leadId: reservedLeadId,
                            reservationToken,
                        });
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
