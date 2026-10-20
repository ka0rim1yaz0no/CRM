import type { Employee } from "./employees";
import { backendOrigin } from "../lib/backendUrl";

export type AuthBusiness = {
    id: string;
    name: string;
};

export type AuthUser =
    | { userType: "admin"; user: { id: string; name: string; role: string; employeeCode: string }; access?: "full" | "tracker"; sessionToken?: string | null; attendanceHubSession?: string | null; business?: AuthBusiness; allowedBusinesses?: AuthBusiness[] }
    | { userType: "employee"; user: Employee; attendanceHubSession?: string | null; business?: AuthBusiness; allowedBusinesses?: AuthBusiness[] };

export function getAuthUser() {
    const rawUser = localStorage.getItem("authUser");

    if (!rawUser) {
        return null;
    }

    try {
        return JSON.parse(rawUser) as AuthUser;
    } catch {
        localStorage.removeItem("authUser");
        return null;
    }
}

export function setAuthUser(user: AuthUser) {
    if (user.userType === "employee") {
        const safeEmployee = { ...user.user };
        delete safeEmployee.profileImage;
        localStorage.setItem("authUser", JSON.stringify({ ...user, user: safeEmployee }));
        window.dispatchEvent(new Event("crm:auth-changed"));
        return;
    }

    localStorage.setItem("authUser", JSON.stringify(user));
    window.dispatchEvent(new Event("crm:auth-changed"));
}

let pendingFileLogout: Promise<unknown> = Promise.resolve();
let fileLogoutInFlight = false;
export function waitForFileLogout() { return pendingFileLogout; }

export function clearAuthUser() {
    if (typeof window.fetch === "function" && !fileLogoutInFlight) {
        const base = import.meta.env?.VITE_API_URL || `${backendOrigin}/api`;
        const controller = new AbortController();
        fileLogoutInFlight = true;
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<void>(resolve => {
            timer = setTimeout(() => { controller.abort(); resolve(); }, 5000);
        });
        // Cancel a stalled request before allowing the next login to replace its cookie.
        pendingFileLogout = Promise.race([
            Promise.resolve().then(() => window.fetch(`${base}/auth/file-session/logout`, { method: "POST", credentials: "include", keepalive: true, signal: controller.signal })).catch(() => undefined),
            deadline,
        ]).finally(() => { clearTimeout(timer); fileLogoutInFlight = false; });
    }
    localStorage.removeItem("authUser");
    window.dispatchEvent(new Event("crm:auth-changed"));
}
