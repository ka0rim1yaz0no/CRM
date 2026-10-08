import { getBusinessById, getDefaultBusiness, getPublicBusinesses, runWithBusiness } from "../config/tenancy";
import { Lead } from "../models/Lead";
import { SurveyResponse } from "../models/SurveyResponse";
import { emitLeadChanged } from "../socket";
import {
  createSurveyLeadNotes,
  hempSurveyCampaignKey,
  hempSurveyName,
  type HempSurveySubmission,
} from "./hempSurveyService";

const workerIntervalMs = positiveInteger(process.env.HEMP_SURVEY_QUEUE_INTERVAL_MS, 1_000, 250, 60_000);
const workerBatchSize = positiveInteger(process.env.HEMP_SURVEY_QUEUE_BATCH_SIZE, 5, 1, 25);
const workerMaxAttempts = positiveInteger(process.env.HEMP_SURVEY_QUEUE_MAX_ATTEMPTS, 8, 1, 20);
const processingLeaseMs = positiveInteger(process.env.HEMP_SURVEY_QUEUE_LEASE_MS, 5 * 60_000, 30_000, 60 * 60_000);

let cachedSurveyBusinessId = "";
let workerTimer: NodeJS.Timeout | null = null;
let workerRunning = false;

function positiveInteger(rawValue: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function retryDelayMs(attempt: number) {
  const exponent = Math.max(0, Math.min(6, attempt - 1));
  return Math.min(60 * 60_000, 60_000 * (2 ** exponent));
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return String(error || "Unknown survey lead processing error").slice(0, 1_000);
}

function submissionFromJob(job: {
  firstName?: string;
  lastName?: string;
  fullName: string;
  storeName: string;
  age: number;
  city: string;
  county: string;
  mobileNumber: string;
  email: string;
  hempBanStance?: string;
  joinsHempPetition?: boolean;
  consentToUpdates: boolean;
  hempUse?: string;
}): HempSurveySubmission {
  const legacyNameParts = String(job.fullName || "").trim().split(/\s+/);
  const firstName = String(job.firstName || legacyNameParts.shift() || "").trim();
  const lastName = String(job.lastName || legacyNameParts.join(" ") || "").trim();
  return {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" ") || job.fullName,
    storeName: job.storeName,
    age: job.age,
    city: job.city,
    county: job.county,
    mobileNumber: job.mobileNumber,
    email: job.email,
    joinsHempPetition: typeof job.joinsHempPetition === "boolean"
      ? job.joinsHempPetition
      : ["Disagree", "Strongly Disagree"].includes(String(job.hempBanStance || "")),
    consentToUpdates: job.consentToUpdates,
    hempUse: String(job.hempUse || "").trim(),
  };
}

export async function resolveHempSurveyBusinessId() {
  if (cachedSurveyBusinessId && getBusinessById(cachedSurveyBusinessId)) {
    return cachedSurveyBusinessId;
  }

  const configuredBusinessId = String(process.env.HEMP_SURVEY_BUSINESS_ID || "").trim();
  const businesses = await getPublicBusinesses();

  if (configuredBusinessId && businesses.some((business) => business.id === configuredBusinessId)) {
    cachedSurveyBusinessId = configuredBusinessId;
    return cachedSurveyBusinessId;
  }

  const requestedName = String(process.env.HEMP_SURVEY_BUSINESS_NAME || "Exclusive Hemp Farms").trim().toLowerCase();
  const namedBusiness = businesses.find((business) => business.name.trim().toLowerCase() === requestedName);
  cachedSurveyBusinessId = namedBusiness?.id || getDefaultBusiness().id;
  return cachedSurveyBusinessId;
}

async function claimNextJob() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - processingLeaseMs);

  return SurveyResponse.findOneAndUpdate(
    {
      campaignKey: hempSurveyCampaignKey,
      $or: [
        { leadProcessingStatus: "pending", leadProcessingNextAttemptAt: { $lte: now } },
        { leadProcessingStatus: "processing", leadProcessingStartedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: {
        leadProcessingStatus: "processing",
        leadProcessingStartedAt: now,
        leadProcessingLastError: "",
      },
      $inc: { leadProcessingAttempts: 1 },
    },
    { returnDocument: "after", sort: { submittedAt: 1 } }
  );
}

async function createOrUpdateLead(job: Awaited<ReturnType<typeof claimNextJob>>) {
  if (!job) return;

  const submission = submissionFromJob(job);
  const notes = createSurveyLeadNotes(submission);
  const activity = {
    label: "Survey submitted",
    detail: submission.consentToUpdates
      ? `${submission.fullName}${submission.storeName ? ` from ${submission.storeName}` : ""} submitted ${hempSurveyName}.`
      : `${submission.fullName}${submission.storeName ? ` from ${submission.storeName}` : ""} submitted ${hempSurveyName} without contact consent.`,
    status: "Done",
    actorName: "Survey",
    actorType: "system" as const,
    createdAt: new Date(),
  };

  const existingLead = await Lead.findOne({
    leadName: submission.fullName,
    status: { $ne: "Archived" },
  }).collation({ locale: "en", strength: 2 }).sort({ createdAt: -1 });

  if (existingLead) {
    const previousNotes = String(existingLead.notes || "").trim();
    const alreadyHasActivity = existingLead.activity.some((item) => item.label === activity.label && item.detail === activity.detail);

    existingLead.leadName = existingLead.leadName || submission.fullName;
    existingLead.businessName = existingLead.businessName || submission.storeName || "Survey Respondent";
    existingLead.email = existingLead.email || submission.email;
    existingLead.phone = existingLead.phone || submission.mobileNumber;
    existingLead.category = existingLead.category || hempSurveyName;
    existingLead.notes = previousNotes.includes(`Survey: ${hempSurveyName}`)
      ? previousNotes
      : [previousNotes, notes].filter(Boolean).join("\n\n");

    if (!alreadyHasActivity) existingLead.activity.push(activity);
    await existingLead.save();
    await SurveyResponse.updateOne(
      { _id: job._id },
      {
        $set: {
          lead: existingLead._id,
          linkedToExistingLead: true,
          leadProcessingStatus: "completed",
          leadProcessingCompletedAt: new Date(),
          leadProcessingNextAttemptAt: null,
          leadProcessingStartedAt: null,
          leadProcessingLastError: "",
        },
      }
    );
    emitLeadChanged({ action: "survey-submitted", lead: existingLead });
    return;
  }

  const lead = await Lead.create({
    leadName: submission.fullName,
    position: "Survey Respondent",
    businessName: submission.storeName || "Survey Respondent",
    businessAddress: `${submission.city}, ${submission.county}, Texas`,
    email: submission.email,
    phone: submission.mobileNumber,
    website: "",
    source: "Survey",
    category: hempSurveyName,
    createdByName: "Survey",
    createdByType: "system",
    status: "NEW",
    assignedAgent: null,
    assignedAgentName: "",
    autoAssignedAt: null,
    assignedTeam: null,
    googlePlaceId: "",
    placeProvider: "",
    providerPlaceId: "",
    notes,
    comments: [],
    activity: [activity],
    followUpAt: null,
    followUpNote: "",
    followUpPriority: 0,
    aiScore: 0,
    aiScoreReason: "",
    aiScoreSource: "",
    aiScoredAt: null,
  });

  await SurveyResponse.updateOne(
    { _id: job._id },
    {
      $set: {
        lead: lead._id,
        linkedToExistingLead: false,
        leadProcessingStatus: "completed",
        leadProcessingCompletedAt: new Date(),
        leadProcessingNextAttemptAt: null,
        leadProcessingStartedAt: null,
        leadProcessingLastError: "",
      },
    }
  );
  emitLeadChanged({ action: "created", lead });
}

async function markJobForRetry(job: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>, error: unknown) {
  const attempts = Number(job.leadProcessingAttempts || 1);
  const exhausted = attempts >= workerMaxAttempts;

  await SurveyResponse.updateOne(
    { _id: job._id },
    {
      $set: {
        leadProcessingStatus: exhausted ? "failed" : "pending",
        leadProcessingNextAttemptAt: exhausted ? null : new Date(Date.now() + retryDelayMs(attempts)),
        leadProcessingStartedAt: null,
        leadProcessingLastError: errorMessage(error),
      },
    }
  );

  console.error(`Survey lead queue job ${job._id} ${exhausted ? "failed" : "will retry"}:`, errorMessage(error));
}

async function processNextJob() {
  const job = await claimNextJob();
  if (!job) return false;

  try {
    await createOrUpdateLead(job);
  } catch (error) {
    await markJobForRetry(job, error);
  }

  return true;
}

async function runWorkerBatch() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    const businessId = await resolveHempSurveyBusinessId();
    await runWithBusiness(businessId, async () => {
      for (let index = 0; index < workerBatchSize; index += 1) {
        const processed = await processNextJob();
        if (!processed) break;
      }
    });
  } catch (error) {
    console.error("Survey lead queue worker error:", errorMessage(error));
  } finally {
    workerRunning = false;
  }
}

export function startHempSurveyLeadQueueWorker() {
  if (workerTimer || String(process.env.HEMP_SURVEY_QUEUE_ENABLED || "true").toLowerCase() === "false") {
    return;
  }

  void runWorkerBatch();
  workerTimer = setInterval(() => void runWorkerBatch(), workerIntervalMs);
  workerTimer.unref();
  console.log(`Survey lead queue worker started: batch=${workerBatchSize}, intervalMs=${workerIntervalMs}, maxAttempts=${workerMaxAttempts}`);
}
