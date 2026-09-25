import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type LeadCallOutcome = "connected" | "not_connected" | "voicemail";

export type LeadCallLogItem = {
    employee: Types.ObjectId;
    employeeName: string;
    employeeRole: string;
    employeeTeam: string;
    outcome: LeadCallOutcome;
    calledAt: Date;
};

export type LeadCallStatDocument = {
    lead: Types.ObjectId;
    leadName: string;
    businessName: string;

    callCount: number;
    callNotConnectedCount: number;
    callVoicemailCount: number;

    lastCallAt: Date | null;
    lastNotConnectedAt: Date | null;
    lastVoicemailAt: Date | null;

    callLogs: LeadCallLogItem[];

    createdAt?: Date;
    updatedAt?: Date;
};

const leadCallLogItemSchema = new Schema<LeadCallLogItem>(
    {
        employee: {
            type: Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
        },
        employeeName: {
            type: String,
            required: true,
            trim: true,
        },
        employeeRole: {
            type: String,
            trim: true,
            default: "",
        },
        employeeTeam: {
            type: String,
            trim: true,
            default: "",
        },
        outcome: {
            type: String,
            enum: ["connected", "not_connected", "voicemail"],
            default: "connected",
        },
        calledAt: {
            type: Date,
            default: Date.now,
        },
    },
    {
        _id: true,
    }
);

const leadCallStatSchema = new Schema<LeadCallStatDocument>(
    {
        lead: {
            type: Schema.Types.ObjectId,
            ref: "Lead",
            required: true,
            unique: true,
            index: true,
        },

        leadName: {
            type: String,
            trim: true,
            default: "",
        },

        businessName: {
            type: String,
            trim: true,
            default: "",
        },

        callCount: {
            type: Number,
            min: 0,
            default: 0,
        },

        callNotConnectedCount: {
            type: Number,
            min: 0,
            default: 0,
        },

        callVoicemailCount: {
            type: Number,
            min: 0,
            default: 0,
        },

        lastCallAt: {
            type: Date,
            default: null,
        },

        lastNotConnectedAt: {
            type: Date,
            default: null,
        },

        lastVoicemailAt: {
            type: Date,
            default: null,
        },

        callLogs: {
            type: [leadCallLogItemSchema],
            default: [],
        },
    },
    {
        timestamps: true,
    }
);

leadCallStatSchema.index({ callCount: -1 });
leadCallStatSchema.index({ callNotConnectedCount: -1 });
leadCallStatSchema.index({ callVoicemailCount: -1 });
leadCallStatSchema.index({ lastCallAt: -1 });
leadCallStatSchema.index({ lastNotConnectedAt: -1 });
leadCallStatSchema.index({ lastVoicemailAt: -1 });
leadCallStatSchema.index({ "callLogs.employee": 1 });
leadCallStatSchema.index({ "callLogs.outcome": 1 });

export const LeadCallStat = tenantModel<LeadCallStatDocument>(
    "LeadCallStat",
    leadCallStatSchema
);
