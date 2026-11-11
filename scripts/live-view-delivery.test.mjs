import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/EmployeeLiveShare.tsx", import.meta.url), "utf8");
function setup(path = "/leads", allowPeer = false) {
    let cursor = 0, instance = "provider", value, now = 100_000, timerId = 0, captures = 0, connects = 0;
    let business = "synthetic-a", auth = { userType: "employee", attendanceHubSession: "synthetic-session", user: { _id: "stored-id", employeeCode: "synthetic-owner", name: "Synthetic Owner" } };
    const state = { provider: [], prompt: [] }, effects = [], handlers = new Map(), emits = [], timers = new Map(), windowEvents = new Map(), documentEvents = new Map(), peers = [];
    const equal = (first, second) => first && second && first.length === second.length && first.every((item, index) => Object.is(item, second[index]));
    const memo = (make, deps) => { const index = cursor++, slots = state[instance]; if (!slots[index] || !equal(slots[index].deps, deps)) slots[index] = { deps, value: make() }; return slots[index].value; };
    const hooks = { ...React,
        useState(initial) { const index = cursor++, slots = state[instance]; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
            return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
        useRef(initial) { const index = cursor++, slots = state[instance]; return slots[index] ||= { current: initial }; },
        useMemo: memo, useCallback: (run, deps) => memo(() => run, deps), useContext: () => value, useSyncExternalStore: () => 0,
        useEffect(run, deps) { const index = cursor++, slots = state[instance]; if (!slots[index] || !equal(slots[index].deps, deps)) {
            const prior = slots[index]; slots[index] = { deps }; effects.push(() => { prior?.cleanup?.(); slots[index].cleanup = run(); }); } },
    };
    const socket = { connected: true, on(name, run) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(run); },
        off(name, run) { handlers.get(name)?.delete(run); }, emit(name, payload) { emits.push({ name, payload }); },
        timeout() { return { emit(name, payload, reply) { emits.push({ name, payload }); reply(null, { ok: true }); } }; } };
    const favicon = { href: "synthetic-icon" };
    const window = { focus() {}, setTimeout(run, delay) { timers.set(++timerId, { run, at: now + delay, interval: false }); return timerId; },
        clearTimeout(id) { timers.delete(id); }, setInterval(run, delay) { timers.set(++timerId, { run, at: now + delay, interval: true }); return timerId; }, clearInterval(id) { timers.delete(id); },
        addEventListener(name, run) { windowEvents.set(name, run); }, removeEventListener(name) { windowEvents.delete(name); } };
    const document = { title: "Synthetic CRM", visibilityState: "visible", createElement: () => ({ getContext: () => null }), querySelector: () => favicon,
        addEventListener(name, run) { documentEvents.set(name, run); }, removeEventListener(name) { documentEvents.delete(name); } };
    let capture = async () => { throw Error("Synthetic permission not granted"); };
    const mocks = { react: hooks, "react-router": { useLocation: () => ({ pathname: path }) }, "../api/authStorage": { getAuthUser: () => auth },
        "../api/businessStorage": { getActiveBusinessId: () => business }, "../lib/credentialContext": { getCredentialContextRevision: () => 0, subscribeCredentialContext() {} },
        "../lib/socket": { socket, connectAuthenticatedSocket() { connects++; } } };
    const exports = {};
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
        exports, require: name => mocks[name] || require(name), window, document, Date: class extends Date { static now() { return now; } },
        navigator: { mediaDevices: { getDisplayMedia: (...args) => { captures++; return capture(...args); } } },
        RTCPeerConnection: class {
            constructor() { assert.ok(allowPeer, "No peer may be created without current employee consent"); peers.push(this); this.connectionState = "new"; }
            addTrack() {}
            async createOffer() { return { type: "offer", sdp: "synthetic-offer" }; }
            async setLocalDescription(offer) { this.localDescription = offer; }
            close() { this.connectionState = "closed"; }
        },
    });
    const flush = () => { while (effects.length) effects.shift()(); };
    const render = () => { instance = "provider"; cursor = 0; const tree = exports.EmployeeLiveShareProvider({ children: React.createElement("main", null, "Synthetic page") });
        value = tree.props.value; flush(); return tree; };
    const prompt = () => { const tree = render(), element = tree.props.children[1]; if (!element) return "";
        instance = "prompt"; cursor = 0; const html = renderToStaticMarkup(element); flush(); return html; };
    const server = (name, payload) => { for (const run of handlers.get(name) || []) run(payload); };
    const requested = (extra = {}) => ({ requestId: "synthetic-request", employeeId: auth.user._id, employeeCode: auth.user.employeeCode, businessId: business, remainingMs: 30_000, ...extra });
    render();
    return { render, prompt, server, requested, emits, socket, windowEvents, documentEvents, timers, peers, get value() { return value; },
        get captures() { return captures; }, get connects() { return connects; }, capture(run) { capture = run; },
        clock(time) { now = time; }, switchBusiness() { business = "synthetic-b"; }, logout() { auth = null; },
        expire() { for (const [id, timer] of timers) if (!timer.interval) { timers.delete(id); timer.run(); } },
        dispose() { for (const slots of Object.values(state)) for (const slot of slots) slot?.cleanup?.(); } };
}

test("consent prompt is global on every employee route, appears once and never starts capture automatically", () => {
    for (const path of ["/dashboard", "/leads", "/attendance", "/profile", "/tasks"]) {
        const app = setup(path);
        try {
            app.server("live-share:requested", app.requested());
            const html = app.prompt(); assert.equal((html.match(/role="dialog"/g) || []).length, 1); assert.match(html, /Allow Live View/);
            assert.equal(app.captures, 0); assert.equal(app.emits.filter(item => item.name === "live-share:received").length, 1);
        } finally { app.dispose(); }
    }
});
test("signed server identity resolves stale stored ids, with strict business and employee-code matching", () => {
    const app = setup();
    try {
        for (const extra of [{ businessId: "foreign" }, { employeeCode: "other" }, { employeeId: "canonical-id" }]) {
            app.server("live-share:requested", app.requested(extra)); assert.equal(app.prompt(), "");
        }
        app.server("presence:identity", { businessId: "synthetic-a", employeeCode: "synthetic-owner", employeeId: "canonical-id" });
        app.server("live-share:requested", app.requested({ employeeId: "canonical-id" })); assert.match(app.prompt(), /Allow Live View/);
    } finally { app.dispose(); }
});
test("admin cancellation clears a pending popup and delayed permission results cannot start sharing", async () => {
    const app = setup(); let complete, stopped = 0;
    try {
        app.server("live-share:requested", app.requested()); app.prompt();
        app.capture(() => new Promise(resolve => { complete = resolve; }));
        const starting = app.value.startLiveShare(app.value.pendingRequest);
        app.server("live-share:stopped", { requestId: "synthetic-request" });
        complete({ getTracks: () => [{ stop() { stopped++; } }] }); await starting;
        assert.equal(app.prompt(), ""); assert.equal(stopped, 1);
        assert.equal(app.emits.filter(item => item.name === "live-share:accept").length, 0);
    } finally { app.dispose(); }
});
test("a second request cannot replace consent while the screen permission picker is open", async () => {
    const app = setup("/leads", true); let complete, stopped = 0;
    try {
        app.server("live-share:requested", app.requested()); app.prompt();
        app.capture(() => new Promise(resolve => { complete = resolve; }));
        const starting = app.value.startLiveShare(app.value.pendingRequest);
        app.server("live-share:requested", app.requested({ requestId: "synthetic-second" })); app.render();
        assert.equal(app.value.pendingRequest.requestId, "synthetic-request");
        assert.ok(app.emits.some(item => item.name === "live-share:decline" && item.payload.requestId === "synthetic-second" && item.payload.reason === "busy"));
        complete({ getTracks: () => [{ stop() { stopped++; } }] }); await starting; app.render();
        assert.equal(app.value.activeRequestId, "synthetic-request"); assert.equal(app.value.starting, false); assert.equal(stopped, 0);
    } finally { app.dispose(); }
});
test("late callbacks from a stopped share cannot stop or signal for a newer accepted share", async () => {
    const app = setup("/leads", true), tracks = [];
    app.capture(async () => { const track = { stops: 0, stop() { this.stops++; } }; tracks.push(track); return { getTracks: () => [track] }; });
    try {
        app.server("live-share:requested", app.requested()); app.render();
        await app.value.startLiveShare(app.value.pendingRequest); app.render();
        const oldPeer = app.peers[0], oldTrack = tracks[0];
        app.value.stopLiveShare(); app.render();
        app.server("live-share:requested", app.requested({ requestId: "synthetic-second" })); app.render();
        await app.value.startLiveShare(app.value.pendingRequest); app.render();
        const emitted = app.emits.length;
        oldPeer.onicecandidate({ candidate: { toJSON: () => ({ candidate: "synthetic-stale" }) } });
        oldPeer.onconnectionstatechange(); oldTrack.onended(); app.render();
        assert.equal(app.value.activeRequestId, "synthetic-second"); assert.equal(tracks[1].stops, 0);
        assert.equal(app.peers[1].connectionState, "new"); assert.equal(app.emits.length, emitted);
    } finally { app.dispose(); }
});
test("decline, expiry and business changes discard requests without screen capture", () => {
    for (const action of [app => app.value.declineLiveShare(), app => app.expire(), app => { app.switchBusiness(); app.render(); }]) {
        const app = setup();
        try { app.server("live-share:requested", app.requested()); app.prompt(); action(app); assert.equal(app.prompt(), ""); assert.equal(app.captures, 0); }
        finally { app.dispose(); }
    }
});
test("reconnect and focus request only bounded pending recovery, never a polling loop", () => {
    const app = setup();
    try {
        const count = () => app.emits.filter(item => item.name === "live-share:pending").length;
        assert.equal(count(), 1); app.server("connect"); assert.equal(count(), 2);
        for (let index = 0; index < 30; index++) app.windowEvents.get("focus")(); assert.equal(count(), 2);
        app.clock(102_001); app.windowEvents.get("focus")(); assert.equal(count(), 3);
        app.socket.connected = false; app.clock(104_002); app.windowEvents.get("focus")(); assert.equal(app.connects, 2);
        assert.equal([...app.timers.values()].filter(timer => timer.interval).length, 0);
    } finally { app.dispose(); }
});
