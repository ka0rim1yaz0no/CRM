import type { Request, Response } from "express";
import { Types } from "mongoose";
import { EmployeeTransaction } from "../models/EmployeeTransaction";
import { Lead, type LeadStatus } from "../models/Lead";
import { LeadCallStat } from "../models/leadCallStat";

type TransactionInput = {
  employee: Types.ObjectId | string;
  category: "Attendance" | "Notice" | "Lead" | "Message" | "System";
  title: string;
  description: string;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
};

export async function recordEmployeeTransaction(transaction: TransactionInput) {
  return EmployeeTransaction.create({
    ...transaction,
    occurredAt: transaction.occurredAt || new Date(),
  });
}

export async function listEmployeeTransactions(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const date = String(request.query.date || "").trim();
  const filter: Record<string, unknown> = { employee: employeeId };

  if (date) {
    const start = new Date(`${date}T00:00:00.000-05:00`);
    const end = new Date(`${date}T23:59:59.999-05:00`);

    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      filter.occurredAt = { $gte: start, $lte: end };
    }
  }

  const transactions = await EmployeeTransaction.find(filter).sort({ occurredAt: -1 });

  response.json(transactions);
}

export async function listEmployeeRecentActivity(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  if (!Types.ObjectId.isValid(employeeId)) {
    response.status(400).json({ message: "Invalid employee id" });
    return;
  }

  const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), 25);
  const offset = Math.min(Math.max(Number(request.query.offset) || 0, 0), 500);
  const employeeObjectId = new Types.ObjectId(employeeId);
  const activityQuery = EmployeeTransaction.find({ employee: employeeObjectId })
      .sort({ occurredAt: -1, _id: -1 })
      .skip(offset)
      .limit(limit + 1)
      .select("category title description occurredAt createdAt")
      .lean();
  const activeStatuses: LeadStatus[] = ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation"];
  const metricsPromise = offset === 0
    ? Promise.all([
        Lead.countDocuments({ assignedAgent: employeeObjectId, status: { $in: activeStatuses } }),
        Lead.countDocuments({ assignedAgent: employeeObjectId, status: "Completed" }),
        LeadCallStat.aggregate<{ total: number }>([
          { $unwind: "$callLogs" },
          { $match: { "callLogs.employee": employeeObjectId } },
          { $count: "total" },
        ]),
      ])
    : null;
  const [rows, metricRows] = await Promise.all([activityQuery, metricsPromise]);
  let metrics = null;

  if (metricRows) {
    const [activeLeads, closedDeals, callAttemptRows] = metricRows;
    metrics = {
      activeLeads,
      closedDeals,
      callAttempts: Number(callAttemptRows[0]?.total || 0),
    };
  }

  response.json({
    items: rows.slice(0, limit),
    hasMore: rows.length > limit,
    nextOffset: rows.length > limit ? offset + limit : null,
    metrics,
  });
}
