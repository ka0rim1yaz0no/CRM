import assert from "node:assert/strict";
import test from "node:test";
import { isLeadEligibleForAutoCall } from "./leadAutoCallEligibility";

const now = new Date("2026-10-01T02:00:00.000Z");

test("new leads without employee comments are callable", () => {
  assert.equal(isLeadEligibleForAutoCall({ status: "NEW", comments: [] }, now), true);
});

test("a current employee comment blocks a lead for a full 24 hours", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [{ authorType: "employee", createdAt: "2026-09-30T02:00:01.000Z" }],
      followUpAt: null,
    }, now),
    false
  );
});

test("a commented lead returns to circulation after 24 hours", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [{ authorType: "employee", createdAt: "2026-09-30T02:00:00.000Z" }],
      followUpAt: null,
    }, now),
    true
  );
});

test("a confirmed call remains callable until the employee adds a comment", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "NEW",
      comments: [],
      callsByEmployee: [{ employeeName: "Dylan Karl Masliyan", lastCallAt: "2026-10-01T01:59:00.000Z" }],
    }, now, ["Dylan Karl Masliyan", "26001015"]),
    true
  );
});

test("an employee comment advances the queue even after a confirmed call", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "NEW",
      comments: [{
        authorType: "employee",
        authorName: "Dylan Karl Masliyan",
        createdAt: "2026-10-01T01:59:30.000Z",
      }],
      callsByEmployee: [{ employeeName: "Dylan Karl Masliyan", lastCallAt: "2026-10-01T01:59:00.000Z" }],
    }, now, ["Dylan Karl Masliyan", "26001015"]),
    false
  );
});

test("another employee's recent call does not block the current employee", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "NEW",
      comments: [],
      callsByEmployee: [{ employeeName: "Previous Agent", lastCallAt: "2026-10-01T01:59:00.000Z" }],
    }, now, ["Current Agent", "26001015"]),
    true
  );
});

test("call age does not change eligibility when the lead has no employee comment", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "NEW",
      comments: [],
      callsByEmployee: [{ employeeName: "Employee", lastCallAt: "2026-09-30T02:00:00.000Z" }],
    }, now, ["Employee"]),
    true
  );
});

test("a previous assignee comment does not block the current employee", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [{ authorType: "employee", authorName: "Previous Agent", createdAt: "2026-10-01T01:59:00.000Z" }],
      followUpAt: null,
    }, now, ["Current Agent", "26001015"]),
    true
  );
});

test("a current employee comment blocks the lead using a case-insensitive name match", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [{ authorType: "employee", authorName: "DYLAN KARL MASLIYAN", createdAt: "2026-10-01T01:59:00.000Z" }],
      followUpAt: null,
    }, now, ["Dylan Karl Masliyan", "26001015"]),
    false
  );
});

test("a commented lead becomes callable when its scheduled follow-up is due", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [{ authorType: "employee", authorName: "Employee", createdAt: "2026-10-01T01:00:00.000Z" }],
      followUpAt: "2026-10-01T01:59:00.000Z",
    }, now, ["Employee"]),
    true
  );
});

test("a called lead becomes callable when a later scheduled follow-up is due", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [],
      callsByEmployee: [{ employeeName: "Employee", lastCallAt: "2026-10-01T01:00:00.000Z" }],
      followUpAt: "2026-10-01T01:59:00.000Z",
    }, now, ["Employee"]),
    true
  );
});

test("a future follow-up does not become callable early", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [{ authorType: "employee", createdAt: "2026-10-01T01:00:00.000Z" }],
      followUpAt: "2026-10-01T02:01:00.000Z",
    }, now),
    false
  );
});

test("a future scheduled lead without comments waits for its exact time", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [],
      followUpAt: "2026-10-01T02:01:00.000Z",
    }, now),
    false
  );

  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [],
      followUpAt: "2026-10-01T02:00:00.000Z",
    }, now),
    true
  );
});

test("a due follow-up is blocked after the employee comments at the scheduled time", () => {
  assert.equal(
    isLeadEligibleForAutoCall({
      status: "Follow up",
      comments: [{ authorType: "employee", createdAt: "2026-10-01T01:59:00.000Z" }],
      followUpAt: "2026-10-01T01:59:00.000Z",
    }, now),
    false
  );
});

test("completed or archived leads are never callable", () => {
  assert.equal(isLeadEligibleForAutoCall({ status: "Completed", comments: [] }, now), false);
  assert.equal(isLeadEligibleForAutoCall({ status: "Archived", comments: [] }, now), false);
});
