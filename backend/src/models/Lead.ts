// import { Schema, model, Types } from "mongoose";

// type LeadCallByEmployee = {
//   employee: Types.ObjectId;
//   employeeName: string;
//   employeeRole: string;
//   employeeTeam: string;
//   count: number;
//   lastCallAt: Date | null;
// };

// type LeadCallLog = {
//   employee: Types.ObjectId;
//   employeeName: string;
//   employeeRole: string;
//   employeeTeam: string;
//   calledAt: Date;
// };

// export type LeadStatus =
//   | "NEW"
//   | "Follow up"
//   | "Ongoing comms"
//   | "Qualified"
//   | "Ongoing Negotiation"
//   | "Completed"
//   | "Dead"
//   | "Archived";

// export type LeadDocument = {
//   leadName: string;
//   position: string;
//   businessName: string;
//   businessAddress: string;
//   email: string;
//   phone: string;
//   website: string;
//   source: string;
//   category: string;
//   status: LeadStatus;
//   createdByName: string;
//   createdByType: "admin" | "employee" | "system";
//   assignedAgent: Types.ObjectId | null;
//   assignedAgentName: string;
//   autoAssignedAt: Date | null;
//   assignedTeam: Types.ObjectId | null;
//   favoriteByEmployees: Types.ObjectId[];
//   googlePlaceId: string;
//   notes: string;

//   callCount: number;
//   lastCallAt: Date | null;
//   callsByEmployee: LeadCallByEmployee[];
//   callLogs: LeadCallLog[];

//   comments: {
//     authorName: string;
//     authorType: "admin" | "employee";
//     body: string;
//     createdAt: Date;
//   }[];
//   activity: {
//     label: string;
//     detail: string;
//     status: string;
//     actorName: string;
//     actorType: "admin" | "employee" | "system";
//     createdAt: Date;
//   }[];
//   followUpAt: Date | null;
//   followUpNote: string;
//   followUpPriority: number;
//   aiScore: number;
//   aiScoreReason: string;
//   aiScoreSource: string;
//   aiScoredAt: Date | null;
// };

// const leadSchema = new Schema<LeadDocument>(
//   {
//     leadName: { type: String, trim: true, default: "" },
//     position: { type: String, trim: true, default: "" },
//     businessName: { type: String, required: true, trim: true },
//     businessAddress: { type: String, trim: true, default: "" },
//     email: { type: String, trim: true, lowercase: true, default: "" },
//     phone: { type: String, trim: true, default: "" },
//     website: { type: String, trim: true, default: "" },
//     source: { type: String, trim: true, default: "Manual" },
//     category: { type: String, trim: true, default: "" },
//     createdByName: { type: String, trim: true, default: "System" },
//     createdByType: { type: String, enum: ["admin", "employee", "system"], default: "system" },
//     status: {
//       type: String,
//       enum: ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation", "Completed", "Dead", "Archived"],
//       default: "NEW",
//     },
//     assignedAgent: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
//     assignedAgentName: { type: String, trim: true, default: "" },
//     autoAssignedAt: { type: Date, default: null },
//     assignedTeam: { type: Schema.Types.ObjectId, ref: "Team", default: null },
//     favoriteByEmployees: { type: [{ type: Schema.Types.ObjectId, ref: "Employee" }], default: [] },
//     googlePlaceId: { type: String, trim: true, default: "" },
//     notes: { type: String, trim: true, default: "" },
//     comments: {
//       type: [
//         {
//           authorName: { type: String, trim: true, default: "Employee" },
//           authorType: { type: String, enum: ["admin", "employee"], default: "employee" },
//           body: { type: String, required: true, trim: true },
//           createdAt: { type: Date, default: Date.now },
//         },
//       ],
//       default: [],
//     },
//     activity: {
//       type: [
//         {
//           label: { type: String, trim: true, required: true },
//           detail: { type: String, trim: true, required: true },
//           status: { type: String, trim: true, default: "Done" },
//           actorName: { type: String, trim: true, default: "System" },
//           actorType: { type: String, enum: ["admin", "employee", "system"], default: "system" },
//           createdAt: { type: Date, default: Date.now },
//         },
//       ],
//       default: [],
//     },
//     followUpAt: { type: Date, default: null },
//     followUpNote: { type: String, trim: true, default: "" },
//     followUpPriority: { type: Number, min: 0, max: 100, default: 0 },
//     aiScore: { type: Number, min: 0, max: 100, default: 0 },
//     aiScoreReason: { type: String, trim: true, default: "" },
//     aiScoreSource: { type: String, trim: true, default: "" },
//     aiScoredAt: { type: Date, default: null },
//   },
//   { timestamps: true }
// );

// const leadCallsByEmployeeSchema = new Schema(
//   {
//     employee: {
//       type: Schema.Types.ObjectId,
//       ref: "Employee",
//       required: true,
//     },
//     employeeName: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     employeeRole: {
//       type: String,
//       trim: true,
//       default: "",
//     },
//     employeeTeam: {
//       type: String,
//       trim: true,
//       default: "",
//     },
//     count: {
//       type: Number,
//       min: 0,
//       default: 0,
//     },
//     lastCallAt: {
//       type: Date,
//       default: null,
//     },
//   },
//   {
//     _id: false,
//   }
// );

// const leadCallLogSchema = new Schema(
//   {
//     employee: {
//       type: Schema.Types.ObjectId,
//       ref: "Employee",
//       required: true,
//     },
//     employeeName: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     employeeRole: {
//       type: String,
//       trim: true,
//       default: "",
//     },
//     employeeTeam: {
//       type: String,
//       trim: true,
//       default: "",
//     },
//     calledAt: {
//       type: Date,
//       default: Date.now,
//     },
//   },
//   {
//     _id: true,
//   }
// );

// export const Lead = tenantModel<LeadDocument>("Lead", leadSchema);

import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type LeadCallByEmployee = {
  employee: Types.ObjectId;
  employeeName: string;
  employeeRole: string;
  employeeTeam: string;
  count: number;
  lastCallAt: Date | null;
};

export type LeadCallLog = {
  _id?: Types.ObjectId;
  employee: Types.ObjectId;
  employeeName: string;
  employeeRole: string;
  employeeTeam: string;
  calledAt: Date;
};

export type LeadStatus =
  | "NEW"
  | "Follow up"
  | "Ongoing comms"
  | "Qualified"
  | "Ongoing Negotiation"
  | "Completed"
  | "Dead"
  | "Archived";

export type LeadDocument = {
  leadName: string;
  position: string;
  businessName: string;
  businessAddress: string;
  email: string;
  phone: string;
  website: string;
  source: string;
  category: string;
  status: LeadStatus;
  createdByName: string;
  createdByType: "admin" | "employee" | "system";
  assignedAgent: Types.ObjectId | null;
  assignedAgentName: string;
  autoAssignedAt: Date | null;
  assignedTeam: Types.ObjectId | null;
  favoriteByEmployees: Types.ObjectId[];
  googlePlaceId: string;
  placeProvider: "" | "google" | "tomtom";
  providerPlaceId: string;
  notes: string;

  callCount: number;
  lastCallAt: Date | null;
  callsByEmployee: LeadCallByEmployee[];
  callLogs: LeadCallLog[];

  comments: {
    authorName: string;
    authorType: "admin" | "employee";
    body: string;
    createdAt: Date;
  }[];

  activity: {
    label: string;
    detail: string;
    status: string;
    actorName: string;
    actorType: "admin" | "employee" | "system";
    createdAt: Date;
  }[];

  followUpAt: Date | null;
  followUpNote: string;
  followUpPriority: number;
  aiScore: number;
  aiScoreReason: string;
  aiScoreSource: string;
  aiScoredAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
};

const leadCallsByEmployeeSchema = new Schema<LeadCallByEmployee>(
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
    count: {
      type: Number,
      min: 0,
      default: 0,
    },
    lastCallAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

const leadCallLogSchema = new Schema<LeadCallLog>(
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
    calledAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: true,
  }
);

const leadSchema = new Schema<LeadDocument>(
  {
    leadName: {
      type: String,
      trim: true,
      default: "",
    },

    position: {
      type: String,
      trim: true,
      default: "",
    },

    businessName: {
      type: String,
      required: true,
      trim: true,
    },

    businessAddress: {
      type: String,
      trim: true,
      default: "",
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },

    phone: {
      type: String,
      trim: true,
      default: "",
    },

    website: {
      type: String,
      trim: true,
      default: "",
    },

    source: {
      type: String,
      trim: true,
      default: "Manual",
    },

    category: {
      type: String,
      trim: true,
      default: "",
    },

    createdByName: {
      type: String,
      trim: true,
      default: "System",
    },

    createdByType: {
      type: String,
      enum: ["admin", "employee", "system"],
      default: "system",
    },

    status: {
      type: String,
      enum: [
        "NEW",
        "Follow up",
        "Ongoing comms",
        "Qualified",
        "Ongoing Negotiation",
        "Completed",
        "Dead",
        "Archived",
      ],
      default: "NEW",
    },

    assignedAgent: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },

    assignedAgentName: {
      type: String,
      trim: true,
      default: "",
    },

    autoAssignedAt: {
      type: Date,
      default: null,
    },

    assignedTeam: {
      type: Schema.Types.ObjectId,
      ref: "Team",
      default: null,
    },

    favoriteByEmployees: {
      type: [{ type: Schema.Types.ObjectId, ref: "Employee" }],
      default: [],
    },

    googlePlaceId: {
      type: String,
      trim: true,
      default: "",
    },

    placeProvider: {
      type: String,
      enum: ["", "google", "tomtom"],
      default: "",
      index: true,
    },

    providerPlaceId: {
      type: String,
      trim: true,
      default: "",
    },

    notes: {
      type: String,
      trim: true,
      default: "",
    },

    callCount: {
      type: Number,
      min: 0,
      default: 0,
    },

    lastCallAt: {
      type: Date,
      default: null,
    },

    callsByEmployee: {
      type: [leadCallsByEmployeeSchema],
      default: [],
    },

    callLogs: {
      type: [leadCallLogSchema],
      default: [],
    },

    comments: {
      type: [
        {
          authorName: {
            type: String,
            trim: true,
            default: "Employee",
          },
          authorType: {
            type: String,
            enum: ["admin", "employee"],
            default: "employee",
          },
          body: {
            type: String,
            required: true,
            trim: true,
          },
          createdAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },

    activity: {
      type: [
        {
          label: {
            type: String,
            trim: true,
            required: true,
          },
          detail: {
            type: String,
            trim: true,
            required: true,
          },
          status: {
            type: String,
            trim: true,
            default: "Done",
          },
          actorName: {
            type: String,
            trim: true,
            default: "System",
          },
          actorType: {
            type: String,
            enum: ["admin", "employee", "system"],
            default: "system",
          },
          createdAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },

    followUpAt: {
      type: Date,
      default: null,
    },

    followUpNote: {
      type: String,
      trim: true,
      default: "",
    },

    followUpPriority: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },

    aiScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },

    aiScoreReason: {
      type: String,
      trim: true,
      default: "",
    },

    aiScoreSource: {
      type: String,
      trim: true,
      default: "",
    },

    aiScoredAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

leadSchema.index({ status: 1 });
leadSchema.index({ assignedAgent: 1 });
leadSchema.index({ assignedTeam: 1 });
leadSchema.index({ "callsByEmployee.employee": 1 });
leadSchema.index({ callCount: -1 });
leadSchema.index({ lastCallAt: -1 });

export const Lead = tenantModel<LeadDocument>("Lead", leadSchema);
