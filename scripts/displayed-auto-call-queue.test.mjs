import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";

const source = readFileSync(new URL("../src/components/EmployeeAutoCaller.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("caller.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const code = ts.transpileModule(ts.createPrinter().printFile(ts.factory.updateSourceFile(ast, ast.statements.filter(node => !ts.isImportDeclaration(node)))), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const first = { _id: "server-head", status: "Follow up", phone: "+12025550121", businessName: "Synthetic callback", comments: [] };
function fixture(options = {}) {
    let clock = 0, business = options.business || "fake-a", nextTimer = 0, nextAttempt = 0, work = "", active = Boolean(options.busy), dispatchStartedAt = 0, dialPendingUntil = 0;
    const effects = [], cleanups = [], refs = [], timers = new Map(), intervals = new Map(), listeners = new Map();
    let refIndex = 0;
    let lastEndedAt = options.cooldown ? options.cooldown - 30000 : null;
    const calls = { reserve: [], dispatch: [], launch: [], launchAt: [], release: [], record: [], preparation: [], queue: 0, queueAt: [], progress: [], navigation: [] };
    const employee = { _id: "fake-person", employeeCode: "fake-code", role: "Sales", availabilityStatus: options.availability || "ONLINE" };
    const auth = { userType: "employee", user: employee, attendanceHubSession: "fake-signed-session" };
    const serverTime = () => new Date(Date.parse("2026-10-22T17:00:00Z") + clock).toISOString();
    const page = () => { const head = options.headAt?.(clock) || first; return { leads: [head], callingQueue: { scope: { employeeId: employee._id, businessId: business }, version: "server-version",
        serverTime: serverTime(), nextLead: options.empty ? null : head, nextLeadId: options.empty ? null : head._id,
        nextDecision: { normalizedPhone: head.phone }, callingWindow: { permitted: options.outside !== true }, nextEligibilityChangeAt: options.nextAt || null } }; };
    const status = () => ({ ready: !options.bridgeUnavailable && !active && clock >= (options.cooldown || 0) && clock >= dialPendingUntil,
        state: options.bridgeUnavailable ? "unknown" : active ? "active" : clock < dialPendingUntil ? "calling" : "idle", reason: options.bridgeUnavailable ? "Call Bridge cannot confirm provider state" : undefined,
        serverTime: new Date(Date.parse("2026-10-22T17:00:00Z") + clock).toISOString(),
        nextCallAllowedAt: options.cooldown ? new Date(Date.parse("2026-10-22T17:00:00Z") + options.cooldown).toISOString() : null,
        lastCallEndedAt: lastEndedAt !== null ? new Date(Date.parse("2026-10-22T17:00:00Z") + lastEndedAt).toISOString() : null,
        deadlineDispatchEnabled: options.deadline === true, deadlinePreparationMs: 12000,
        observedAttemptId: active ? options.unrelated ? "other-attempt" : calls.reserve.at(-1)?.attemptId : null,
        observedLeadId: active ? options.unrelated ? "other-lead" : calls.reserve.at(-1)?.leadId : null });
    const window = { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name),
        setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: clock + delay }); return id; }, clearTimeout: id => timers.delete(id),
        setInterval: callback => { const id = ++nextTimer; intervals.set(id, callback); return id; }, clearInterval: id => intervals.delete(id) };
    const latency = () => options.apiLatency ? new Promise(resolve => window.setTimeout(resolve, options.apiLatency)) : Promise.resolve();
    const fetchQueue = async () => { calls.queue++; calls.queueAt.push(clock); await latency(); if (options.queueFailure) throw new Error("Synthetic queue failure"); return page(); };
    const client = options.realQueryClient ? new QueryClient({ defaultOptions: { queries: { retry: options.defaultRetry ?? false, gcTime: Infinity } } }) : null;
    const observer = client && new QueryObserver(client, { queryKey: ["calling-queue", business, employee._id], queryFn: fetchQueue, initialData: page(), staleTime: Infinity });
    const unsubscribe = observer?.subscribe(() => {});
    const exports = {};
    class BrowserDate extends Date { static now() { return super.now() + (options.wrongClock ? 86400000000 : 0); } }
    runInNewContext(code, { exports, JSON, Date: BrowserDate, Symbol, AbortController, performance: { now: () => clock }, window,
        document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {}, body: { appendChild() {} },
            createElement: () => ({ href: "", setAttribute() {}, remove() {}, click() { calls.launch.push(this.href); calls.launchAt.push(clock); active = !options.launchUnconfirmed; } }) },
        crypto: { randomUUID: () => `attempt-${++nextAttempt}` },
        useEffect: callback => effects.push(callback), useLayoutEffect: callback => effects.push(callback),
        useNavigate: () => (...args) => calls.navigation.push(args), useLocation: () => ({ pathname: "/dashboard", search: "" }), URLSearchParams,
        useMemo: make => make(), useRef: value => refs[refIndex++] ||= { current: value }, useSyncExternalStore: (_subscribe, get) => get(), useCallingQueue() {},
        useQueryClient: () => ({ setQueryData() {}, fetchQuery: input => client ? client.fetchQuery({ ...input, queryFn: fetchQueue }) : fetchQueue(),
            invalidateQueries: (...args) => client ? client.invalidateQueries(...args) : Promise.resolve() }),
        getAuthUser: () => auth, getActiveBusinessId: () => business, callingQueueKey: scope => ["calling-queue", scope.businessId, scope.employeeId],
        callingWorkMessage: () => work, callingWorkflowChanged: "work-changed", setCallingProgress: (_scope, value) => calls.progress.push(value),
        fetchCallingQueue() {}, socket: { on: (name, listener) => listeners.set(`socket:${name}`, listener), off: name => listeners.delete(`socket:${name}`) },
        getEmployeeSummary: async () => { await latency(); await options.onSummary?.(); return employee; }, isSalesRole: role => role === "Sales", normalizeEmployeeAvailabilityStatus: value => value,
        attendanceIntegrityEnabled: options.integrity !== false,
        getAttendanceSession: async () => { await latency(); await options.onSummary?.(); return { state: employee.availabilityStatus }; },
        callingAttendancePending: () => Boolean(options.attendanceSaving),
        callingAttendanceBlock: () => options.attendanceSaving ? "Saving attendance" : employee.availabilityStatus !== "ONLINE" ? "Employee not ONLINE" : "",
        callingAttendanceChanged: "attendance-changed",
        activateCallBridgeForEmployee: async () => { await latency(); await options.onActivation?.(); return {}; }, canUseCallBridgeBrowserSession: () => options.activationBlocked !== true,
        getCallBridgeStatus: async () => { await latency(); await options.onBridgeStatus?.(); return status(); },
        prepareCallBridgeDeadline: async (_code, input) => {
            calls.preparation.push({...input, at: clock}); await latency();
            const existing = calls.dispatch.find(row => row.reservationToken === input.attemptId);
            if (!existing) {
                const at = Date.parse(input.notBefore) - Date.parse("2026-10-22T17:00:00Z");
                await new Promise((resolve, reject) => {
                    const abort = () => {window.clearTimeout(timer); reject(Object.assign(new Error("Cancelled"), {code: "ERR_CANCELED"}));};
                    const timer = window.setTimeout(() => {input.signal.removeEventListener("abort", abort); resolve();}, Math.max(0, at - clock));
                    if (input.signal.aborted) abort(); else input.signal.addEventListener("abort", abort, {once: true});
                });
                if (active || options.bridgeUnavailable || employee.availabilityStatus !== "ONLINE" || options.attendanceSaving) throw {response: {status: 409, data: {code: "CALL_ATTENDANCE_CHANGED"}}};
                const head = options.headAt?.(clock) || first;
                dispatchStartedAt = clock; options.cooldown = clock + 30000; dialPendingUntil = clock + 30000;
                calls.reserve.push({attemptId: input.attemptId, leadId: head._id, normalizedPhone: head.phone, businessId: input.businessId, at: clock});
                calls.dispatch.push({leadId: head._id, reservationToken: input.attemptId, businessId: input.businessId, at: clock});
            }
            const responseServerTime=serverTime();
            await latency(); if(options.deadlineResponseDelay)await new Promise(resolve=>window.setTimeout(resolve,options.deadlineResponseDelay));
            await options.onDispatch?.({setAvailability: value => {employee.availabilityStatus=value;},setAttendanceSaving: value => {options.attendanceSaving=value;}});
            if (options.lostDeadline && calls.preparation.length === 1) throw Error("Synthetic lost deadline response");
            const head = options.headAt?.(dispatchStartedAt) || first;
            return {startedAt: serverTime(), serverTime: responseServerTime, dialIntentUntil: new Date(Date.parse("2026-10-22T17:00:00Z") + dispatchStartedAt + 30000).toISOString(),
                alreadyStarted: Boolean(existing), reservationToken: input.attemptId, leadId: head._id, normalizedPhone: head.phone, lead: head};
        },
        reserveCallBridgeCall: async (_code, input) => { calls.reserve.push({ ...input, at: clock }); await latency(); await options.onReserve?.({ switchBusiness: () => { business = "fake-b"; }, setAvailability: value => { employee.availabilityStatus = value; } });
            if (options.lostReserve && calls.reserve.length === 1) throw new Error("Synthetic lost reserve response");
            if (options.queueChanged && calls.reserve.length === 1) throw { response: { status: 409, data: { code: "CALL_QUEUE_CHANGED", message: "Queue changed" } } };
            if (calls.reserve.length <= (options.queueConflicts || 0)) throw { response: { status: 409, data: { code: "CALL_QUEUE_CHANGED", message: "Queue changed" } } };
            return { allowed: true, reservationToken: input.attemptId, leadId: input.leadId, normalizedPhone: input.normalizedPhone }; },
        markCallBridgeDialStarted: async (_code, input) => { calls.dispatch.push({ ...input, at: clock });
            if (!options.lostDispatch || calls.dispatch.length === 1) dispatchStartedAt = clock;
            options.cooldown = dispatchStartedAt + 30000;
            dialPendingUntil = dispatchStartedAt + 30000;
            await latency();
            await options.onDispatch?.({ setAvailability: value => { employee.availabilityStatus = value; }, setAttendanceSaving: value => { options.attendanceSaving = value; } });
            if (options.lostDispatch && calls.dispatch.length === 1) throw new Error("Synthetic lost dispatch response");
            return { leadId: input.leadId, normalizedPhone: calls.reserve.at(-1)?.normalizedPhone, alreadyStarted: Boolean(options.lostDispatch && calls.dispatch.length > 1),
                serverTime: serverTime(), dialIntentUntil: new Date(Date.parse("2026-10-22T17:00:00Z") + dispatchStartedAt + 30000).toISOString() }; },
        releaseCallBridgeCall: async (_code, input) => { calls.release.push({ ...input, at: clock });
            if (options.releaseConflict) throw { response: { status: 409, data: { code: "CALL_RESERVATION_MISMATCH" } } };
            dialPendingUntil = 0; },
        startAutoCallPendingComment() {}, getEmployeeCommentMarker: () => "", recordLeadCall: async (_id, input, request) => calls.record.push({ input, request }),
        AUTO_CALL_API_TIMEOUT_MS: 10000, AUTO_CALL_CHECK_INTERVAL_MS: 5000, callTimingV2Enabled: options.timing !== false,
    });
    const mount = () => { refIndex = 0; effects.length = 0; exports.default(); for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } };
    const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
    const advance = async milliseconds => {
        const until = clock + milliseconds;
        while (true) {
            const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            clock = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
        }
        clock = until;
    };
    mount();
    return { calls, settle, advance, availability: value => { employee.availabilityStatus = value; }, tick: async () => { for (const callback of intervals.values()) callback(); await settle(); },
        event: async name => { listeners.get(name)?.(); await settle(); },
        refresh: () => { for (const cleanup of cleanups.splice(0)) cleanup(); refs.length = 0; mount(); },
        endCall: () => { active = false; dialPendingUntil = 0; lastEndedAt = clock; options.cooldown = clock + 30000; },
        cancelQueue: () => client?.cancelQueries({ queryKey: ["calling-queue", business, employee._id] }),
        work: value => { work = value; }, stop: () => { for (const cleanup of cleanups.splice(0)) cleanup(); unsubscribe?.(); client?.clear(); }, switchBusiness: () => { business = "fake-b"; } };
}

test("six businesses prepare during cooldown and authorize at 30000ms instead of adding serial API delays", async () => {
    for (let i = 0; i < 6; i++) {
        const latencyMs = i % 2 ? 1000 : 500;
        const state = fixture({business: `deadline-${i}`, deadline: true, cooldown: 30000, apiLatency: latencyMs});
        try {
            await state.settle(); await state.advance(29999);
            assert.equal(state.calls.dispatch.length, 0);
            await state.advance(1); assert.equal(state.calls.dispatch.length, 1);
            assert.equal(state.calls.dispatch[0].at, 30000);
            assert.ok(state.calls.preparation[0].at < 30000);
            await state.advance(latencyMs); assert.equal(state.calls.launchAt[0], 30000 + latencyMs, "only the response transport remains after authorization");
            assert.equal(state.calls.queue, 0, "the deadline endpoint selects the authoritative head without a second browser queue read");
        } finally {state.stop();}
    }
});

test("Off the Phone and page refresh cancel preparation before any dial is authorized", async () => {
    for (const action of ["off-phone", "refresh"]) {
        const state = fixture({deadline: true, cooldown: 30000});
        try {
            await state.settle(); await state.advance(20000);
            assert.equal(state.calls.preparation.length, 1);
            state.availability("OFF THE PHONE");
            if (action === "refresh") state.refresh(); else await state.event("attendance-changed");
            await state.settle(); await state.advance(15000);
            assert.equal(state.calls.dispatch.length, 0); assert.equal(state.calls.launch.length, 0);
        } finally {state.stop();}
    }
});

test("an Off the Phone click after deadline approval still prevents the telephone launch in every business", async () => {
    for (let i=0;i<6;i++) {
        const state=fixture({business:`deadline-race-${i}`,deadline:true,cooldown:30000,onDispatch:({setAvailability})=>setAvailability("OFF THE PHONE")});
        try {await state.settle();await state.advance(30000);assert.equal(state.calls.dispatch.length,1);assert.equal(state.calls.launch.length,0);assert.equal(state.calls.release.length,1);}
        finally{state.stop();}
    }
});

test("a lost deadline response reuses its attempt and never launches a replay twice", async () => {
    const state=fixture({deadline:true,cooldown:30000,lostDeadline:true});
    try {await state.settle();await state.advance(30000);await state.advance(5000);await state.tick();
        assert.equal(state.calls.dispatch.length,1);assert.equal(new Set(state.calls.preparation.map(row=>row.attemptId)).size,1);assert.equal(state.calls.launch.length,0);}
    finally{state.stop();}
});

test("refreshing an ONLINE browser during preparation preserves the original 30-second deadline", async () => {
    const state=fixture({deadline:true,cooldown:30000,apiLatency:1000});
    try {await state.settle();await state.advance(25000);state.refresh();await state.settle();await state.advance(4999);
        assert.equal(state.calls.dispatch.length,0);await state.advance(1);assert.equal(state.calls.dispatch.length,1);assert.equal(state.calls.dispatch[0].at,30000);
        await state.advance(1000);assert.equal(state.calls.launch.length,1);}
    finally{state.stop();}
});

test("a deadline authorization delayed by sleep or transport is not launched as a fresh call", async () => {
    const state=fixture({deadline:true,cooldown:30000,deadlineResponseDelay:5000,wrongClock:true});
    try{await state.settle();await state.advance(35000);assert.equal(state.calls.dispatch.length,1);assert.equal(state.calls.launch.length,0);
        assert.equal(state.calls.release.length,1);assert.ok(state.calls.progress.some(message=>message.includes("arrived late")));}
    finally{state.stop();}
});

test("a business switch or unsaved work cancels a prepared deadline call without touching another scope", async () => {
    for (const change of ["business","work"]) {
        const state=fixture({deadline:true,cooldown:30000});
        try{await state.settle();await state.advance(20000);
            if(change==="business"){state.switchBusiness();await state.event("storage");}else{state.work("Saving lead changes");await state.event("work-changed");}
            await state.advance(15000);assert.equal(state.calls.dispatch.length,0);assert.equal(state.calls.launch.length,0);}
        finally{state.stop();}
    }
});

test("a browser offline hint cannot pause a queue read indefinitely or add hidden query retries", async () => {
    onlineManager.setOnline(false);
    const options = { realQueryClient: true, defaultRetry: true, queueFailure: true }, state = fixture(options);
    try {
        await state.settle();
        assert.equal(state.calls.queue, 1, "the timeout-bounded request must run even when the browser's online hint is false");
        assert.equal(state.calls.launch.length, 0);
        assert.ok(state.calls.progress.at(-1).includes("Retrying"));
        options.queueFailure = false;
        await state.advance(5000); await state.settle();
        assert.equal(state.calls.launch.length, 1, "the coordinator owns the retry instead of waiting in a paused query");
    } finally { state.stop(); onlineManager.setOnline(true); }
});

test("queue, bridge activation and bridge readiness have separate visible waiting states", async () => {
    let finishActivation, finishStatus;
    const state = fixture({ onActivation: () => new Promise(resolve => { finishActivation = resolve; }),
        onBridgeStatus: () => new Promise(resolve => { finishStatus = resolve; }) });
    try {
        await state.settle();
        assert.equal(state.calls.progress.at(-1), "Connecting to Call Bridge");
        finishActivation(); await state.settle();
        assert.equal(state.calls.progress.at(-1), "Checking Call Bridge readiness");
        finishStatus(); await state.settle();
        assert.equal(state.calls.launch.length, 1);
    } finally { state.stop(); }
});

test("an obsolete release conflict does not strand the queue or launch the old reservation", async () => {
    const state = fixture({ queueChanged: true, releaseConflict: true });
    try {
        await state.settle();
        await state.advance(5000); await state.settle();
        assert.equal(state.calls.launch.length, 1);
        assert.equal(state.calls.reserve.length, 2);
        assert.equal(state.calls.progress.at(-1), "Dial requested; waiting for call confirmation");
    } finally { state.stop(); }
});

test("an intentional cancellation after a saved lead update refreshes immediately without network backoff", async () => {
    const state = fixture({ realQueryClient: true, apiLatency: 100 });
    try {
        await state.settle(); await state.advance(150);
        await state.cancelQueue(); await state.settle();
        await state.advance(1000);
        assert.equal(state.calls.launch.length, 1, "a confirmed cache update is not a service outage");
        assert.equal(state.calls.reserve.length, 1);
        assert.ok(!state.calls.progress.some(message => message.includes("service unavailable")));
    } finally { state.stop(); }
});

test("live dashboard updates cannot cancel a slow authoritative queue read and strand the caller in backoff", async () => {
    for (let index = 0; index < 6; index++) {
        const business = `synthetic-${index}`, state = fixture({ realQueryClient: true, apiLatency: 200, business });
        try {
            await state.settle(); await state.advance(200);
            for (let event = 0; event < 4; event++) {
                await state.advance(40); await state.event("socket:call-dashboard:updated");
            }
            await state.advance(2000);
            assert.equal(state.calls.launch.length, 1, "socket traffic must not require a browser refresh to complete the first call");
            assert.equal(state.calls.reserve.length, 1);
            assert.equal(state.calls.reserve[0].businessId, business);
            assert.ok(!state.calls.progress.some(message => message.includes("service unavailable")), "query cancellation must not masquerade as a provider failure");
        } finally { state.stop(); }
    }
});

test("reconnect and restored-page events resume an eligible caller without refreshing or double dialing", async () => {
    for (const name of ["online", "pageshow", "socket:connect"]) {
        const options = { bridgeUnavailable: true }, state = fixture(options);
        try {
            await state.settle(); assert.equal(state.calls.launch.length, 0);
            options.bridgeUnavailable = false;
            await state.event(name);
            assert.equal(state.calls.launch.length, 1, `${name} must resume normal readiness checks`);
            await state.event(name); await state.event(name);
            await state.advance(2000); await state.tick();
            assert.equal(state.calls.launch.length, 1, "repeated recovery notifications cannot duplicate an active call");
        } finally { state.stop(); }
    }
});

test("live updates during a slow read preserve active calls and the original post-call deadline", async () => {
    const state = fixture({ realQueryClient: true, busy: true, apiLatency: 100 });
    try {
        await state.settle(); await state.advance(100);
        for (let event = 0; event < 4; event++) {
            await state.advance(20); await state.event("socket:call-dashboard:updated");
        }
        await state.advance(2000);
        assert.equal(state.calls.reserve.length, 0);
        assert.equal(state.calls.release.length, 0, "refresh recovery must not release an observed active call");
        state.endCall(); await state.event("socket:call-dashboard:updated");
        await state.advance(29999);
        assert.equal(state.calls.launch.length, 0, "no recovery event can shorten the server cooldown");
        await state.advance(1001);
        assert.equal(state.calls.launch.length, 1);
        assert.ok(state.calls.launchAt[0] >= 32180 && state.calls.launchAt[0] <= 33180);
    } finally { state.stop(); }
});

test("the actual coordinator reserves and launches only the authoritative target, independently of browsing or pending notes", async () => {
    const state = fixture();
    try {
        await state.settle();
        assert.deepEqual(state.calls.reserve.map(input => input.leadId), [first._id]);
        assert.equal(state.calls.reserve[0].queueVersion, "server-version");
        assert.deepEqual(state.calls.launch, [`tel:${first.phone}`]);
        await state.advance(2000);
        assert.equal(state.calls.record[0].input.callOutcome, "confirmed");
        assert.equal(state.calls.record[0].request.businessId, "fake-a");
    } finally { state.stop(); }
});

test("30-second server cooldown survives preparation; no browser wall clock grants permission early", async () => {
    const state = fixture({ cooldown: 30000, wrongClock: true });
    try {
        await state.settle(); await state.advance(29999);
        assert.equal(state.calls.reserve.length, 0);
        await state.advance(1);
        assert.equal(state.calls.reserve.length, 1);
        assert.equal(state.calls.reserve[0].at, 30000);
    } finally { state.stop(); }
});

test("a lost reserve response reuses its attempt ID and a lost dispatch response never launches twice", async () => {
    for (const fault of ["lostReserve", "lostDispatch"]) {
        const state = fixture({ [fault]: true });
        try {
            await state.settle(); await state.advance(5000); await state.tick();
            assert.ok(state.calls.reserve.length >= 1);
            assert.equal(new Set(state.calls.reserve.map(input => input.attemptId)).size, 1);
            assert.equal(state.calls.launch.length, fault === "lostReserve" ? 1 : 0);
            assert.ok(state.calls.progress.some(message => /unavailable|confirmed/.test(message)));
        } finally { state.stop(); }
    }
});

test("stale queue rejection is retried without permanently excluding the lead", async () => {
    const state = fixture({ queueChanged: true });
    try {
        await state.settle(); assert.equal(state.calls.launch.length, 0);
        await state.advance(5000); await state.tick();
        assert.equal(state.calls.reserve.length, 2); assert.equal(state.calls.launch.length, 1);
    } finally { state.stop(); }
});

test("a failed queue read recovers without excluding any lead", async () => {
    const options = { queueFailure: true }, state = fixture(options);
    try {
        await state.settle(); assert.equal(state.calls.launch.length, 0);
        options.queueFailure = false;
        await state.advance(5000); await state.tick();
        assert.equal(state.calls.reserve[0].leadId, first._id);
        assert.equal(state.calls.launch.length, 1);
    } finally { state.stop(); }
});

test("business changes after reservation release only the captured scope and never launch the old target", async () => {
    const state = fixture({ onReserve: ({ switchBusiness }) => switchBusiness() });
    try {
        await state.settle();
        assert.equal(state.calls.launch.length, 0);
        assert.equal(state.calls.release.length, 1);
        assert.equal(state.calls.release[0].businessId, "fake-a");
    } finally { state.stop(); }
});

test("unsaved or saving work waits without discarding drafts, then resumes the next eligible lead", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ onSummary: () => gate });
    try {
        state.work("Saving lead changes"); release(); await state.settle();
        assert.equal(state.calls.launch.length, 0);
        state.work(""); await state.tick();
        assert.equal(state.calls.launch.length, 1);
    } finally { release(); state.stop(); }
});

test("employee availability, hours, bridge refusal, empty queue and failed reads have distinct waiting reasons", async () => {
    for (const [options, reason] of [[{ availability: "BREAK" }, "Employee not ONLINE"], [{ outside: true }, "Outside calling hours"],
        [{ activationBlocked: true }, "Call Bridge is waiting"], [{ busy: true }, "Waiting for current call to end"], [{ empty: true }, "No eligible assigned leads"], [{ queueFailure: true }, "unavailable"]]) {
        const state = fixture(options);
        try { await state.settle(); assert.equal(state.calls.launch.length, 0); assert.ok(state.calls.progress.some(message => message.includes(reason))); }
        finally { state.stop(); }
    }
});

test("an unrelated observed call cannot confirm this reserved lead", async () => {
    const state = fixture({ unrelated: true });
    try {
        await state.settle(); await state.advance(30000);
        assert.equal(state.calls.record[0].input.callOutcome, "failed");
        assert.equal(state.calls.progress.at(-1), "Dial launch not confirmed");
    } finally { state.stop(); }
});

test("an active call takes precedence over an old cooldown deadline", async () => {
    const state = fixture({ busy: true, cooldown: 30000 });
    try {
        await state.settle();
        assert.equal(state.calls.progress.at(-1), "Waiting for current call to end");
        await state.advance(30000); await state.tick();
        assert.equal(state.calls.reserve.length, 0);
    } finally { state.stop(); }
});

test("persistent network failures back off instead of retrying indefinitely every five seconds", async () => {
    const state = fixture({ queueFailure: true });
    try {
        await state.settle(); await state.advance(5000); await state.tick();
        assert.deepEqual(state.calls.queueAt, [0, 5000]);
        await state.advance(5000); await state.tick();
        assert.deepEqual(state.calls.queueAt, [0, 5000]);
        await state.advance(5000); await state.tick();
        assert.deepEqual(state.calls.queueAt, [0, 5000, 15000]);
    } finally { state.stop(); }
});

test("an unapproved frontend timing configuration cannot initiate automatic calls", async () => {
    const state = fixture({ timing: false });
    try { await state.settle(); assert.equal(state.calls.reserve.length, 0); assert.match(state.calls.progress.at(-1), /timing.*configuration/i); }
    finally { state.stop(); }
});

test("measured deadline wake selects a newly due callback without a full extra poll", async context => {
    const callback = { ...first, _id: "newly-due-callback", phone: "+12025550123" };
    const fresh = { ...first, _id: "eligible-new", status: "NEW" };
    for (const apiLatency of [0, 40]) {
        const state = fixture({ cooldown: 30000, apiLatency, wrongClock: true, headAt: clock => clock >= 25000 ? callback : fresh });
        try {
            await state.settle(); await state.advance(29999);
            assert.equal(state.calls.reserve.length, 0);
            await state.advance(501);
            assert.equal(state.calls.reserve.length, 1);
            assert.equal(state.calls.reserve[0].leadId, callback._id);
            assert.equal(state.calls.reserve[0].at, 30000 + 4 * apiLatency);
            assert.equal(state.calls.dispatch[0].at, 30000 + 5 * apiLatency);
            assert.equal(state.calls.launchAt[0], 30000 + 6 * apiLatency);
            const at = offset => new Date(Date.parse("2026-10-22T17:00:00Z") + offset).toISOString();
            context.diagnostic(JSON.stringify({ layer: "actual-coordinator/fake-clock/mocked-API", apiLatencyMs: apiLatency, endedAt: at(0),
                nextCallAllowedAt: at(30000), reserveAttemptAt: at(state.calls.reserve[0].at), dialAttemptAt: at(state.calls.dispatch[0].at),
                mockedLaunchAt: at(state.calls.launchAt[0]), schedulingJitterMs: state.calls.launchAt[0] - 30000, realCalls: 0 }));
        } finally { state.stop(); }
    }
});

test("polling, a browser refresh and temporary note/status saves do not reset the server deadline", async () => {
    const state = fixture({ cooldown: 30000 });
    try {
        await state.settle(); await state.advance(7000); await state.tick();
        state.work("Saving lead changes"); await state.advance(7000); state.refresh(); await state.settle();
        await state.advance(6000); state.work(""); await state.event("work-changed");
        await state.advance(9999); assert.equal(state.calls.reserve.length, 0);
        await state.advance(1); assert.equal(state.calls.reserve[0].at, 30000);
    } finally { state.stop(); }
});

test("a three-minute active call is never interrupted and waits thirty seconds after its actual end", async () => {
    const state = fixture({ busy: true });
    try {
        await state.settle();
        for (let count = 0; count < 6; count++) { await state.advance(30000); await state.tick(); assert.equal(state.calls.reserve.length, 0); }
        state.endCall(); await state.event("focus");
        await state.advance(29999); assert.equal(state.calls.reserve.length, 0);
        await state.advance(1); assert.equal(state.calls.reserve[0].at, 210000);
    } finally { state.stop(); }
});

test("missing provider confirmation cannot retry through an unknown bridge", async () => {
    const options = { launchUnconfirmed: true }, state = fixture(options);
    try {
        await state.settle(); options.bridgeUnavailable = true;
        await state.advance(30000); await state.tick();
        assert.equal(state.calls.record[0].input.callOutcome, "failed");
        assert.equal(state.calls.release[0].at, 30000);
        await state.advance(30000); await state.tick();
        assert.equal(state.calls.reserve.length, 1);
        options.bridgeUnavailable = false; await state.tick();
        assert.equal(state.calls.reserve.length, 2, "once a fresh idle provider is available, the original retry deadline has already passed");
    } finally { state.stop(); }
});

test("lost dispatch replay uses the original server confirmation deadline instead of adding thirty more seconds", async () => {
    const state = fixture({ lostDispatch: true });
    try {
        await state.settle(); await state.advance(30000);
        assert.equal(state.calls.dispatch.length, 2);
        assert.equal(state.calls.launch.length, 0);
        assert.equal(state.calls.release[0].at, 30000);
    } finally { state.stop(); }
});

test("an in-flight readiness check at the deadline proceeds when it completes instead of waiting another interval", async context => {
    let checks = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ cooldown: 30000, onSummary: () => ++checks === 2 ? gate : undefined });
    try {
        await state.settle(); await state.advance(29000); await state.tick();
        await state.advance(1125); release(); await state.settle();
        assert.equal(state.calls.reserve[0].at, 30125);
        context.diagnostic(JSON.stringify({ layer: "actual-coordinator/fake-clock/busy-preflight", cooldownDeadlineMs: 30000, readinessCompletedMs: 30125, attemptedDialMs: state.calls.dispatch[0].at, schedulingJitterMs: 125, realCalls: 0 }));
    } finally { release(); state.stop(); }
});

test("attendance holds stop an already-approved dial in every business without ending a call", async () => {
    for (let index = 0; index < 6; index++) for (const pause of ["pending", "OFF THE PHONE", "BREAK", "LUNCH", "OFFLINE"]) {
        const state = fixture({ business: `hold-${index}`, onDispatch: ({ setAvailability, setAttendanceSaving }) =>
            pause === "pending" ? setAttendanceSaving(true) : setAvailability(pause) });
        try {
            await state.settle();
            assert.equal(state.calls.launch.length, 0, `${pause} must stop the browser before opening TEL`);
            assert.equal(state.calls.release.length, 1);
        } finally { state.stop(); }
    }
});

test("off-phone during cooldown prevents the next dial and returning online preserves the deadline", async () => {
    const state = fixture({ availability: "OFF THE PHONE", cooldown: 30000 });
    try {
        await state.settle(); await state.advance(20000); await state.tick(); assert.equal(state.calls.reserve.length, 0);
        state.availability("ONLINE"); await state.tick(); await state.advance(9999); assert.equal(state.calls.launch.length, 0);
        await state.advance(1); assert.equal(state.calls.launchAt[0], 30000);
    } finally { state.stop(); }
});

test("expected timing and queue conflicts do not accumulate exponential 10/20/30-second delays", async () => {
    const state = fixture({ queueConflicts: 3 });
    try {
        await state.settle();
        for (let retry = 0; retry < 3; retry++) await state.advance(5000);
        assert.deepEqual(state.calls.reserve.map(row => row.at), [0, 5000, 10000, 15000]);
        assert.equal(state.calls.launch.length, 1);
    } finally { state.stop(); }
});
