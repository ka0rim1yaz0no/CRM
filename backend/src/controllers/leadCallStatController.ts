import { Lead } from "../models/Lead";
import { Employee } from "../models/Employee";
import { LeadCallStat } from "../models/leadCallStat";
import { getCallBridgeAttemptModel } from "../models/CallBridge";
import { getCallProvider } from "../config/callProvider";
import { Types } from "mongoose";

type LeadCallOutcome = "connected" | "not_connected" | "voicemail";

function getRequestEmployeeId(req: any) {
    return (
        req.employee?._id ||
        req.user?.employeeId ||
        req.user?.employee?._id ||
        req.user?._id ||
        req.body?.employeeId ||
        req.query?.employeeId ||
        null
    );
}

function getEmployeeTeamValue(team: unknown) {
    if (!team) {
        return "";
    }

    if (typeof team === "string") {
        return team;
    }

    if (team instanceof Types.ObjectId) {
        return String(team);
    }

    if (typeof team === "object" && "name" in team) {
        return String((team as { name?: unknown }).name || "");
    }

    return String(team);
}

async function holdLeadAfterCallOutcome(
    leadId: Types.ObjectId,
    employee: { _id: Types.ObjectId; name?: string; employeeCode?: string; role?: string; team?: unknown },
    calledAt: Date
) {
    const employeeName = employee.name || employee.employeeCode || "Employee";
    const employeeRole = employee.role || "";
    const employeeTeam = getEmployeeTeamValue(employee.team);
    const existingRow = await Lead.updateOne(
        { _id: leadId, "callsByEmployee.employee": employee._id },
        {
            $set: {
                lastCallAt: calledAt,
                "callsByEmployee.$.lastCallAt": calledAt,
                "callsByEmployee.$.employeeName": employeeName,
                "callsByEmployee.$.employeeRole": employeeRole,
                "callsByEmployee.$.employeeTeam": employeeTeam,
            },
        }
    );

    if (existingRow.matchedCount > 0) {
        return;
    }

    await Lead.updateOne(
        {
            _id: leadId,
            callsByEmployee: { $not: { $elemMatch: { employee: employee._id } } },
        },
        {
            $set: { lastCallAt: calledAt },
            $push: {
                callsByEmployee: {
                    employee: employee._id,
                    employeeName,
                    employeeRole,
                    employeeTeam,
                    count: 0,
                    lastCallAt: calledAt,
                },
            },
        }
    );
}

function getLogOutcome(log: any): LeadCallOutcome {
    if (log?.outcome === "not_connected" || log?.outcome === "voicemail") {
        return log.outcome;
    }

    return "connected";
}

function getLatestCallDate(callLogs: any[]) {
    return callLogs.reduce<Date | null>((latestDate, log) => {
        const calledAt = log?.calledAt ? new Date(log.calledAt) : null;

        if (!calledAt || Number.isNaN(calledAt.getTime())) {
            return latestDate;
        }

        if (!latestDate) {
            return calledAt;
        }

        return calledAt.getTime() > latestDate.getTime() ? calledAt : latestDate;
    }, null);
}

function getDayRange(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);

    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    return { start, end };
}

function normalizeCallStatForResponse(callStat: any) {
    const callLogs = (callStat?.callLogs || []).map((log: any) => ({
        ...log,
        outcome: getLogOutcome(log),
    }));

    const connectedLogs = callLogs.filter(
        (log: any) => getLogOutcome(log) === "connected"
    );

    const notConnectedLogs = callLogs.filter(
        (log: any) => getLogOutcome(log) === "not_connected"
    );

    const voicemailLogs = callLogs.filter(
        (log: any) => getLogOutcome(log) === "voicemail"
    );

    return {
        ...callStat,
        callCount: Number(callStat?.callCount || 0),
        callNotConnectedCount: Number(callStat?.callNotConnectedCount || 0),
        callVoicemailCount: Number(callStat?.callVoicemailCount || 0),
        lastCallAt: callStat?.lastCallAt || getLatestCallDate(connectedLogs),
        lastNotConnectedAt:
            callStat?.lastNotConnectedAt || getLatestCallDate(notConnectedLogs),
        lastVoicemailAt:
            callStat?.lastVoicemailAt || getLatestCallDate(voicemailLogs),
        callLogs,
    };
}

async function createLeadCallLogUpdate(req: any, res: any, outcome: LeadCallOutcome) {
    try {
        const leadId = req.params.id;

        if (!Types.ObjectId.isValid(leadId)) {
            return res.status(400).json({
                message: "Invalid lead ID.",
            });
        }

        const currentEmployeeId = getRequestEmployeeId(req);

        if (!currentEmployeeId || !Types.ObjectId.isValid(String(currentEmployeeId))) {
            return res.status(401).json({
                message: "Employee session not found.",
            });
        }

        const [lead, employee] = await Promise.all([
            Lead.findById(leadId).select("_id leadName businessName"),
            Employee.findById(currentEmployeeId).select("_id name role team employeeCode"),
        ]);
        if (!lead) {
            return res.status(404).json({
                message: "Lead not found.",
            });
        }

        if (!employee) {
            return res.status(404).json({
                message: "Employee not found.",
            });
        }

        const now = new Date();
        // const { start, end } = getDayRange(now);

        // Only one call action per lead, per employee, per day.
        // If Log Call was clicked today, Not Connected is blocked too, and vice versa.
        // const alreadyLoggedToday = await LeadCallStat.exists({
        //     lead: lead._id,
        //     callLogs: {
        //         $elemMatch: {
        //             employee: employee._id,
        //             calledAt: {
        //                 $gte: start,
        //                 $lte: end,
        //             },
        //         },
        //     },
        // });

        // if (alreadyLoggedToday) {
        //     return res.status(409).json({
        //         message: "A call action has already been logged today for this lead.",
        //     });
        // }

        const employeeName = employee.name || employee.employeeCode || "Employee";
        const employeeRole = employee.role || "";
        const employeeTeam = getEmployeeTeamValue(employee.team);
        const attempt = getCallProvider() === "ringcentral"
            ? await getCallBridgeAttemptModel().findOne({
                employeeCode: employee.employeeCode,
                businessId: req.business?.id || "",
                leadId,
                providerSessionId: { $exists: true, $ne: "" },
                reservedAt: { $gte: new Date(now.getTime() - 6 * 60 * 60_000) },
              }).sort({ reservedAt: -1 })
            : null;
        const callLogId = new Types.ObjectId();

        const callLog = {
            _id: callLogId,
            employee: employee._id,
            employeeName,
            employeeRole,
            employeeTeam,
            outcome,
            calledAt: now,
            ...(attempt ? {
                provider: "ringcentral",
                providerSessionId: attempt.providerSessionId,
                providerResult: attempt.providerResult || "RingCentral session confirmed",
                verificationSource: "manual" as const,
                durationSeconds: attempt.durationSeconds || 0,
            } : {}),
        };

        const update: any = {
            $setOnInsert: {
                lead: lead._id,
            },
            $set: {
                leadName: lead.leadName || "",
                businessName: lead.businessName || "",
            },
            $push: {
                callLogs: callLog,
            },
        };

        if (outcome === "not_connected") {
            update.$inc = {
                callNotConnectedCount: 1,
            };

            update.$set.lastNotConnectedAt = now;
        } else if (outcome === "voicemail") {
            update.$inc = {
                callVoicemailCount: 1,
            };

            update.$set.lastVoicemailAt = now;
        } else {
            update.$inc = {
                callCount: 1,
            };

            update.$set.lastCallAt = now;
        }

        const callStat = await LeadCallStat.findOneAndUpdate(
            {
                lead: lead._id,
            },
            update,
            {
                returnDocument: "after",
                upsert: true,
                runValidators: true,
                setDefaultsOnInsert: true,
            }
        ).lean();

        await holdLeadAfterCallOutcome(lead._id, employee, now);

        if (attempt) {
            attempt.phase = "classified";
            attempt.outcome = outcome;
            attempt.outcomeReason = "Outcome selected manually in the CRM";
            attempt.classificationConfidence = "high";
            attempt.classificationSource = "manual";
            attempt.classifiedAt = now;
            attempt.callStatLogId = String(callLogId);
            await attempt.save();
        }

        return res.json(normalizeCallStatForResponse(callStat));
    } catch (error) {
        console.error("Lead call stat error:", error);

        return res.status(500).json({
            message:
                outcome === "not_connected"
                    ? "Could not log not connected."
                    : outcome === "voicemail"
                      ? "Could not log voicemail."
                      : "Could not log call.",
        });
    }
}

export async function logConnectedCall(req: any, res: any) {
    return createLeadCallLogUpdate(req, res, "connected");
}

export async function logNotConnectedCall(req: any, res: any) {
    return createLeadCallLogUpdate(req, res, "not_connected");
}

export async function logVoicemailCall(req: any, res: any) {
    return createLeadCallLogUpdate(req, res, "voicemail");
}

export async function getLeadCallStat(req: any, res: any) {
    try {
        const leadId = req.params.id;

        if (!Types.ObjectId.isValid(leadId)) {
            return res.status(400).json({
                message: "Invalid lead ID.",
            });
        }

        const callStat = await LeadCallStat.findOne({
            lead: leadId,
        }).lean();

        if (callStat) {
            return res.json(normalizeCallStatForResponse(callStat));
        }

        const lead = await Lead.findById(leadId)
            .select("_id leadName businessName")
            .lean();

        if (!lead) {
            return res.status(404).json({
                message: "Lead not found.",
            });
        }

        return res.json({
            lead: lead._id,
            leadName: lead.leadName || "",
            businessName: lead.businessName || "",
            callCount: 0,
            callNotConnectedCount: 0,
            callVoicemailCount: 0,
            lastCallAt: null,
            lastNotConnectedAt: null,
            lastVoicemailAt: null,
            callLogs: [],
        });
    } catch (error) {
        console.error("Get lead call stat error:", error);

        return res.status(500).json({
            message: "Could not load lead call data.",
        });
    }
}

export async function getLeadCallStats(req: any, res: any) {
    try {
        const callStats = await LeadCallStat.find({})
            .sort({
                lastCallAt: -1,
            })
            .lean();

        return res.json(callStats.map(normalizeCallStatForResponse));
    } catch (error) {
        console.error("Get lead call stats error:", error);

        return res.status(500).json({
            message: "Could not load lead call stats.",
        });
    }
}

function optionalCallSummaryDate(value: unknown) {
    const date = value ? new Date(String(value)) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
}

async function sendLeadCallSummary(req: any, res: any, employeeOnly: boolean) {
    try {
        const employeeId = employeeOnly ? getRequestEmployeeId(req) : null;

        if (employeeOnly && (!employeeId || !Types.ObjectId.isValid(String(employeeId)))) {
            return res.status(401).json({ message: "Employee session not found." });
        }

        const from = optionalCallSummaryDate(req.query?.from);
        const to = optionalCallSummaryDate(req.query?.to);
        const logMatch: Record<string, unknown> = {};

        if (employeeId) {
            logMatch["callLogs.employee"] = new Types.ObjectId(String(employeeId));
        }

        if (from || to) {
            logMatch["callLogs.calledAt"] = {
                ...(from ? { $gte: from } : {}),
                ...(to ? { $lte: to } : {}),
            };
        }

        const employeeFilter: Record<string, unknown> = {
            status: { $ne: "Archived" },
        };

        if (employeeId) {
            employeeFilter._id = new Types.ObjectId(String(employeeId));
        } else {
            employeeFilter.role = /sales/i;
        }

        const [rows, employees] = await Promise.all([
            LeadCallStat.aggregate([
                { $unwind: "$callLogs" },
                ...(Object.keys(logMatch).length ? [{ $match: logMatch }] : []),
                {
                    $group: {
                        _id: { employee: "$callLogs.employee", lead: "$lead" },
                        employeeName: { $last: "$callLogs.employeeName" },
                        employeeRole: { $last: "$callLogs.employeeRole" },
                        employeeTeam: { $last: "$callLogs.employeeTeam" },
                        leadName: { $last: "$leadName" },
                        businessName: { $last: "$businessName" },
                        callCount: {
                            $sum: {
                                $cond: [
                                    { $eq: [{ $ifNull: ["$callLogs.outcome", "connected"] }, "connected"] },
                                    1,
                                    0,
                                ],
                            },
                        },
                        callNotConnectedCount: {
                            $sum: { $cond: [{ $eq: ["$callLogs.outcome", "not_connected"] }, 1, 0] },
                        },
                        callVoicemailCount: {
                            $sum: { $cond: [{ $eq: ["$callLogs.outcome", "voicemail"] }, 1, 0] },
                        },
                        totalAttempts: { $sum: 1 },
                        lastCallAt: { $max: "$callLogs.calledAt" },
                    },
                },
                { $sort: { lastCallAt: -1 as const } },
                {
                    $group: {
                        _id: "$_id.employee",
                        employeeName: { $first: "$employeeName" },
                        employeeRole: { $first: "$employeeRole" },
                        employeeTeam: { $first: "$employeeTeam" },
                        totalCalls: { $sum: "$callCount" },
                        totalNotConnectedCalls: { $sum: "$callNotConnectedCount" },
                        totalVoicemails: { $sum: "$callVoicemailCount" },
                        totalAttempts: { $sum: "$totalAttempts" },
                        lastCallAt: { $max: "$lastCallAt" },
                        leads: {
                            $push: {
                                leadId: { $toString: "$_id.lead" },
                                leadName: "$leadName",
                                businessName: "$businessName",
                                callCount: "$callCount",
                                callNotConnectedCount: "$callNotConnectedCount",
                                callVoicemailCount: "$callVoicemailCount",
                                totalAttempts: "$totalAttempts",
                                lastCallAt: "$lastCallAt",
                            },
                        },
                    },
                },
                { $sort: { lastCallAt: -1 as const } },
            ]),
            Employee.find(employeeFilter).select("name role team").lean(),
        ]);

        const summaryRows = rows.map((row: any) => ({
            employeeId: String(row._id || ""),
            employeeName: row.employeeName || "Employee",
            crmBusinessId: String(req.business?.id || ""),
            crmBusinessName: String(req.business?.name || "Current business"),
            employeeRole: row.employeeRole || "",
            employeeTeam: row.employeeTeam || "",
            totalCalls: Number(row.totalCalls || 0),
            totalNotConnectedCalls: Number(row.totalNotConnectedCalls || 0),
            totalVoicemails: Number(row.totalVoicemails || 0),
            totalAttempts: Number(row.totalAttempts || 0),
            lastCallAt: row.lastCallAt || null,
            leads: row.leads || [],
        }));
        const summaryRowsByEmployeeId = new Map<string, any>(
            summaryRows.map((row: any) => [row.employeeId, row])
        );
        const rowsByEmployeeId = new Map<string, any>();

        for (const employee of employees) {
            const currentEmployeeId = String(employee._id);
            const existing = summaryRowsByEmployeeId.get(currentEmployeeId);

            rowsByEmployeeId.set(currentEmployeeId, {
                employeeId: currentEmployeeId,
                employeeName: employee.name || existing?.employeeName || "Employee",
                crmBusinessId: String(req.business?.id || ""),
                crmBusinessName: String(req.business?.name || "Current business"),
                employeeRole: employee.role || existing?.employeeRole || "",
                employeeTeam: getEmployeeTeamValue(employee.team) || existing?.employeeTeam || "",
                totalCalls: existing?.totalCalls || 0,
                totalNotConnectedCalls: existing?.totalNotConnectedCalls || 0,
                totalVoicemails: existing?.totalVoicemails || 0,
                totalAttempts: existing?.totalAttempts || 0,
                lastCallAt: existing?.lastCallAt || null,
                leads: existing?.leads || [],
            });
        }

        return res.json(Array.from(rowsByEmployeeId.values()).sort((first, second) => {
            const firstCallAt = first.lastCallAt ? new Date(first.lastCallAt).getTime() : 0;
            const secondCallAt = second.lastCallAt ? new Date(second.lastCallAt).getTime() : 0;

            if (firstCallAt !== secondCallAt) {
                return secondCallAt - firstCallAt;
            }

            return first.employeeName.localeCompare(second.employeeName);
        }));
    } catch (error) {
        console.error("Get lead call summary error:", error);
        return res.status(500).json({ message: "Could not load lead call summary." });
    }
}

export async function getLeadCallSummary(req: any, res: any) {
    return sendLeadCallSummary(req, res, false);
}

export async function getMyLeadCallSummary(req: any, res: any) {
    return sendLeadCallSummary(req, res, true);
}

export async function getMyLeadCallStats(req: any, res: any) {
    try {
        const currentEmployeeId = getRequestEmployeeId(req);

        if (!currentEmployeeId || !Types.ObjectId.isValid(String(currentEmployeeId))) {
            return res.status(401).json({
                message: "Employee session not found.",
            });
        }

        const employeeObjectId = new Types.ObjectId(String(currentEmployeeId));

        const callStats = await LeadCallStat.find({
            "callLogs.employee": employeeObjectId,
        })
            .sort({
                lastCallAt: -1,
            })
            .lean();

        const filteredCallStats = callStats
            .map((item) => {
                const callLogs = (item.callLogs || []).filter(
                    (log: any) => String(log.employee) === String(employeeObjectId)
                );

                const connectedLogs = callLogs.filter(
                    (log: any) => getLogOutcome(log) === "connected"
                );

                const notConnectedLogs = callLogs.filter(
                    (log: any) => getLogOutcome(log) === "not_connected"
                );

                const voicemailLogs = callLogs.filter(
                    (log: any) => getLogOutcome(log) === "voicemail"
                );

                return normalizeCallStatForResponse({
                    ...item,
                    callLogs,
                    callCount: connectedLogs.length,
                    callNotConnectedCount: notConnectedLogs.length,
                    callVoicemailCount: voicemailLogs.length,
                    lastCallAt: getLatestCallDate(connectedLogs),
                    lastNotConnectedAt: getLatestCallDate(notConnectedLogs),
                    lastVoicemailAt: getLatestCallDate(voicemailLogs),
                });
            })
            .filter((item) => item.callLogs.length > 0);

        return res.json(filteredCallStats);
    } catch (error) {
        console.error("Get my lead call stats error:", error);

        return res.status(500).json({
            message: "Could not load your lead call stats.",
        });
    }
}
