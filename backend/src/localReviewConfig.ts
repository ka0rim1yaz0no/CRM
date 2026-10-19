export const reviewCollections = [
  "employees", "attendances", "attendanceledgers", "attendancepolicies", "attendancedaynotes",
  "systemsettings", "featureflags", "roles", "teams", "branches", "tools", "productcategories",
  "leads", "leadcallstats", "leaverequests", "notices", "payrollrecords", "payrolllistitems",
  "tasks", "employeeevaluations", "dashboardworkspaces", "dashboardhandovers", "employeetransactions",
  "knowledgebaseentries", "knowledgebasesuggestions",
] as const;
export const reviewControlCollections = ["businessprofiles", "businessuseraccesses"] as const;

export function localReviewRestoreUri(uri: string) {
  const parsed = new URL(uri);
  if (parsed.protocol !== "mongodb:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "27119" || parsed.username || parsed.password) {
    throw new Error("Dedicated review database port is unavailable.");
  }
  parsed.pathname = "/";
  return parsed.toString();
}

export function localReviewBusinesses(profiles: Array<{ businessId?: string; name?: string; databaseName?: string }>, databases: string[]) {
  return profiles.map((profile) => {
    const id = String(profile.businessId || "");
    const suffix = /^business-([a-z]+)$/.exec(id)?.[1];
    const databaseName = profile.databaseName || (suffix === "a" ? "crm" : suffix ? `crm_${suffix}` : "");
    if (!id || !/^crm(?:_[a-z]+)?$/.test(databaseName) || !databases.includes(databaseName)) {
      throw new Error("A local business has no verified CRM database mapping. No source data was changed.");
    }
    return { id, name: profile.name || id, databaseName };
  });
}

export function isReviewBlockedPath(pathname: string, isolatedUploads = false) {
  return /^\/api\/(?:integrations|call-bridge|browser-activity)(?:\/|$)/.test(pathname) ||
    (!isolatedUploads && /^\/(?:uploads|api\/media)(?:\/|$)/.test(pathname));
}
