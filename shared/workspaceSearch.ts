// Only a completed search for the current input may select a result.
export function canSelectSearchResult(input: string, resolvedInput: string, fetching: boolean) {
  return input.trim().length >= 2 && input.trim() === resolvedInput.trim() && !fetching;
}
