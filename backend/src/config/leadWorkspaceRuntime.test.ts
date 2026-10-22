import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyLeadWorkspaceSwitch } from "./leadWorkspaceRuntime";

test("private release-bound switch does not activate workers or flags on invalid input", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-lead-switch-"));
    const original = { file: process.env.CRM_LEAD_WORKSPACE_SWITCH_FILE, release: process.env.CRM_RELEASE_ID, flag: process.env.CRM_LEAD_PHONE_DEDUP_V2 };
    let starts = 0;
    try {
        process.env.CRM_RELEASE_ID = "synthetic-release";
        process.env.CRM_LEAD_WORKSPACE_SWITCH_FILE = path.join(directory, "switch.json");
        process.env.CRM_LEAD_PHONE_DEDUP_V2 = "false";
        const write = (value: unknown) => fs.writeFile(process.env.CRM_LEAD_WORKSPACE_SWITCH_FILE!, JSON.stringify(value), { mode: 0o600 });
        await write({ version: 1, release: "wrong-release", enabled: true });
        await assert.rejects(applyLeadWorkspaceSwitch(() => starts++));
        assert.equal(starts, 0); assert.equal(process.env.CRM_LEAD_PHONE_DEDUP_V2, "false");
        await write({ version: 1, release: "synthetic-release", enabled: false });
        assert.deepEqual(await applyLeadWorkspaceSwitch(() => starts++), { enabled: false }); assert.equal(starts, 0);
        await write({ version: 1, release: "synthetic-release", enabled: true, workers: false });
        assert.deepEqual(await applyLeadWorkspaceSwitch(() => starts++), { enabled: true }); assert.equal(starts, 0);
        await write({ version: 1, release: "synthetic-release", enabled: true });
        assert.deepEqual(await applyLeadWorkspaceSwitch(() => starts++), { enabled: true }); assert.equal(starts, 1);
        assert.equal(process.env.CRM_LEAD_PHONE_DEDUP_V2, "true");
        if (process.platform !== "win32") {
            await fs.chmod(process.env.CRM_LEAD_WORKSPACE_SWITCH_FILE!, 0o644);
            await assert.rejects(applyLeadWorkspaceSwitch(() => starts++)); assert.equal(starts, 1);
        }
    } finally {
        for (const [key, value] of Object.entries({ CRM_LEAD_WORKSPACE_SWITCH_FILE: original.file, CRM_RELEASE_ID: original.release, CRM_LEAD_PHONE_DEDUP_V2: original.flag })) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await fs.rm(directory, { recursive: true, force: true });
    }
});
