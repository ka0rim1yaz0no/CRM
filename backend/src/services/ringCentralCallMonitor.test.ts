import assert from "node:assert/strict";
import test from "node:test";
import {
  findRingCentralExtension,
  isRingCentralActiveStatus,
  isRingCentralSubscriptionAck,
  isRingCentralTerminalStatus,
  parseRingCentralExtensionMap,
  resolveRingCentralSessionActions,
} from "./ringCentralCallMonitor";

const mappedEmployee = {
  employeeCode: "26001016",
  employeeName: "Arah Jhean B. Bautista",
  email: "arah.assistly@gmail.com",
  personalEmail: "",
  phone: "",
  businessIds: new Set(["business-c"]),
};

test("parses JSON and delimited RingCentral employee mappings", () => {
  assert.deepEqual(
    [...parseRingCentralExtensionMap('{"26001012":"101","26001016":"222222"}')],
    [["26001012", "101"], ["26001016", "222222"]]
  );
  assert.deepEqual(
    [...parseRingCentralExtensionMap("26001012=101,26001016=102")],
    [["26001012", "101"], ["26001016", "102"]]
  );
});

test("falls back to a unique employee match when an explicit extension was recreated", () => {
  const extension = findRingCentralExtension(
    mappedEmployee,
    [{
      id: "744673026",
      extensionNumber: "113",
      contact: {
        email: "arah.assistly@gmail.com",
        firstName: "Arah Jhean",
        lastName: "Bautista",
      },
    }],
    "105"
  );

  assert.equal(extension?.extensionNumber, "113");
});

test("keeps a valid explicit extension mapping authoritative", () => {
  const extension = findRingCentralExtension(
    mappedEmployee,
    [
      { id: "old-id", extensionNumber: "105", contact: { email: "other@example.com" } },
      { id: "new-id", extensionNumber: "113", contact: { email: "arah.assistly@gmail.com" } },
    ],
    "105"
  );

  assert.equal(extension?.id, "old-id");
});

test("recognizes RingCentral ringing, connected and terminal states", () => {
  assert.equal(isRingCentralActiveStatus("Setup"), true);
  assert.equal(isRingCentralActiveStatus("Proceeding"), true);
  assert.equal(isRingCentralActiveStatus("Answered"), true);
  assert.equal(isRingCentralActiveStatus("VoiceMail"), true);
  assert.equal(isRingCentralActiveStatus("VoiceMailScreening"), true);
  assert.equal(isRingCentralTerminalStatus("Disconnected"), true);
  assert.equal(isRingCentralTerminalStatus("Gone"), true);
  assert.equal(isRingCentralTerminalStatus("Answered"), false);
});

test("accepts both documented and live RingCentral subscription acknowledgements", () => {
  const messageId = "subscription-request";
  assert.equal(isRingCentralSubscriptionAck({ type: "ClientResponse", messageId, status: 200 }, messageId), true);
  assert.equal(isRingCentralSubscriptionAck({ type: "ClientRequest", messageId, status: 200 }, messageId), true);
  assert.equal(isRingCentralSubscriptionAck({ type: "ClientRequest", messageId: "other", status: 200 }, messageId), false);
});

test("ends a tracked call when RingCentral sends a partial terminal event without an extension id", () => {
  assert.deepEqual(
    resolveRingCentralSessionActions(
      [{ status: { code: "Disconnected" } }],
      new Set(["101", "102"]),
      new Set(["101"])
    ),
    [{ extensionId: "101", action: "remove" }]
  );
});

test("does not end a tracked call for an unrelated mixed-party update", () => {
  assert.deepEqual(
    resolveRingCentralSessionActions(
      [
        { status: { code: "Disconnected" } },
        { status: { code: "Answered" } },
      ],
      new Set(["101"]),
      new Set(["101"])
    ),
    []
  );
});

test("keeps mapped extension updates authoritative for multi-party sessions", () => {
  assert.deepEqual(
    resolveRingCentralSessionActions(
      [
        { extensionId: "101", status: { code: "Answered" } },
        { status: { code: "Disconnected" } },
      ],
      new Set(["101"]),
      new Set(["101"])
    ),
    [{ extensionId: "101", action: "add" }]
  );
});
