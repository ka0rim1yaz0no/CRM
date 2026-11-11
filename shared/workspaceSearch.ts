// Only a completed search for the current input may select a result.
export function canSelectSearchResult(input: string, resolvedInput: string, fetching: boolean) {
  return input.trim().length >= 2 && input.trim() === resolvedInput.trim() && !fetching;
}

function formattedSearchKey(value: unknown) {
  const key = String(value ?? "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
  return /[\p{L}\p{N}]/u.test(key) ? key : "";
}

export function sameFormattedSearchValue(value: unknown, input: string) {
  const key = formattedSearchKey(input);
  return Boolean(key && formattedSearchKey(value) === key);
}

export function includesFormattedSearchValue(value: unknown, input: string) {
  const key = formattedSearchKey(input);
  return Boolean(key && formattedSearchKey(value).includes(key));
}

export function formattingInsensitiveNameRegex(input: string) {
  const key = formattedSearchKey(input);
  if (!key || key.length > 256) return null;
  const separator = "[^\\p{L}\\p{M}\\p{N}]*";
  const pattern = Array.from(key).join(separator);
  return new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{M}\\p{N}])`, "iu");
}
