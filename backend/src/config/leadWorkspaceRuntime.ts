import fs from "node:fs/promises";

export async function applyLeadWorkspaceSwitch(startWorkers: () => void) {
    const file = process.env.CRM_LEAD_WORKSPACE_SWITCH_FILE;
    if (!file) return null;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("LEAD_WORKSPACE_SWITCH_NOT_PRIVATE");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value.version !== 1 || typeof value.enabled !== "boolean" || !process.env.CRM_RELEASE_ID ||
        value.release !== process.env.CRM_RELEASE_ID || (value.workers !== undefined && typeof value.workers !== "boolean")) throw new Error("LEAD_WORKSPACE_SWITCH_INVALID");
    if (value.enabled && value.workers !== false) startWorkers();
    process.env.CRM_LEAD_PHONE_DEDUP_V2 = String(value.enabled);
    return { enabled: value.enabled };
}
