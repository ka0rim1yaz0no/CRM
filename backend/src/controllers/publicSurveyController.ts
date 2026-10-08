import type { Request, Response } from "express";
import { runWithBusiness } from "../config/tenancy";
import { SurveyResponse } from "../models/SurveyResponse";
import {
  createSurveyRespondentKey,
  hempSurveyCampaignKey,
  hempSurveyName,
  parseHempSurveySubmission,
  SurveyValidationError,
} from "../services/hempSurveyService";
import { resolveHempSurveyBusinessId } from "../services/hempSurveyLeadQueue";

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
}

export async function submitHempIndustrySurvey(request: Request, response: Response) {
  if (String(request.body?.companyWebsite || "").trim()) {
    response.status(202).json({ ok: true, message: "Thank you. Your response has been received." });
    return;
  }

  let submission;

  try {
    submission = parseHempSurveySubmission(request.body);
  } catch (error) {
    if (error instanceof SurveyValidationError) {
      response.status(error.statusCode).json({ message: error.message, fields: error.fields });
      return;
    }
    throw error;
  }

  const businessId = await resolveHempSurveyBusinessId();

  await runWithBusiness(businessId, async () => {
    const respondentKey = createSurveyRespondentKey(submission);
    const existingResponse = await SurveyResponse.findOne({
      campaignKey: hempSurveyCampaignKey,
      $or: [
        { respondentKey },
        { firstName: submission.firstName, lastName: submission.lastName },
      ],
    }).collation({ locale: "en", strength: 2 }).select("_id");

    if (existingResponse) {
      response.status(200).json({
        ok: true,
        duplicate: true,
        message: "We already received a response for this first and last name.",
      });
      return;
    }

    try {
      await SurveyResponse.create({
        campaignKey: hempSurveyCampaignKey,
        surveyName: hempSurveyName,
        respondentKey,
        ...submission,
        lead: null,
        linkedToExistingLead: false,
        leadProcessingStatus: "pending",
        leadProcessingAttempts: 0,
        leadProcessingNextAttemptAt: new Date(),
        leadProcessingStartedAt: null,
        leadProcessingCompletedAt: null,
        leadProcessingLastError: "",
        submittedAt: new Date(),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        response.status(200).json({
          ok: true,
          duplicate: true,
          message: "We already received a response for this first and last name.",
        });
        return;
      }
      throw error;
    }

    response.status(202).json({
      ok: true,
      duplicate: false,
      queued: true,
      leadCreated: false,
      message: "Thank you. Your response has been received.",
    });
  });
}
