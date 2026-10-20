import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { displayedQueueChanged, firstDisplayedAutoCallLead, isAutoCallLeadAssigned } from "../lib/displayedAutoCallQueue";
import {
    activateCallBridgeForEmployee,
    callTimingV2Enabled,
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
import { normalizePhoneForCall } from "../lib/phoneNumber";

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

function launchPhoneCall(phone: string) {
    const target = phone.trim();
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

export default function EmployeeAutoCaller() {
    const isChecking = useRef(false);
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const isLeadsPage = useLocation().pathname === "/leads";
    const activeBusinessId = getActiveBusinessId();

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
        const businessId = activeBusinessId;
        const scope = { employeeId, businessId };
        const lastCallStorageKey = `${AUTO_CALL_STORAGE_PREFIX}:${employeeCode}`;
        let isDisposed = false;
        let intervalId: number | undefined;
        let startTimeoutId: number | undefined;
        let redialTimeoutId: number | undefined;
        let redialDeadline = 0;
        const blockedLeadIds = new Set<string>();

        const triggerAutoCall = async () => {
            if (isDisposed || isChecking.current || !isWithinAutoCallWindow()) {
                return;
            }

            const authUser = getAuthUser();

            if (authUser?.userType !== "employee" || authUser.user._id !== employeeId || getActiveBusinessId() !== businessId) {
                return;
            }

            isChecking.current = true;
            let reservedEmployeeCode = "";
            let reservedLeadId = "";
            let reservationToken = "";
            let callWasLaunched = false;
            let providerCallConfirmed = false;
            let reservationNotBefore = 0;

            try {
                const employee = await getEmployeeSummary(employeeId, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });

                if (!isSalesRole(employee.role) || normalizeEmployeeAvailabilityStatus(employee.availabilityStatus) !== "ONLINE") {
                    return;
                }

                if (!callTimingV2Enabled) {
                    const now = Date.now();
                    const lastCallAt = Number(window.localStorage.getItem(lastCallStorageKey) || 0);
                    if (Number.isFinite(lastCallAt) && now - lastCallAt < AUTO_CALL_MIN_INTERVAL_MS) return;
                }

                const bridgeStatus = await getCallBridgeStatus(employee.employeeCode, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });

                if (!bridgeStatus.ready) {
                    const deadline = bridgeStatus.nextCallAllowedAt ? new Date(bridgeStatus.nextCallAllowedAt).getTime() : 0;
                    const serverOffsetMs = callTimingV2Enabled && bridgeStatus.serverTime
                        ? new Date(bridgeStatus.serverTime).getTime() - (bridgeStatus.clientReceivedAt || Date.now()) : 0;
                    const remainingCooldown = deadline - (Date.now() + serverOffsetMs);
                    const canPrepareDuringCooldown =
                        bridgeStatus.connected &&
                        bridgeStatus.nextivaProcessDetected &&
                        bridgeStatus.state === "idle" &&
                        remainingCooldown > 0 &&
                        remainingCooldown <= 10_000;

                    if (canPrepareDuringCooldown) {
                        reservationNotBefore = callTimingV2Enabled ? Date.now() + remainingCooldown : deadline;
                    } else if (remainingCooldown > 0 && deadline !== redialDeadline) {
                        window.clearTimeout(redialTimeoutId);
                        redialDeadline = deadline;
                        redialTimeoutId = window.setTimeout(() => {
                            redialDeadline = 0;
                            void triggerAutoCall();
                        }, Math.max(0, remainingCooldown));
                    }
                    if (!canPrepareDuringCooldown) return;
                }

                window.clearTimeout(redialTimeoutId);
                redialDeadline = 0;

                const employeeNames = Array.from(
                    new Set([employee.name, employee.employeeCode, ...(employee.aliases || [])].filter(Boolean))
                );
                if (!isLeadsPage) {
                    // Open the actual work list before selecting; never dial from an invisible queue.
                    const available = await getNextAutoCallLead({
                        employeeId,
                        employeeNames,
                        excludedLeadIds: Array.from(blockedLeadIds),
                    }, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
                    if (available && !isDisposed && getActiveBusinessId() === businessId) navigate("/leads");
                    return;
                }
                const queueAutoCallLead = firstDisplayedAutoCallLead(scope, employeeNames, blockedLeadIds);
                const firstCallableLead = queueAutoCallLead?.lead;
                const normalizedPhone = queueAutoCallLead?.normalizedPhone;

                if (!firstCallableLead || !normalizedPhone || isDisposed) {
                    return;
                }

                const selectionStillCurrent = () => {
                    const auth = getAuthUser();
                    const head = firstDisplayedAutoCallLead(scope, employeeNames, blockedLeadIds);
                    return !isDisposed && auth?.userType === "employee" && auth.user._id === employeeId &&
                        getActiveBusinessId() === businessId && isWithinAutoCallWindow() &&
                        head?.lead._id === firstCallableLead._id && head.normalizedPhone === normalizedPhone;
                };
                const fresh = await getLead(firstCallableLead._id, { timeoutMs: AUTO_CALL_API_TIMEOUT_MS });
                if (!isAutoCallLeadAssigned(fresh, employeeId, employeeNames) || !isLeadEligibleForAutoCall(fresh, new Date(), employeeNames)) {
                    blockedLeadIds.add(firstCallableLead._id);
                    void queryClient.invalidateQueries({ queryKey: ["leads"] });
                    return;
                }
                if (normalizePhoneForCall(fresh.phone) !== normalizedPhone) {
                    void queryClient.invalidateQueries({ queryKey: ["leads"] });
                    return;
                }
                const pendingComment = getAutoCallPendingComment(employee.employeeCode);

                let reservation: Awaited<ReturnType<typeof reserveCallBridgeCall>>;

                try {
                    if (reservationNotBefore > Date.now()) {
                        await wait(reservationNotBefore - Date.now() + (callTimingV2Enabled ? 0 : 25));
                    }
                    if (!selectionStillCurrent()) return;
                    reservation = await reserveCallBridgeCall(employee.employeeCode, {
                        timeoutMs: AUTO_CALL_API_TIMEOUT_MS,
                        leadId: firstCallableLead._id,
                        businessId,
                        ...(callTimingV2Enabled ? { attemptId: crypto.randomUUID() } : {}),
                    });
                } catch (error) {
                    const terminalErrorCode = getTerminalLeadReservationErrorCode(error);

                    if (terminalErrorCode) {
                        blockedLeadIds.add(firstCallableLead._id);
                        clearAutoCallPendingComment(employee.employeeCode, firstCallableLead._id);
                    }
                    return;
                }

                if (!reservation.allowed) {
                    if (reservation.code) {
                        blockedLeadIds.add(firstCallableLead._id);
                        clearAutoCallPendingComment(employee.employeeCode, firstCallableLead._id);
                    }
                    return;
                }
                reservedEmployeeCode = employee.employeeCode;
                reservedLeadId = firstCallableLead._id;
                reservationToken = reservation.reservationToken;
                if (!selectionStillCurrent()) return;

                const currentPendingComment = getAutoCallPendingComment(employee.employeeCode);
                const selectedPendingLeadId = pendingComment?.leadId || "";

                if ((currentPendingComment?.leadId || "") !== selectedPendingLeadId) {
                    return;
                }

                if (isDisposed || !isWithinAutoCallWindow()) {
                    return;
                }

                if (!isDisposed) {
                    startAutoCallPendingComment(
                        employee.employeeCode,
                        firstCallableLead._id,
                        getEmployeeCommentMarker(firstCallableLead.comments)
                    );

                    const launchedAt = Date.now();
                    if (!callTimingV2Enabled) window.localStorage.setItem(lastCallStorageKey, String(launchedAt));
                    navigate(`/leads?lead=${encodeURIComponent(firstCallableLead._id)}`, {
                        state: { autoCallLead: firstCallableLead, autoCallPreserveFilters: true },
                    });
                    await wait(150);

                    try {
                        if (!selectionStillCurrent()) return;
                        const dialStart = await markCallBridgeDialStarted(employee.employeeCode, {
                            timeoutMs: AUTO_CALL_API_TIMEOUT_MS,
                            leadId: firstCallableLead._id,
                            reservationToken,
                            businessId,
                        });
                        if (callTimingV2Enabled && dialStart.alreadyStarted) {
                            reservedEmployeeCode = "";
                            return;
                        }
                    } catch {
                        clearAutoCallPendingComment(employee.employeeCode, firstCallableLead._id);
                        return;
                    }

                    if (!selectionStillCurrent()) return;
                    launchPhoneCall(normalizedPhone);
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
                            businessId,
                        });
                    } catch {
                        // The lease still expires if the cleanup request cannot reach the server.
                    }
                }
                if (!isDisposed) isChecking.current = false;
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
        const displayedQueueUpdated = () => { void triggerAutoCall(); };
        window.addEventListener(displayedQueueChanged, displayedQueueUpdated);

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
            window.removeEventListener(displayedQueueChanged, displayedQueueUpdated);
            isChecking.current = false;
        };
    }, [navigate, isLeadsPage, queryClient, activeBusinessId]);

    return null;
}
