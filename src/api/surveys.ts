import { backendOrigin } from "../lib/backendUrl";

export type HempIndustrySurveyInput = {
  firstName: string;
  lastName: string;
  age: number;
  city: string;
  county: string;
  mobileNumber: string;
  email: string;
  joinsHempPetition: boolean;
  consentToUpdates: boolean;
  hempUse: string;
  storeName: string;
  companyWebsite: string;
};

export type SurveySubmissionResult = {
  ok: boolean;
  duplicate?: boolean;
  leadCreated?: boolean;
  message: string;
};

type SurveyErrorPayload = {
  message?: string;
  fields?: Record<string, string>;
};

export class SurveySubmissionError extends Error {
  fields: Record<string, string>;

  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = "SurveySubmissionError";
    this.fields = fields;
  }
}

export async function submitHempIndustrySurvey(input: HempIndustrySurveyInput) {
  const response = await fetch(`${backendOrigin}/api/public/surveys/help-save-the-hemp-industry`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json().catch(() => ({})) as SurveySubmissionResult & SurveyErrorPayload;

  if (!response.ok) {
    throw new SurveySubmissionError(result.message || "Unable to submit the survey. Please try again.", result.fields);
  }

  return result;
}
