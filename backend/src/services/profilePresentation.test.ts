import assert from "node:assert/strict";
import test from "node:test";
import { maskBankNumber, profileCompleteness, profileDayKey, profileActivityDay, tenureLabel, blendColor, colorContrast } from "../../../src/lib/profilePresentation";
import { themeOptions } from "../../../src/lib/themes";
test("profile masks only the display value, including short/empty input", () => {
  const number = "000000001234"; assert.equal(maskBankNumber(number), "******** 1234"); assert.equal(number, "000000001234");
  assert.equal(maskBankNumber("123"), "***"); assert.equal(maskBankNumber(""), "");
});
test("profile completeness only counts filled existing fields", () => {
  assert.equal(profileCompleteness({}).percent, 0); assert.equal(profileCompleteness({ bankName: " ", personalEmail: "fake@example.invalid" }).filled, 1);
  assert.equal(profileCompleteness({ bankName: "Synthetic", bankAccountName: "Sample", bankAccountNumber: "000000001234" }).percent, 30);
});
test("profile tenure handles anniversaries, future dates and malformed dates", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  assert.equal(tenureLabel("2024-07-19", now), "2 yrs 3 mos"); assert.equal(tenureLabel("2024-07-20", now), "2 yrs 2 mos");
  assert.equal(tenureLabel("2027-01-01", now), ""); assert.equal(tenureLabel("2026-02-30", now), ""); assert.equal(tenureLabel(undefined, now), "");
});
test("activity grouping uses Manila midnight, not the browser timezone", () => {
  const now = new Date("2026-10-19T16:01:00Z");
  assert.equal(profileDayKey(now), "2026-10-20"); assert.equal(profileActivityDay("2026-10-19T16:00:00Z", now), "Today");
  assert.equal(profileActivityDay("2026-10-19T15:59:00Z", now), "Yesterday"); assert.equal(profileActivityDay("bad", now), "Date unavailable");
});
test("all 16 theme tokens meet upgraded profile text and input-boundary contrast", (context) => {
  const rows = themeOptions.map((theme) => {
    const light = theme.key.startsWith("light-") || theme.key.startsWith("mail-");
    const background = blendColor(theme.colors.surface, theme.colors.app, .88);
    const beforeLabel = light ? blendColor("#17202a", background, .62) : blendColor("#ffffff", background, .35);
    const beforeBody = light ? "#17202a" : blendColor("#ffffff", background, .75);
    const beforeChipBg = blendColor("#ffffff", background, .06);
    const beforeChip = light ? "#17202a" : blendColor("#ffffff", beforeChipBg, .65);
    const beforeDisabledBg = blendColor("#ffffff", background, .025);
    const beforeDisabled = light ? "#17202a" : blendColor("#ffffff", beforeDisabledBg, .55);
    const text = light ? "#17202a" : "#e8edf5"; const muted = light ? "#475569" : "#b8c4d9"; const border = light ? "#748094" : "#74839c";
    for (const bg of [theme.colors.surface, theme.colors.panel]) { assert.ok(colorContrast(text, bg) >= 4.5, theme.key); assert.ok(colorContrast(muted, bg) >= 4.5, theme.key); assert.ok(colorContrast(border, bg) >= 3, theme.key); }
    return { theme: theme.key, before: { label: +colorContrast(beforeLabel, background).toFixed(2), body: +colorContrast(beforeBody, background).toFixed(2), chip: +colorContrast(beforeChip, beforeChipBg).toFixed(2), disabled: +colorContrast(beforeDisabled, beforeDisabledBg).toFixed(2) }, afterMuted: +colorContrast(muted, theme.colors.surface).toFixed(2) };
  });
  assert.equal(rows.length, 16); context.diagnostic(JSON.stringify(rows));
});
