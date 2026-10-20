import { api } from "../lib/api";
import { createCredentialRequests } from "../lib/credentialVault";

export type { Credential, CredentialInput, CredentialStatus } from "../lib/credentialVault";

// Use the central client so business and signed admin session headers remain covered.
const requests = createCredentialRequests(api);
export const getCredentials = requests.getCredentials;
export const createCredential = requests.createCredential;
export const updateCredential = requests.updateCredential;
export const archiveCredential = requests.archiveCredential;
export const revealCredential = requests.revealCredential;
