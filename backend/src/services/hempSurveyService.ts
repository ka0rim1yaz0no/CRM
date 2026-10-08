import { createHash } from "node:crypto";
export const hempSurveyCampaignKey = "help-save-the-hemp-industry";
export const hempSurveyName = "Help Save the Hemp Industry";

export type HempSurveySubmission = {
  firstName: string;
  lastName: string;
  fullName: string;
  storeName: string;
  age: number;
  city: string;
  county: string;
  mobileNumber: string;
  email: string;
  joinsHempPetition: boolean;
  consentToUpdates: boolean;
  hempUse: string;
};

export class SurveyValidationError extends Error {
  statusCode = 422;
  fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super("Please check the highlighted survey fields.");
    this.name = "SurveyValidationError";
    this.fields = fields;
  }
}

function cleanString(value: unknown, maxLength: number) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeSurveyEmail(value: unknown) {
  return cleanString(value, 254).toLowerCase();
}

export function normalizeSurveyPhone(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return digits ? `+${digits.slice(0, 15)}` : "";
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email);
}

function isValidPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

export function parseHempSurveySubmission(input: unknown): HempSurveySubmission {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const firstName = cleanString(body.firstName, 60);
  const lastName = cleanString(body.lastName, 60);
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const storeName = cleanString(body.storeName, 160);
  const city = cleanString(body.city, 100);
  const county = cleanString(body.county, 100);
  const mobileNumber = normalizeSurveyPhone(body.mobileNumber);
  const email = normalizeSurveyEmail(body.email);
  const rawAge = Number(body.age);
  const joinsHempPetition = body.joinsHempPetition;
  const consentToUpdates = body.consentToUpdates;
  const hempUse = cleanString(body.hempUse, 500);
  const fields: Record<string, string> = {};

  if (firstName.length < 1) fields.firstName = "Enter your first name.";
  if (lastName.length < 1) fields.lastName = "Enter your last name.";
  if (!Number.isInteger(rawAge) || rawAge < 18 || rawAge > 120) fields.age = "Enter an age from 18 to 120.";
  if (city.length < 2) fields.city = "Enter your city of residence.";
  if (county.length < 2) fields.county = "Enter your county.";
  if (!mobileNumber || !isValidPhone(mobileNumber)) fields.mobileNumber = "Enter a valid mobile number.";
  if (!email || !isValidEmail(email)) fields.email = "Enter a valid email address.";
  if (typeof joinsHempPetition !== "boolean") fields.joinsHempPetition = "Select Yes or No.";
  if (typeof consentToUpdates !== "boolean") fields.consentToUpdates = "Select Yes or No.";

  if (Object.keys(fields).length > 0) {
    throw new SurveyValidationError(fields);
  }

  return {
    firstName,
    lastName,
    fullName,
    storeName,
    age: rawAge,
    city,
    county,
    mobileNumber,
    email,
    joinsHempPetition: joinsHempPetition as boolean,
    consentToUpdates: consentToUpdates as boolean,
    hempUse,
  };
}

export function createSurveyRespondentKey(submission: HempSurveySubmission) {
  const firstNameKey = cleanString(submission.firstName, 60).toLowerCase();
  const lastNameKey = cleanString(submission.lastName, 60).toLowerCase();
  return createHash("sha256").update(`${hempSurveyCampaignKey}:${firstNameKey}:${lastNameKey}`).digest("hex");
}

export function createSurveyLeadNotes(submission: HempSurveySubmission) {
  return [
    `Survey: ${hempSurveyName}`,
    `First Name: ${submission.firstName}`,
    `Last Name: ${submission.lastName}`,
    `Age: ${submission.age}`,
    `City: ${submission.city}`,
    `County: ${submission.county}`,
    `Mobile Number: ${submission.mobileNumber}`,
    `Email Address: ${submission.email}`,
    `Joined hemp petition: ${submission.joinsHempPetition ? "Yes" : "No"}`,
    `Opted in to election and hemp regulation updates: ${submission.consentToUpdates ? "Yes" : "No"}`,
    `Hemp Use: ${submission.hempUse || "Not provided"}`,
    `Name of Store Registered: ${submission.storeName || "Not provided"}`,
    submission.consentToUpdates ? "Contact permission: Granted" : "Contact permission: Not granted - do not contact for updates",
  ].join("\n");
}
