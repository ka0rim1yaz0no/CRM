import type { Request, Response } from "express";
import { SystemSettings, type CurrencyCode, type PayrollBillingCycle, type ThemeKey } from "../models/SystemSettings";

export const currencies: CurrencyCode[] = ["USD", "PHP", "EUR", "GBP", "JPY"];
export const payrollBillingCycles: PayrollBillingCycle[] = ["Monthly", "Semi-monthly", "Weekly"];
export const themeKeys: ThemeKey[] = [
  "theme-1",
  "light-command",
  "flat-amethyst",
  "flat-turquoise",
  "flat-emerald",
  "flat-river",
  "flat-alizarin",
  "light-clouds",
  "light-silver",
  "light-turquoise",
  "light-river",
  "light-amethyst",
  "mail-purple",
  "mail-lavender",
  "mail-indigo",
  "mail-violet",
];

const defaultSystemSettings = {
  key: "system" as const,
  currencyCode: "PHP" as CurrencyCode,
  payrollBillingCycle: "Semi-monthly" as PayrollBillingCycle,
  payrollRunDay: 15,
  payrollFirstCutoffStartDay: 6,
  payrollFirstCutoffEndDay: 20,
  payrollFirstCutoffPayDay: 25,
  payrollSecondCutoffStartDay: 21,
  payrollSecondCutoffEndDay: 5,
  payrollSecondCutoffPayDay: 10,
  autoAssignLeadsEnabled: true,
  adminLeadMiniTabsEnabled: true,
  employeeLeadMiniTabsEnabled: true,
  trackerClearDataEnabled: true,
  officialShiftStartTime: "23:00",
  officialShiftEndTime: "08:00",
  officialFirstBreakStartTime: "01:00",
  officialFirstBreakEndTime: "01:15",
  officialLunchBreakStartTime: "03:15",
  officialLunchBreakEndTime: "04:15",
  officialSecondBreakStartTime: "06:15",
  officialSecondBreakEndTime: "06:30",
  attendanceTimeZone: "Asia/Manila",
  lateGraceMinutes: 0,
  themeKey: "theme-1" as ThemeKey,
};

function readTimeSetting(value: unknown, fallback: string) {
  return String(value || fallback).trim();
}

function isValidTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidTimeZone(value: string) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export async function getSystemSettings() {
  const settings = await SystemSettings.findOneAndUpdate(
    { key: "system" },
    { $setOnInsert: defaultSystemSettings },
    { returnDocument: "after", upsert: true, runValidators: true }
  );
  if (!settings) throw new Error("Unable to load system settings");

  let shouldSaveSettings = false;

  if (settings.payrollRunDay > 30) {
    settings.payrollRunDay = 30;
    shouldSaveSettings = true;
  }

  if (settings.payrollBillingCycle === "Monthly") {
    settings.payrollBillingCycle = defaultSystemSettings.payrollBillingCycle;
    shouldSaveSettings = true;
  }

  const missingPayrollCutoffRanges =
    !settings.payrollFirstCutoffStartDay ||
    !settings.payrollFirstCutoffEndDay ||
    !settings.payrollFirstCutoffPayDay ||
    !settings.payrollSecondCutoffStartDay ||
    !settings.payrollSecondCutoffEndDay ||
    !settings.payrollSecondCutoffPayDay;

  if (missingPayrollCutoffRanges) {
    settings.payrollFirstCutoffStartDay = defaultSystemSettings.payrollFirstCutoffStartDay;
    settings.payrollFirstCutoffEndDay = defaultSystemSettings.payrollFirstCutoffEndDay;
    settings.payrollFirstCutoffPayDay = defaultSystemSettings.payrollFirstCutoffPayDay;
    settings.payrollSecondCutoffStartDay = defaultSystemSettings.payrollSecondCutoffStartDay;
    settings.payrollSecondCutoffEndDay = defaultSystemSettings.payrollSecondCutoffEndDay;
    settings.payrollSecondCutoffPayDay = defaultSystemSettings.payrollSecondCutoffPayDay;
    return settings.save();
  }

  const hasReversedDefaultCutoffs =
    settings.payrollFirstCutoffStartDay === 21 &&
    settings.payrollFirstCutoffEndDay === 5 &&
    settings.payrollFirstCutoffPayDay === 25 &&
    settings.payrollSecondCutoffStartDay === 6 &&
    settings.payrollSecondCutoffEndDay === 20 &&
    settings.payrollSecondCutoffPayDay === 10;

  if (hasReversedDefaultCutoffs) {
    settings.payrollFirstCutoffStartDay = defaultSystemSettings.payrollFirstCutoffStartDay;
    settings.payrollFirstCutoffEndDay = defaultSystemSettings.payrollFirstCutoffEndDay;
    settings.payrollFirstCutoffPayDay = defaultSystemSettings.payrollFirstCutoffPayDay;
    settings.payrollSecondCutoffStartDay = defaultSystemSettings.payrollSecondCutoffStartDay;
    settings.payrollSecondCutoffEndDay = defaultSystemSettings.payrollSecondCutoffEndDay;
    settings.payrollSecondCutoffPayDay = defaultSystemSettings.payrollSecondCutoffPayDay;
    return settings.save();
  }

  const usesLegacyAttendanceDefaults =
    settings.attendanceTimeZone === "America/Chicago" &&
    settings.officialShiftStartTime === "09:00" &&
    settings.officialShiftEndTime === "18:00" &&
    settings.officialFirstBreakStartTime === "11:00" &&
    settings.officialFirstBreakEndTime === "11:15" &&
    settings.officialLunchBreakStartTime === "13:15" &&
    settings.officialLunchBreakEndTime === "14:15" &&
    settings.officialSecondBreakStartTime === "16:15" &&
    settings.officialSecondBreakEndTime === "16:30";

  if (!usesLegacyAttendanceDefaults) {
    return shouldSaveSettings ? settings.save() : settings;
  }

  settings.officialShiftStartTime = defaultSystemSettings.officialShiftStartTime;
  settings.officialShiftEndTime = defaultSystemSettings.officialShiftEndTime;
  settings.officialFirstBreakStartTime = defaultSystemSettings.officialFirstBreakStartTime;
  settings.officialFirstBreakEndTime = defaultSystemSettings.officialFirstBreakEndTime;
  settings.officialLunchBreakStartTime = defaultSystemSettings.officialLunchBreakStartTime;
  settings.officialLunchBreakEndTime = defaultSystemSettings.officialLunchBreakEndTime;
  settings.officialSecondBreakStartTime = defaultSystemSettings.officialSecondBreakStartTime;
  settings.officialSecondBreakEndTime = defaultSystemSettings.officialSecondBreakEndTime;
  settings.attendanceTimeZone = defaultSystemSettings.attendanceTimeZone;
  return settings.save();
}

export async function getCurrencyCode() {
  const settings = await getSystemSettings();
  return settings.currencyCode;
}

export async function isLeadAutoAssignmentEnabled() {
  const settings = await getSystemSettings();
  return settings.autoAssignLeadsEnabled !== false;
}

export async function readSystemSettings(_request: Request, response: Response) {
  response.json(await getSystemSettings());
}

export async function updateSystemSettings(request: Request, response: Response) {
  const existingSettings = await getSystemSettings();
  const currencyCode = String(request.body.currencyCode || existingSettings.currencyCode || "PHP").trim().toUpperCase();
  const requestedPayrollBillingCycle = String(request.body.payrollBillingCycle || existingSettings.payrollBillingCycle || "Semi-monthly").trim();
  const payrollBillingCycle = requestedPayrollBillingCycle === "Monthly" ? "Semi-monthly" : requestedPayrollBillingCycle;
  const payrollRunDay = Number(request.body.payrollRunDay ?? existingSettings.payrollRunDay ?? 15);
  const payrollFirstCutoffStartDay = Number(request.body.payrollFirstCutoffStartDay ?? existingSettings.payrollFirstCutoffStartDay ?? 6);
  const payrollFirstCutoffEndDay = Number(request.body.payrollFirstCutoffEndDay ?? existingSettings.payrollFirstCutoffEndDay ?? 20);
  const payrollFirstCutoffPayDay = Number(request.body.payrollFirstCutoffPayDay ?? existingSettings.payrollFirstCutoffPayDay ?? 25);
  const payrollSecondCutoffStartDay = Number(request.body.payrollSecondCutoffStartDay ?? existingSettings.payrollSecondCutoffStartDay ?? 21);
  const payrollSecondCutoffEndDay = Number(request.body.payrollSecondCutoffEndDay ?? existingSettings.payrollSecondCutoffEndDay ?? 5);
  const payrollSecondCutoffPayDay = Number(request.body.payrollSecondCutoffPayDay ?? existingSettings.payrollSecondCutoffPayDay ?? 10);
  const autoAssignLeadsEnabled =
    typeof request.body.autoAssignLeadsEnabled === "boolean" ? request.body.autoAssignLeadsEnabled : existingSettings.autoAssignLeadsEnabled !== false;
  const adminLeadMiniTabsEnabled =
    typeof request.body.adminLeadMiniTabsEnabled === "boolean" ? request.body.adminLeadMiniTabsEnabled : existingSettings.adminLeadMiniTabsEnabled !== false;
  const employeeLeadMiniTabsEnabled =
    typeof request.body.employeeLeadMiniTabsEnabled === "boolean" ? request.body.employeeLeadMiniTabsEnabled : existingSettings.employeeLeadMiniTabsEnabled !== false;
  const trackerClearDataEnabled =
    typeof request.body.trackerClearDataEnabled === "boolean" ? request.body.trackerClearDataEnabled : existingSettings.trackerClearDataEnabled !== false;
  const officialShiftStartTime = readTimeSetting(request.body.officialShiftStartTime, existingSettings.officialShiftStartTime || "23:00");
  const officialShiftEndTime = readTimeSetting(request.body.officialShiftEndTime, existingSettings.officialShiftEndTime || "08:00");
  const officialFirstBreakStartTime = readTimeSetting(request.body.officialFirstBreakStartTime, existingSettings.officialFirstBreakStartTime || "01:00");
  const officialFirstBreakEndTime = readTimeSetting(request.body.officialFirstBreakEndTime, existingSettings.officialFirstBreakEndTime || "01:15");
  const officialLunchBreakStartTime = readTimeSetting(request.body.officialLunchBreakStartTime, existingSettings.officialLunchBreakStartTime || "03:15");
  const officialLunchBreakEndTime = readTimeSetting(request.body.officialLunchBreakEndTime, existingSettings.officialLunchBreakEndTime || "04:15");
  const officialSecondBreakStartTime = readTimeSetting(request.body.officialSecondBreakStartTime, existingSettings.officialSecondBreakStartTime || "06:15");
  const officialSecondBreakEndTime = readTimeSetting(request.body.officialSecondBreakEndTime, existingSettings.officialSecondBreakEndTime || "06:30");
  const attendanceTimeZone = String(request.body.attendanceTimeZone || existingSettings.attendanceTimeZone || "Asia/Manila").trim();
  const lateGraceMinutes = Number(request.body.lateGraceMinutes ?? existingSettings.lateGraceMinutes ?? 0);
  const themeKey = String(request.body.themeKey || existingSettings.themeKey || "theme-1").trim();

  if (!currencies.includes(currencyCode as CurrencyCode)) {
    response.status(400).json({ message: "Valid currencyCode is required" });
    return;
  }

  if (!payrollBillingCycles.includes(payrollBillingCycle as PayrollBillingCycle)) {
    response.status(400).json({ message: "Valid payrollBillingCycle is required" });
    return;
  }

  if (!Number.isFinite(payrollRunDay) || payrollRunDay < 1 || payrollRunDay > 30) {
    response.status(400).json({ message: "payrollRunDay must be between 1 and 30" });
    return;
  }

  const payrollCutoffDays = {
    payrollFirstCutoffStartDay,
    payrollFirstCutoffEndDay,
    payrollFirstCutoffPayDay,
    payrollSecondCutoffStartDay,
    payrollSecondCutoffEndDay,
    payrollSecondCutoffPayDay,
  };

  for (const [key, value] of Object.entries(payrollCutoffDays)) {
    if (!Number.isFinite(value) || value < 1 || value > 31) {
      response.status(400).json({ message: `${key} must be between 1 and 31` });
      return;
    }
  }

  const attendanceTimeSettings = {
    officialShiftStartTime,
    officialShiftEndTime,
    officialFirstBreakStartTime,
    officialFirstBreakEndTime,
    officialLunchBreakStartTime,
    officialLunchBreakEndTime,
    officialSecondBreakStartTime,
    officialSecondBreakEndTime,
  };

  for (const [key, value] of Object.entries(attendanceTimeSettings)) {
    if (!isValidTime(value)) {
      response.status(400).json({ message: `${key} must use HH:mm format` });
      return;
    }
  }

  if (officialFirstBreakStartTime >= officialFirstBreakEndTime || officialLunchBreakStartTime >= officialLunchBreakEndTime || officialSecondBreakStartTime >= officialSecondBreakEndTime) {
    response.status(400).json({ message: "Break and lunch end times must be after their start times" });
    return;
  }

  if (!isValidTimeZone(attendanceTimeZone)) {
    response.status(400).json({ message: "attendanceTimeZone must be a valid IANA time zone" });
    return;
  }

  if (!Number.isFinite(lateGraceMinutes) || lateGraceMinutes < 0 || lateGraceMinutes > 240) {
    response.status(400).json({ message: "lateGraceMinutes must be between 0 and 240" });
    return;
  }

  if (!themeKeys.includes(themeKey as ThemeKey)) {
    response.status(400).json({ message: "Valid themeKey is required" });
    return;
  }

  const settings = await SystemSettings.findOneAndUpdate(
    { key: "system" },
    {
      currencyCode,
      payrollBillingCycle,
      payrollRunDay: Math.round(payrollRunDay),
      payrollFirstCutoffStartDay: Math.round(payrollFirstCutoffStartDay),
      payrollFirstCutoffEndDay: Math.round(payrollFirstCutoffEndDay),
      payrollFirstCutoffPayDay: Math.round(payrollFirstCutoffPayDay),
      payrollSecondCutoffStartDay: Math.round(payrollSecondCutoffStartDay),
      payrollSecondCutoffEndDay: Math.round(payrollSecondCutoffEndDay),
      payrollSecondCutoffPayDay: Math.round(payrollSecondCutoffPayDay),
      autoAssignLeadsEnabled,
      adminLeadMiniTabsEnabled,
      employeeLeadMiniTabsEnabled,
      trackerClearDataEnabled,
      officialShiftStartTime,
      officialShiftEndTime,
      officialFirstBreakStartTime,
      officialFirstBreakEndTime,
      officialLunchBreakStartTime,
      officialLunchBreakEndTime,
      officialSecondBreakStartTime,
      officialSecondBreakEndTime,
      attendanceTimeZone,
      lateGraceMinutes: Math.round(lateGraceMinutes),
      themeKey,
    },
    { returnDocument: "after", upsert: true, runValidators: true }
  );

  response.json(settings);
}
