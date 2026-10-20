import { getActiveBusinessId } from "../api/businessStorage";
import { backendOrigin } from "./backendUrl";

export function fileBusinessUrl(value: string) {
    if (!value || /^(data:|blob:)/i.test(value)) return value;
    try {
        const url = new URL(value, backendOrigin);
        if (url.origin !== new URL(backendOrigin).origin || !/^\/(api\/.*\/file\/|uploads\/)/.test(url.pathname)) return value;
        const legacy = [["/uploads/knowledge-base/documents/", "/api/knowledge-base/documents/file/"], ["/uploads/knowledge-base/", "/api/knowledge-base/photos/file/"], ["/uploads/media/", "/api/media/file/"], ["/uploads/browser-screenshots/", "/api/browser-activity/screenshots/file/"]];
        for (const [prefix, destination] of legacy) if (url.pathname.startsWith(prefix)) { url.pathname = destination + url.pathname.slice(prefix.length); break; }
        const businessId = getActiveBusinessId();
        if (businessId) url.searchParams.set("businessId", businessId);
        return url.href;
    } catch { return value; }
}
