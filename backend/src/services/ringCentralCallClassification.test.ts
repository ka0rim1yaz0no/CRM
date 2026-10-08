import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRingCentralCall,
  classifyRingCentralRecording,
} from "./ringCentralCallClassification";

test("classifies explicit RingCentral voicemail states with high confidence", () => {
  assert.deepEqual(
    classifyRingCentralCall({ statusCodes: ["Setup", "VoiceMail", "Disconnected"] }),
    {
      outcome: "voicemail",
      confidence: "high",
      reason: "RingCentral reported a voicemail state.",
    }
  );
});

test("classifies explicit no-answer results with high confidence", () => {
  const result = classifyRingCentralCall({
    statusCodes: ["Setup", "Disconnected"],
    providerResult: "No Answer",
  });

  assert.equal(result.outcome, "not_connected");
  assert.equal(result.confidence, "high");
});

test("does not claim an answered call was a human connection", () => {
  const result = classifyRingCentralCall({
    statusCodes: ["Setup", "Answered", "Disconnected"],
    answeredAt: new Date(),
  });

  assert.equal(result.outcome, "unclassified");
  assert.equal(result.confidence, "needs_review");
});

test("marks a terminal call without an answer as probably not connected", () => {
  const result = classifyRingCentralCall({ statusCodes: ["Setup", "Disconnected"] });

  assert.equal(result.outcome, "not_connected");
  assert.equal(result.confidence, "probable");
});

test("classifies a clear voicemail recording", () => {
  const result = classifyRingCentralRecording({
    transcript: "The person you called is unavailable. Please leave a message after the tone.",
    durationSeconds: 24,
  });

  assert.equal(result.outcome, "voicemail");
  assert.equal(result.confidence, "high");
});

test("classifies an automated IVR or hold recording as voicemail", () => {
  const result = classifyRingCentralRecording({
    transcript: "Please stay on the line. Your call will be handled by the next available clerk.",
    durationSeconds: 63,
  });

  assert.equal(result.outcome, "voicemail");
  assert.equal(result.confidence, "high");
});

test("classifies a live greeting as a probable human connection", () => {
  const result = classifyRingCentralRecording({
    transcript: "This call is being recorded. Hello, thank you for calling the store. Hello?",
    durationSeconds: 20,
  });

  assert.equal(result.outcome, "connected");
  assert.equal(result.confidence, "probable");
});

test("classifies an announcement-only recording as not connected", () => {
  const result = classifyRingCentralRecording({
    transcript: "This call is being recorded.",
    durationSeconds: 7,
  });

  assert.equal(result.outcome, "not_connected");
  assert.equal(result.confidence, "probable");
});

test("classifies intelligible non-automated speech as connected", () => {
  const result = classifyRingCentralRecording({
    transcript: "Sure, one moment while I get the manager for you.",
    durationSeconds: 18,
  });

  assert.equal(result.outcome, "connected");
  assert.equal(result.confidence, "probable");
});
