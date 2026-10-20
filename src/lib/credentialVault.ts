export type CredentialStatus = "Active" | "Review" | "Archived";

export type Credential = {
    _id: string;
    accountName: string;
    username: string;
    hasPassword: boolean;
    passwordMode: "vault" | "legacy";
    platform: string;
    company: string;
    team: string;
    status: CredentialStatus;
    createdAt?: string;
    updatedAt?: string;
};

export type CredentialInput = {
    accountName: string;
    username: string;
    password: string;
    platform: string;
    company: string;
    team: string;
    status?: CredentialStatus;
};

type CredentialRequest = {
    method: "get" | "post" | "put" | "patch";
    url: string;
    data?: unknown;
    signal?: AbortSignal;
    headers: Record<string, string>;
    validateStatus: (status: number) => boolean;
};

type CredentialTransport = {
    request: (request: CredentialRequest) => Promise<{ data: unknown; status: number }>;
};

export function credentialErrorMessage(status?: number) {
    if (status === 401) return "Your session has expired. Sign in again.";
    if (status === 403) return "Only a full-access administrator can access credentials.";
    if (status === 404) return "This credential is no longer available.";
    if (status === 409) return "That platform and username already exist.";
    if (status === 400) return "Check the credential details and try again.";
    return "Unable to complete the credential request. Please try again.";
}

export class CredentialRequestError extends Error {
    constructor(status?: number) {
        super(credentialErrorMessage(status));
        this.name = "CredentialRequestError";
    }
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value : "";
}

// Whitelist metadata even when an older server still includes plaintext fields.
export function credentialMetadata(value: unknown): Credential {
    const source = record(value);
    const isVault = typeof source.hasPassword === "boolean";
    return {
        _id: text(source._id),
        accountName: text(source.accountName),
        username: text(source.username),
        hasPassword: isVault ? source.hasPassword as boolean : Boolean(text(source.password)),
        passwordMode: isVault ? "vault" : "legacy",
        platform: text(source.platform),
        company: text(source.company),
        team: text(source.team),
        status: source.status === "Review" || source.status === "Archived" ? source.status : "Active",
        createdAt: text(source.createdAt) || undefined,
        updatedAt: text(source.updatedAt) || undefined,
    };
}

export function credentialWriteInput(input: CredentialInput, editing: boolean) {
    const data = { ...input } as Partial<CredentialInput>;
    if (editing && !input.password.trim()) delete data.password;
    return data;
}

export function createCredentialRequests(transport: CredentialTransport) {
    async function request(method: CredentialRequest["method"], url: string, data?: unknown, signal?: AbortSignal) {
        try {
            const response = await transport.request({
                method, url, data, signal,
                headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
                // Handle status errors here so shared toasts never display an echoed secret.
                validateStatus: () => true,
            });
            if (response.status < 200 || response.status >= 300) throw new CredentialRequestError(response.status);
            return response.data;
        } catch (error) {
            if (error instanceof CredentialRequestError) throw error;
            // Do not retain Axios config/response objects containing passwords.
            throw new CredentialRequestError();
        }
    }

    return {
        async getCredentials(signal?: AbortSignal) {
            const data = await request("get", "/credentials", undefined, signal);
            return Array.isArray(data) ? data.map(credentialMetadata) : [];
        },
        async createCredential(input: CredentialInput) {
            if (!input.password.trim()) throw new CredentialRequestError(400);
            return credentialMetadata(await request("post", "/credentials", credentialWriteInput(input, false)));
        },
        async updateCredential(id: string, input: CredentialInput) {
            return credentialMetadata(await request("put", `/credentials/${encodeURIComponent(id)}`, credentialWriteInput(input, true)));
        },
        async archiveCredential(id: string) {
            return credentialMetadata(await request("patch", `/credentials/${encodeURIComponent(id)}/archive`));
        },
        async revealCredential(credential: Pick<Credential, "_id" | "passwordMode">, signal?: AbortSignal) {
            // Legacy compatibility is fetched only by an explicit Show, never retained in list cache.
            const data = credential.passwordMode === "legacy"
                ? await request("get", "/credentials", undefined, signal)
                : await request("post", `/credentials/${encodeURIComponent(credential._id)}/reveal`, undefined, signal);
            const source = credential.passwordMode === "legacy"
                ? record(Array.isArray(data) ? data.find((entry) => record(entry)._id === credential._id) : undefined)
                : record(data);
            if (typeof source.password !== "string") throw new CredentialRequestError(404);
            return source.password;
        },
    };
}

export type CredentialRevealSnapshot = {
    id: string | null;
    password: string | null;
    loading: boolean;
    error: string | null;
};

export function createCredentialRevealState(
    fetchPassword: (credential: Credential, signal: AbortSignal) => Promise<string>,
    isCurrentContext: () => boolean = () => true,
) {
    let state: CredentialRevealSnapshot = { id: null, password: null, loading: false, error: null };
    let generation = 0;
    let request: AbortController | null = null;
    const listeners = new Set<() => void>();
    function publish(next: CredentialRevealSnapshot) {
        state = next;
        listeners.forEach((listener) => listener());
    }
    function clear() {
        generation += 1;
        request?.abort();
        request = null;
        publish({ id: null, password: null, loading: false, error: null });
    }
    return {
        getSnapshot: () => state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        clear,
        async show(credential: Credential) {
            clear();
            if (!credential.hasPassword || !isCurrentContext()) return;
            const currentGeneration = generation;
            const controller = new AbortController();
            request = controller;
            publish({ id: credential._id, password: null, loading: true, error: null });
            try {
                const password = await fetchPassword(credential, controller.signal);
                if (currentGeneration !== generation || controller.signal.aborted || !isCurrentContext()) return;
                publish({ id: credential._id, password, loading: false, error: null });
            } catch (error) {
                if (currentGeneration !== generation || controller.signal.aborted || !isCurrentContext()) return;
                publish({ id: credential._id, password: null, loading: false,
                    error: error instanceof CredentialRequestError ? error.message : credentialErrorMessage() });
            }
        },
        async copy(write: (password: string) => Promise<void>) {
            if (state.password === null || state.loading || !isCurrentContext()) return false;
            const currentGeneration = generation;
            try {
                await write(state.password);
                return true;
            } catch {
                if (currentGeneration === generation && isCurrentContext()) publish({ ...state, error: "Unable to copy password." });
                return false;
            }
        },
    };
}
