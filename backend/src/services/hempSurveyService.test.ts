import assert from "node:assert/strict";
import test from "node:test";
import {
  createSurveyLeadNotes,
  createSurveyRespondentKey,
  parseHempSurveySubmission,
  SurveyValidationError,
} from "./hempSurveyService";

const validInput = {
  firstName: "Taylor",
  lastName: "Morgan",
  age: 34,
  city: "Austin",
  county: "Travis",
  mobileNumber: "(512) 555-0184",
  email: "Taylor@Example.com",
  joinsHempPetition: true,
  consentToUpdates: true,
  hempUse: "Wellness products",
  storeName: "Hill Country Hemp",
};

test("parses and normalizes a valid hemp survey response", () => {
  const result = parseHempSurveySubmission(validInput);

  assert.equal(result.email, "taylor@example.com");
  assert.equal(result.mobileNumber, "+15125550184");
  assert.equal(result.fullName, "Taylor Morgan");
  assert.equal(result.storeName, "Hill Country Hemp");
  assert.equal(result.joinsHempPetition, true);
  assert.equal(result.consentToUpdates, true);
});

test("requires both a valid mobile number and email address", () => {
  assert.throws(
    () => parseHempSurveySubmission({ ...validInput, mobileNumber: "", email: "" }),
    (error) => error instanceof SurveyValidationError
      && Boolean(error.fields.mobileNumber)
      && Boolean(error.fields.email)
  );
});

test("allows hemp use and store name to be omitted", () => {
  const result = parseHempSurveySubmission({ ...validInput, hempUse: "", storeName: "" });
  assert.equal(result.hempUse, "");
  assert.equal(result.storeName, "");
});

test("requires first name, last name, age, petition choice, and update choice", () => {
  assert.throws(
    () => parseHempSurveySubmission({
      ...validInput,
      firstName: "",
      lastName: "",
      age: 17,
      joinsHempPetition: "yes",
      consentToUpdates: "yes",
    }),
    (error) => error instanceof SurveyValidationError
      && Boolean(error.fields.firstName)
      && Boolean(error.fields.lastName)
      && Boolean(error.fields.age)
      && Boolean(error.fields.joinsHempPetition)
      && Boolean(error.fields.consentToUpdates)
  );
});

test("creates a stable private respondent key from first and last name", () => {
  const first = parseHempSurveySubmission(validInput);
  const second = parseHempSurveySubmission({
    ...validInput,
    firstName: "  TAYLOR  ",
    lastName: "MORGAN",
    email: "another@example.com",
    mobileNumber: "(214) 555-0112",
  });

  assert.equal(createSurveyRespondentKey(first), createSurveyRespondentKey(second));
  assert.equal(createSurveyRespondentKey(first).length, 64);
});

test("allows shared email and mobile number when the respondent name differs", () => {
  const first = parseHempSurveySubmission(validInput);
  const second = parseHempSurveySubmission({
    ...validInput,
    firstName: "Jordan",
    lastName: "Lee",
  });

  assert.notEqual(createSurveyRespondentKey(first), createSurveyRespondentKey(second));
});

test("lead notes include every survey answer and contact permission", () => {
  const notes = createSurveyLeadNotes(parseHempSurveySubmission(validInput));

  assert.match(notes, /Age: 34/);
  assert.match(notes, /Name of Store Registered: Hill Country Hemp/);
  assert.match(notes, /City: Austin/);
  assert.match(notes, /County: Travis/);
  assert.match(notes, /Joined hemp petition: Yes/);
  assert.match(notes, /Hemp Use: Wellness products/);
  assert.match(notes, /Contact permission: Granted/);
});
