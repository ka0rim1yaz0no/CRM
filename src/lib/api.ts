import axios from "axios";
import { backendOrigin } from "./backendUrl";
import { emitToast } from "./toast";
import { getActiveBusinessId } from "../api/businessStorage";
import { getAuthUser, clearAuthUser } from "../api/authStorage";
import { shouldExpireCrmSession } from "./sessionAuthorization";

export const api = axios.create({
    baseURL: import.meta.env.VITE_API_URL || `${backendOrigin}/api`,
    withCredentials: true,
});

const writeMethods = new Set(["post", "put", "patch", "delete"]);
const quietRequestPaths = ["/auth/", "/activity", "/browser-activity", "/call-bridge/activate", "/call-bridge/reserve", "/call-bridge/dial-start", "/call-bridge/release"];

api.interceptors.request.use((config) => {
    const businessId = getActiveBusinessId();
    const authUser = getAuthUser();

    if (businessId && !config.headers["X-Business-Id"]) {
        config.headers["X-Business-Id"] = businessId;
    }

    if (authUser) {
        if (authUser.userType === "admin" && authUser.sessionToken && !config.headers["X-CRM-Admin-Session"]) config.headers["X-CRM-Admin-Session"] = authUser.sessionToken;
        if (authUser.attendanceHubSession && !config.headers["X-CRM-Attendance-Session"]) config.headers["X-CRM-Attendance-Session"] = authUser.attendanceHubSession;
        config.headers["X-CRM-User-Code"] = authUser.user.employeeCode;
        config.headers["X-CRM-User-Name"] = authUser.user.name;
        config.headers["X-CRM-User-Type"] = authUser.userType;
    }

    return config;
});

function shouldToastForRequest(method?: string, url = "") {
    const normalizedMethod = method?.toLowerCase() || "";
    return writeMethods.has(normalizedMethod) && !quietRequestPaths.some((path) => url.includes(path));
}

api.interceptors.response.use(
    (response) => {
        return response;
    },
    (error) => {
        if (shouldExpireCrmSession(error, getAuthUser())) {
            clearAuthUser();
            emitToast({ tone: "error", message: "Your session has expired. Sign in again to continue." });
            return Promise.reject(error);
        }
        const method = error?.config?.method;
        const url = error?.config?.url || "";

        if (shouldToastForRequest(method, url)) {
            emitToast({
                tone: "error",
                message: error?.response?.data?.message || "Unable to save changes.",
            });
        }

        return Promise.reject(error);
    }
);
