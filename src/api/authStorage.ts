import type { Employee } from "./employees";

export type AuthBusiness = {
    id: string;
    name: string;
};

export type AuthUser =
    | { userType: "admin"; user: { id: string; name: string; role: string; employeeCode: string }; access?: "full" | "tracker"; sessionToken?: string | null; business?: AuthBusiness; allowedBusinesses?: AuthBusiness[] }
    | { userType: "employee"; user: Employee; business?: AuthBusiness; allowedBusinesses?: AuthBusiness[] };

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
        const { profileImage, ...safeEmployee } = user.user;
        localStorage.setItem("authUser", JSON.stringify({ ...user, user: safeEmployee }));
        return;
    }

    localStorage.setItem("authUser", JSON.stringify(user));
}

export function clearAuthUser() {
    localStorage.removeItem("authUser");
}
