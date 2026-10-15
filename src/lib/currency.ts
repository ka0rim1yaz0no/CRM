import type { CurrencyCode } from "../api/systemSettings";

export function formatCurrency(value = 0, currencyCode: CurrencyCode = "PHP") {
    return value.toLocaleString("en-US", { style: "currency", currency: currencyCode });
}
