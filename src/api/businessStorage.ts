const activeBusinessStorageKey = "activeBusinessId";

export type BusinessOption = {
    id: string;
    name: string;
    isDefault?: boolean;
};

export function getActiveBusinessId() {
    return localStorage.getItem(activeBusinessStorageKey) || "";
}

export function setActiveBusinessId(businessId: string) {
    const normalizedBusinessId = businessId.trim();

    if (!normalizedBusinessId) {
        localStorage.removeItem(activeBusinessStorageKey);
        window.dispatchEvent(new Event("crm:business-changed"));
        return;
    }

    localStorage.setItem(activeBusinessStorageKey, normalizedBusinessId);
    window.dispatchEvent(new Event("crm:business-changed"));
}
