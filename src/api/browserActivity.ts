import { api } from "../lib/api";
import { backendOrigin } from "../lib/backendUrl";

export type BrowserActivityClassification = "work" | "non-work" | "unknown";

export type BrowserActivityEventType =
    | "site_visit"
    | "tab_created"
    | "tab_updated"
    | "tab_activated"
    | "tab_closed"
    | "window_focus"
    | "idle_state"
    | "link_clicked"
    | "form_submitted"
    | "copy"
    | "paste"
    | "keyboard_activity"
    | "mouse_activity"
    | "scroll"
    | "screenshot_captured"
    | "manual_sync";

export type BrowserActivityEvent = {
    _id: string;
    employee: string;
    employeeName: string;
    eventType: BrowserActivityEventType;
    url: string;
    normalizedUrl: string;
    title: string;
    domain: string;
    classification: BrowserActivityClassification;
    category: string;
    tabId: number | null;
    windowId: number | null;
    source: "extension";
    occurredAt: string;
    metadata: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
};

export type BrowserActivityScreenshot = {
    _id: string;
    employee: string;
    employeeName: string;
    url: string;
    normalizedUrl: string;
    title: string;
    domain: string;
    classification: BrowserActivityClassification;
    category: string;
    fileUrl: string;
    mimeType: string;
    width: number;
    height: number;
    capturedAt: string;
    metadata: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
};

export type BrowserActivityQuery = {
    employeeId?: string;
    classification?: BrowserActivityClassification;
    category?: string;
    start?: string;
    end?: string;
    limit?: number;
};

export type BrowserActivityClearResult = {
    eventsBefore: number;
    screenshotsBefore: number;
    eventsDeleted: number;
    screenshotsDeleted: number;
    screenshotFoldersDeleted: number;
};

export async function getBrowserActivityEvents(params: BrowserActivityQuery = {}) {
    const response = await api.get<BrowserActivityEvent[]>("/browser-activity/events", { params });
    return response.data;
}

export async function getBrowserActivityScreenshots(params: BrowserActivityQuery = {}) {
    const response = await api.get<BrowserActivityScreenshot[]>("/browser-activity/screenshots", { params });
    return response.data;
}

export async function clearBrowserActivityData() {
    const response = await api.delete<BrowserActivityClearResult>("/browser-activity");
    return response.data;
}

export const browserActivityExtensionPackageUrl = `${backendOrigin}/api/browser-activity/extension-package`;
export const liveViewAgentPackageUrl = `${backendOrigin}/api/browser-activity/live-view-agent-package`;
export const browserActivityWebStoreUrl = import.meta.env.VITE_CRM_EXTENSION_WEB_STORE_URL as string | undefined;
