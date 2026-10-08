import { Types } from "mongoose";
import { runWithBusiness } from "../config/tenancy";
import { Employee } from "../models/Employee";
import { Lead } from "../models/Lead";
import { LeadCallStat, type LeadCallOutcome } from "../models/leadCallStat";
import { emitLeadCallStatUpdated } from "../socket";

type RingCentralCallOutcomeInput = {
  attemptId: string;
  businessId: string;
  leadId: string;
  employeeCode: string;
  outcome: LeadCallOutcome;
  providerSessionId: string;
  providerResult: string;
  durationSeconds: number;
  calledAt: Date;
};

function outcomeCounterUpdate(outcome: LeadCallOutcome, calledAt: Date) {
  if (outcome === "not_connected") {
    return {
      increment: { callNotConnectedCount: 1 },
      latest: { lastNotConnectedAt: calledAt },
    };
  }

  if (outcome === "voicemail") {
    return {
      increment: { callVoicemailCount: 1 },
      latest: { lastVoicemailAt: calledAt },
    };
  }

  return {
    increment: { callCount: 1 },
    latest: { lastCallAt: calledAt },
  };
}

export async function persistRingCentralCallOutcome(input: RingCentralCallOutcomeInput) {
  if (!Types.ObjectId.isValid(input.attemptId) || !Types.ObjectId.isValid(input.leadId)) {
    throw new Error("Automatic call outcome references an invalid call attempt or lead.");
  }

  return runWithBusiness(input.businessId, async () => {
    const [employee, lead] = await Promise.all([
      Employee.findOne({ employeeCode: input.employeeCode, status: { $ne: "Archived" } })
        .select("_id name role team employeeCode")
        .lean(),
      Lead.findById(input.leadId).select("_id leadName businessName").lean(),
    ]);

    if (!employee || !lead) {
      throw new Error("Automatic call outcome could not find its employee or lead.");
    }

    const callLogId = new Types.ObjectId(input.attemptId);
    const employeeName = employee.name || employee.employeeCode || "Employee";
    const callLog = {
      _id: callLogId,
      employee: employee._id,
      employeeName,
      employeeRole: employee.role || "",
      employeeTeam: employee.team ? String(employee.team) : "",
      outcome: input.outcome,
      calledAt: input.calledAt,
      provider: "ringcentral",
      providerSessionId: input.providerSessionId,
      providerResult: input.providerResult || "RingCentral automatic classification",
      verificationSource: "ringcentral" as const,
      durationSeconds: Math.max(0, Number(input.durationSeconds) || 0),
    };
    const counter = outcomeCounterUpdate(input.outcome, input.calledAt);
    const update = {
      $set: {
        leadName: lead.leadName || "",
        businessName: lead.businessName || "",
        ...counter.latest,
      },
      $inc: counter.increment,
      $push: { callLogs: callLog },
    };

    let callStat = await LeadCallStat.findOneAndUpdate(
      {
        lead: lead._id,
        callLogs: { $not: { $elemMatch: { providerSessionId: input.providerSessionId } } },
      },
      update,
      { returnDocument: "after", runValidators: true }
    ).lean();

    if (!callStat) {
      const existingCall = await LeadCallStat.exists({
        lead: lead._id,
        "callLogs.providerSessionId": input.providerSessionId,
      });

      if (!existingCall) {
        try {
          callStat = (await LeadCallStat.create({
            lead: lead._id,
            leadName: lead.leadName || "",
            businessName: lead.businessName || "",
            callCount: input.outcome === "connected" ? 1 : 0,
            callNotConnectedCount: input.outcome === "not_connected" ? 1 : 0,
            callVoicemailCount: input.outcome === "voicemail" ? 1 : 0,
            lastCallAt: input.outcome === "connected" ? input.calledAt : null,
            lastNotConnectedAt: input.outcome === "not_connected" ? input.calledAt : null,
            lastVoicemailAt: input.outcome === "voicemail" ? input.calledAt : null,
            callLogs: [callLog],
          })).toObject();
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;

          callStat = await LeadCallStat.findOneAndUpdate(
            {
              lead: lead._id,
              callLogs: { $not: { $elemMatch: { providerSessionId: input.providerSessionId } } },
            },
            update,
            { returnDocument: "after", runValidators: true }
          ).lean();
        }
      }
    }

    emitLeadCallStatUpdated(input.businessId, {
      leadId: String(lead._id),
      employeeId: String(employee._id),
      outcome: input.outcome,
    });

    return { callLogId: String(callLogId), callStat };
  });
}
