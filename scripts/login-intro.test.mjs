import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(file, sandbox = {}) {
  const source = readFileSync(new URL(`../src/components/login/${file}`, import.meta.url), "utf8").replace(/^import .*;\r?$/gm, "");
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, Error, ...sandbox });
  return exports;
}
const { loginIntroConfig: config } = load("loginIntroConfig.ts");

function fixture() {
  const timers = new Map();
  let nextTimer = 0, ready = 0, unavailable = 0, loads = 0, plays = 0, pauses = 0;
  const document = { hidden: false };
  const video = Object.assign(new EventTarget(), {
    dataset: {}, src: "", readyState: 0, currentTime: 0, ended: false,
    getAttribute() { return this.src || null; },
    removeAttribute() { this.src = ""; },
    load() { loads++; },
    play() { plays++; return Promise.resolve(); },
    pause() { pauses++; },
  });
  const { createVideoIntro } = load("videoIntro.ts", { config, document, performance: { now: () => 100 }, window: {
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  } });
  const controller = createVideoIntro(video, { ready() { ready++; }, unavailable() { unavailable++; } });
  return { controller, createVideoIntro, video, document, timers, counts: () => ({ ready, unavailable, loads, plays, pauses }) };
}

test("the self-hosted opening and GLB model exist in the release, not local-only paths", () => {
  for (const asset of [config.introVideoUrl, config.logoModelUrl]) {
    assert.ok(asset.startsWith("/") && !asset.includes(".."));
    assert.ok(statSync(new URL(`../public${asset}`, import.meta.url)).size > 1000);
  }
  assert.equal(readFileSync(new URL(`../public${config.logoModelUrl}`, import.meta.url)).subarray(0, 4).toString(), "glTF");
  assert.equal(readFileSync(new URL(`../public${config.introVideoUrl}`, import.meta.url)).subarray(4, 8).toString(), "ftyp");
});

test("video load has a bounded deadline and yields the sign-in fallback on failure", () => {
  const f = fixture(); f.controller.load();
  assert.equal(f.video.src, config.introVideoUrl);
  assert.equal(f.timers.size, 1);
  [...f.timers.values()][0]();
  assert.equal(f.counts().unavailable, 1);
  assert.equal(f.timers.size, 0);
});

test("decoded video clears its deadline and progresses on media time, then the reveal clock", () => {
  const f = fixture(); f.controller.load(); f.video.dispatchEvent(new Event("loadeddata"));
  assert.equal(f.counts().ready, 1); assert.equal(f.timers.size, 0);
  f.controller.play(); f.video.currentTime = 2;
  assert.equal(f.controller.time(1000), 2);
  f.video.currentTime = config.introVideoEnd;
  assert.equal(f.controller.time(2000), config.introVideoEnd);
  assert.equal(f.controller.time(3000), config.introVideoEnd + 1);
});

test("a rejected autoplay promise falls back instead of blocking sign-in", async () => {
  const f = fixture(); f.video.play = () => Promise.reject(new Error("autoplay blocked"));
  f.controller.play(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.counts().unavailable, 1);
});

test("tab sleep does not advance the post-video reveal clock or play hidden video", () => {
  const f = fixture(); f.document.hidden = true; f.controller.play();
  assert.equal(f.counts().plays, 0);
  f.document.hidden = false; f.controller.visibility(false, 1000, 0);
  assert.equal(f.counts().plays, 1);
  f.video.currentTime = config.introVideoEnd;
  f.controller.time(2000); f.controller.visibility(true, 2000, 0);
  f.controller.visibility(false, 12000, 10000);
  assert.equal(f.controller.time(12000), config.introVideoEnd);
});

test("skipping and unmounting cancel deadlines, media and event handlers", () => {
  const f = fixture(); f.controller.load(); f.controller.finish();
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
  f.video.dispatchEvent(new Event("error"));
  f.video.dispatchEvent(new Event("loadeddata"));
  assert.equal(f.counts().unavailable, 0); assert.equal(f.counts().ready, 0);
  assert.equal(f.video.src, "");
});

test("no video element is treated as unavailable rather than a successful opening", () => {
  const f = fixture(); let unavailable = 0;
  f.createVideoIntro(null, { ready() { assert.fail("missing media is not ready"); }, unavailable() { unavailable++; } }).load();
  assert.equal(unavailable, 1);
});
