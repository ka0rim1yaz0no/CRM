import test from "node:test";
import assert from "node:assert/strict";
import { createObjectUrlStore } from "../../../src/lib/objectUrlStore";

test("attachment URL is created on subscription, shared, and revoked after the final subscriber", () => {
  const revoked: string[] = [];
  let created = 0;
  const store = createObjectUrlStore(new Blob(["synthetic attachment"]), {
    createObjectURL: () => `blob:fixture-${++created}`,
    revokeObjectURL: (url) => revoked.push(url),
  });
  assert.equal(created, 0);
  assert.equal(store.getSnapshot(), "");
  let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  const secondUnsubscribe = store.subscribe(() => undefined);
  assert.equal(changes, 1);
  assert.equal(created, 1);
  assert.equal(store.getSnapshot(), "blob:fixture-1");
  unsubscribe();
  assert.deepEqual(revoked, []);
  secondUnsubscribe();
  assert.deepEqual(revoked, ["blob:fixture-1"]);
  assert.equal(store.getSnapshot(), "");
});

test("attachment URL survives Strict Mode subscribe/cleanup/subscribe without leaking", () => {
  const revoked: string[] = [];
  let created = 0;
  const store = createObjectUrlStore(new Blob(["fake"]), {
    createObjectURL: () => `blob:fixture-${++created}`,
    revokeObjectURL: (url) => revoked.push(url),
  });
  store.subscribe(() => undefined)();
  const unsubscribe = store.subscribe(() => undefined);
  assert.equal(store.getSnapshot(), "blob:fixture-2");
  unsubscribe();
  assert.deepEqual(revoked, ["blob:fixture-1", "blob:fixture-2"]);
});

test("a pending attachment never creates or revokes a URL", () => {
  const store = createObjectUrlStore(undefined, {
    createObjectURL: () => { throw new Error("unexpected URL creation"); },
    revokeObjectURL: () => { throw new Error("unexpected URL revocation"); },
  });
  const unsubscribe = store.subscribe(() => { throw new Error("unexpected update"); });
  assert.equal(store.getSnapshot(), "");
  unsubscribe();
});
