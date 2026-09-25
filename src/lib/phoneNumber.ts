import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhoneForCall(value?: string | null) {
    const phoneText = String(value || "").trim();

    if (!phoneText) {
        return null;
    }

    const phoneNumber = parsePhoneNumberFromString(phoneText, "US");
    return phoneNumber?.isValid() ? phoneNumber.number : null;
}
