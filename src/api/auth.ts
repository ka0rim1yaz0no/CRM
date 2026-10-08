import { api } from "../lib/api";
import type { AuthBusiness, AuthUser } from "./authStorage";

export async function loginWithEmployeeCode(employeeCode: string, businessId?: string) {
    const response = await api.post<AuthUser>(
        "/auth/login",
        { employeeCode },
        businessId ? { headers: { "X-Business-Id": businessId } } : undefined
    );
    return response.data;
}

export async function logoutEmployee(employeeId: string) {
    const response = await api.post<{ success: boolean }>("/auth/logout", { employeeId });
    return response.data;
}

export async function getEmployeeBusinesses(employeeCode: string) {
    const response = await api.get<AuthBusiness[]>("/auth/businesses", {
        params: { employeeCode },
    });
    return response.data;
}

export async function switchEmployeeBusiness(employeeCode: string, currentBusinessId: string, targetBusinessId: string) {
    const response = await api.post<AuthUser>(
        "/auth/switch-business",
        { employeeCode, currentBusinessId, targetBusinessId },
        { headers: { "X-Business-Id": targetBusinessId } }
    );
    return response.data;
}
