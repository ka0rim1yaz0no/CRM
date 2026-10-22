import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/pages/leads/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("leads.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
let draftReset;
function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "fetchMoreLeads") callback = node.initializer.arguments[0];
    if (ts.isIfStatement(node) && node.expression.getText(ast).startsWith("previousLeadDetailDraft === null")) draftReset = node;
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
assert.ok(draftReset);
const compiled = ts.transpileModule(`exports.load = ${ts.createPrinter().printNode(ts.EmitHint.Expression, callback, ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test("initial loading with no selected lead or retained draft does not crash draft restoration", () => {
    const reset = ts.transpileModule(ts.createPrinter().printNode(ts.EmitHint.Unspecified, draftReset, ast), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    for (const [selectedLead, retained, expected] of [
        [undefined, null, ""],
        [{ _id: "same" }, { lead: { _id: "same" }, body: "retained draft" }, "retained draft"],
        [{ _id: "other" }, { lead: { _id: "same" }, body: "retained draft" }, ""],
    ]) {
        let body;
        runInNewContext(reset, { previousLeadDetailDraft: null, leadDetailDraftInputs: [selectedLead?._id], selectedLead,
            setPreviousLeadDetailDraft() {}, setDetailDraft() {}, createLeadDetailDraft: () => ({}), setIsDetailEditing() {},
            getLeadNoteDraft: () => retained, callingScope: {}, setCommentDraft: value => { body = value; }, setPassAgentId() {}, setPassConfirm() {},
        });
        assert.equal(body, expected);
    }
});

function fixture(options = {}) {
    const key = ["leads", "fake-person", "fake-names", "my", "NEW", "synthetic search", false, "CA", "fake-a"];
    let cache = { page: options.page || 1, nextPage: (options.page || 1) + 1, hasMore: true, leads: [{ _id: "first" }] };
    let business = "fake-a", now = 1000;
    const requests = [], loading = [], notices = [], commits = [];
    const refs = { scope: { current: JSON.stringify(key) }, fetching: { current: false }, retry: { current: 0 }, page: { current: 99 } };
    const exports = {};
    runInNewContext(compiled, { exports, Date: { now: () => now }, employeeId: "fake-person", displayedBusinessId: "fake-a",
        leadPagingScope: JSON.stringify(key), leadPagingScopeRef: refs.scope, leadFetchInFlightRef: refs.fetching,
        leadFetchRetryAtRef: refs.retry, leadPageRef: refs.page, hasMoreLeads: true,
        getActiveBusinessId: () => business, employeeLeadNames: ["fake-name"], requestedEmployeeLeadTab: "my",
        effectiveLeadSearch: "synthetic search", isGlobalLeadSearchActive: false, leadStateFilter: "CA", leadQueryKey: key,
        LEAD_PAGE_SIZE: 50, AUTO_CALL_API_TIMEOUT_MS: 10000, isDefaultCallingView: false, performance: { now: () => now },
        queryClient: { getQueryData: () => cache, setQueryData: (_key, update) => { cache = update(cache); commits.push(cache); } },
        getMyLeads: async (params, requestOptions) => {
            requests.push(JSON.parse(JSON.stringify({ params, requestOptions })));
            await options.gate;
            if (options.fail) throw new Error("synthetic network failure");
            return { page: params.page, nextPage: null, hasMore: false, leads: [{ _id: "next" }] };
        },
        mergeLeadPages: (left, right) => [...left, ...right], setLeadPage() {}, setHasMoreLeads() {},
        setIsFetchingMoreLeads: value => loading.push(value), showToast: value => notices.push(value),
    });
    return { load: exports.load, refs, requests, loading, notices, commits, cache: () => cache,
        replaceCache: value => { cache = value; }, switchBusiness: () => { business = "fake-b"; }, advance: ms => { now += ms; } };
}

test("paging follows the cache's next page, preserves filters and uses a bounded request timeout", async () => {
    const state = fixture({ page: 1 });
    assert.equal(await state.load(), true);
    assert.equal(state.requests[0].params.page, 2, "a stale page ref must not skip page two after refetch");
    assert.equal(state.requests[0].params.search, "synthetic search");
    assert.equal(state.requests[0].params.state, "CA");
    assert.equal(state.requests[0].params.tab, "my");
    assert.equal(state.requests[0].requestOptions.timeoutMs, 10000);
    assert.deepEqual(state.cache().leads.map(row => row._id), ["first", "next"]);
    assert.deepEqual(state.loading, [true, false]);
});

test("business, query or unmount changes discard an old page without clearing a newer request", async () => {
    for (const change of [state => state.switchBusiness(), state => { state.refs.scope.current = "other-query"; }, state => { state.refs.scope.current = null; }]) {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const state = fixture({ gate });
        const pending = state.load();
        change(state);
        release();
        assert.equal(await pending, false);
        assert.equal(state.commits.length, 0);
        assert.equal(state.refs.fetching.current, true, "an old finally must not unlock another view's fetch");
        assert.deepEqual(state.loading, [true]);
        assert.equal(state.notices.length, 0);
    }
});

test("a background refetch cannot append page three after replacing page two with page one", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ page: 2, gate });
    const pending = state.load();
    state.replaceCache({ page: 1, nextPage: 2, hasMore: true, leads: [{ _id: "refetched" }] });
    release();
    assert.equal(await pending, false);
    assert.equal(state.commits.length, 0);
    assert.equal(state.refs.fetching.current, false);
    assert.equal(await state.load(), true);
    assert.deepEqual(state.requests.map(row => row.params.page), [3, 2]);
});

test("end-of-list, missing cache and duplicate in-flight page requests do not fetch", async () => {
    for (const cache of [undefined, { page: 1, nextPage: null, hasMore: false, leads: [] }]) {
        const state = fixture();
        state.replaceCache(cache);
        assert.equal(await state.load(), false);
        assert.equal(state.requests.length, 0);
    }
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ gate });
    const pending = state.load();
    assert.equal(await state.load(), false);
    release();
    assert.equal(await pending, true);
    assert.equal(state.requests.length, 1);
});

test("failed page loads retain previous rows and back off instead of spinning", async () => {
    const state = fixture({ fail: true });
    assert.equal(await state.load(), false);
    assert.equal(await state.load(), false);
    assert.equal(state.requests.length, 1);
    assert.equal(state.commits.length, 0);
    assert.equal(state.notices.length, 1);
    assert.equal(state.refs.fetching.current, false);
    state.advance(5000);
    assert.equal(await state.load(), false);
    assert.equal(state.requests.length, 2);
});
