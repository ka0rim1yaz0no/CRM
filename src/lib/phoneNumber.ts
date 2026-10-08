import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhoneForCall(value?: string | null) {
    const phoneText = String(value || "").trim();

    if (!phoneText) {
        return null;
    }

    const phoneNumber = parsePhoneNumberFromString(phoneText, "US");
    return phoneNumber?.isValid() ? phoneNumber.number : null;
}

export function getRingCentralCallUrl(value?: string | null) {
    const phoneNumber = normalizePhoneForCall(value);

    if (!phoneNumber) {
        return undefined;
    }

    return `rcapp://r/call?number=${encodeURIComponent(phoneNumber.replace(/^\+/, ""))}`;
}

export function getPhoneCallUrl(value?: string | null) {
    const phoneNumber = normalizePhoneForCall(value);

    return phoneNumber ? `tel:${phoneNumber}` : undefined;
}
