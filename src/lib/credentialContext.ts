let revision = 0;

export function getCredentialContextRevision() {
    return revision;
}

export function subscribeCredentialContext(listener: () => void) {
    const onChange = () => {
        revision += 1;
        listener();
    };
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === "authUser" || event.key === "activeBusinessId") onChange();
    };
    window.addEventListener("crm:auth-changed", onChange);
    window.addEventListener("crm:business-changed", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener("crm:auth-changed", onChange);
        window.removeEventListener("crm:business-changed", onChange);
        window.removeEventListener("storage", onStorage);
    };
}
