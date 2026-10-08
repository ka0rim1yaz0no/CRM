import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";

export const hempSurveyStances = [
  "Strongly Agree",
  "Agree",
  "Neutral / Unsure",
  "Disagree",
  "Strongly Disagree",
] as const;

export type HempSurveyStance = (typeof hempSurveyStances)[number];

export type SurveyResponseDocument = {
  campaignKey: string;
  surveyName: string;
  respondentKey: string;
  firstName: string;
  lastName: string;
  fullName: string;
  storeName: string;
  age: number;
  city: string;
  county: string;
  mobileNumber: string;
  email: string;
  hempBanStance?: HempSurveyStance;
  joinsHempPetition: boolean;
  consentToUpdates: boolean;
  hempUse: string;
  lead: Types.ObjectId | null;
  linkedToExistingLead: boolean;
  leadProcessingStatus: "pending" | "processing" | "completed" | "failed";
  leadProcessingAttempts: number;
  leadProcessingNextAttemptAt: Date | null;
  leadProcessingStartedAt: Date | null;
  leadProcessingCompletedAt: Date | null;
  leadProcessingLastError: string;
  submittedAt: Date;
};

const surveyResponseSchema = new Schema<SurveyResponseDocument>(
  {
    campaignKey: { type: String, required: true, trim: true, index: true },
    surveyName: { type: String, required: true, trim: true },
    respondentKey: { type: String, required: true, trim: true },
    firstName: { type: String, trim: true, default: "" },
    lastName: { type: String, trim: true, default: "" },
    fullName: { type: String, required: true, trim: true },
    storeName: { type: String, trim: true, default: "" },
    age: { type: Number, required: true, min: 18, max: 120 },
    city: { type: String, required: true, trim: true },
    county: { type: String, required: true, trim: true },
    mobileNumber: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    hempBanStance: { type: String, enum: hempSurveyStances },
    joinsHempPetition: { type: Boolean, default: false },
    consentToUpdates: { type: Boolean, required: true },
    hempUse: { type: String, trim: true, default: "" },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", default: null, index: true },
    linkedToExistingLead: { type: Boolean, default: false },
    leadProcessingStatus: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      index: true,
    },
    leadProcessingAttempts: { type: Number, min: 0, default: 0 },
    leadProcessingNextAttemptAt: { type: Date, default: Date.now },
    leadProcessingStartedAt: { type: Date, default: null },
    leadProcessingCompletedAt: { type: Date, default: null },
    leadProcessingLastError: { type: String, trim: true, default: "" },
    submittedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

surveyResponseSchema.index({ campaignKey: 1, respondentKey: 1 }, { unique: true });
surveyResponseSchema.index({ campaignKey: 1, submittedAt: -1 });
surveyResponseSchema.index({ campaignKey: 1, leadProcessingStatus: 1, leadProcessingNextAttemptAt: 1, submittedAt: 1 });

export const SurveyResponse = tenantModel<SurveyResponseDocument>("SurveyResponse", surveyResponseSchema);
