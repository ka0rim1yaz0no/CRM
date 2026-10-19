import type { Employee } from "./employees";

export type AuthBusiness = {
    id: string;
    name: string;
};

export type AuthUser =
    | { userType: "admin"; user: { id: string; name: string; role: string; employeeCode: string }; access?: "full" | "tracker"; sessionToken?: string | null; business?: AuthBusiness; allowedBusinesses?: AuthBusiness[] }
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

export function clearAuthUser() {
    localStorage.removeItem("authUser");
    window.dispatchEvent(new Event("crm:auth-changed"));
}
