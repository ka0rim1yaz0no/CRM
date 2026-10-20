import { AsyncLocalStorage } from "node:async_hooks";

const snapshots = new AsyncLocalStorage<number>();

// Internal read-only comparisons share a clock; HTTP clients cannot set this context.
export function serverReadTime() { return new Date(snapshots.getStore() ?? Date.now()); }
export function withReadSnapshot<T>(at: Date, read: () => T): T {
  if (!Number.isFinite(at.getTime())) throw new Error("Invalid server read snapshot.");
  return snapshots.run(at.getTime(), read);
}
