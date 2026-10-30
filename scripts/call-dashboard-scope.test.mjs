import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import ts from "typescript";
const source = readFileSync(new URL("../src/api/callDashboard.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("dashboard.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "getCallDashboard");
function fixture(returnedBusiness) {
    const calls = [], exports = {};
    const code = ts.transpileModule(declaration.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
    runInNewContext(code, {exports, getAuthUser: () => ({userType: "admin", sessionToken: "synthetic-session"}), api: {
        get: async (url, options) => {calls.push({url, options}); return {data: {business: {id: returnedBusiness}, employees: []}};},
    }});
    return {calls, get: exports.getCallDashboard};
}
test("dashboard requests capture the intended business instead of following a later global switch", async () => {
    for (let index = 0; index < 6; index++) {
        const business = `scope-${index}`, state = fixture(business);
        await state.get(business);
        assert.equal(state.calls[0].options.headers["X-Business-Id"], business);
        assert.equal(state.calls[0].options.headers["X-CRM-Admin-Session"], "synthetic-session");
        assert.equal(state.calls[0].options.timeout, 10000);
    }
});
test("a response from another business is never installed as the selected business snapshot", async () => {
    const state = fixture("another-business");
    await assert.rejects(state.get("selected-business"), /business changed/i);
});
