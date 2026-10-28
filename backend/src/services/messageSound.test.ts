import assert from "node:assert/strict";
import test from "node:test";
import { createMessageSoundPlayer } from "../../../src/lib/messageSound";

function fixture() {
  let state = "running";
  let block = false;
  let tones = 0;
  let clock = 100_000;
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const context = {
    get state() { return state; }, currentTime: 1, destination: {},
    resume: async () => { if (block) throw new Error("Autoplay blocked"); state = "running"; },
    createOscillator: () => ({ frequency: { setValueAtTime() {} }, connect: () => ({ connect() {} }), start: () => { tones++; }, stop() {} }),
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }),
  } as unknown as AudioContext;
  const dependencies = { context: () => context, storage: () => storage, now: () => clock };
  return { dependencies, get tones() { return tones; }, suspend() { state = "suspended"; block = true; }, allow() { block = false; }, advance() { clock += 31_000; } };
}

test("message sound plays one five-tone cue per logical message across hooks and shared-storage tabs", async () => {
  const f = fixture();
  const first = createMessageSoundPlayer(f.dependencies);
  const second = createMessageSoundPlayer(f.dependencies);
  await first.incoming("shared-conversation:timestamp:sender");
  await first.incoming("shared-conversation:timestamp:sender");
  await second.incoming("shared-conversation:timestamp:sender");
  assert.equal(f.tones, 5);
  await second.incoming("other-message");
  assert.equal(f.tones, 10);
});

test("browser-blocked sound retries after a gesture without falsely claiming delivery", async () => {
  const f = fixture(); f.suspend();
  const player = createMessageSoundPlayer(f.dependencies);
  assert.equal(await player.incoming("message"), false); assert.equal(f.tones, 0);
  f.allow(); await player.unlock(); assert.equal(f.tones, 5);
  await player.unlock(); assert.equal(f.tones, 5);
});

test("storage denial does not silence messages and expired blocked cues do not replay", async () => {
  const f = fixture();
  const player = createMessageSoundPlayer({ ...f.dependencies, storage: () => { throw new Error("Storage denied"); } });
  assert.equal(await player.incoming("message"), true); assert.equal(f.tones, 5);
  f.suspend(); await player.incoming("old-message"); f.advance(); f.allow(); await player.unlock();
  assert.equal(f.tones, 5);
});

test("preview produces a fresh cue without resetting real-message deduplication", async () => {
  const f = fixture(); const player = createMessageSoundPlayer(f.dependencies);
  assert.equal(await player.preview(), true); assert.equal(await player.preview(), true);
  assert.equal(f.tones, 10);
});

test("returning from rest cancels a browser-blocked ping before the next gesture", async () => {
  const f = fixture(); f.suspend();
  const player = createMessageSoundPlayer({ ...f.dependencies, claimsKey: "rest-claims", claimLifetimeMs: 7 * 86_400_000 });
  await player.incoming("rest"); player.cancel("rest"); f.allow(); await player.unlock();
  assert.equal(f.tones, 0);
});

test("rest sound remains once-only across refreshes and businesses, independent of message claims", async () => {
  const f = fixture(), options = { ...f.dependencies, claimsKey: "rest-claims", claimLifetimeMs: 7 * 86_400_000 };
  await createMessageSoundPlayer(options).incoming("same-rest");
  f.advance(); await createMessageSoundPlayer(options).incoming("same-rest");
  assert.equal(f.tones, 5);
  await createMessageSoundPlayer(options).incoming("next-rest"); assert.equal(f.tones, 10);
  await createMessageSoundPlayer(f.dependencies).incoming("same-rest"); assert.equal(f.tones, 15);
});
