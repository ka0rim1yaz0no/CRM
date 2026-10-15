import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type CurrencyCode = "USD" | "PHP" | "EUR" | "GBP" | "JPY";
export type PayrollBillingCycle = "Monthly" | "Semi-monthly" | "Weekly";
export type ThemeKey =
  | "theme-1"
  | "light-command"
  | "flat-amethyst"
  | "flat-turquoise"
  | "flat-emerald"
  | "flat-river"
  | "flat-alizarin"
  | "light-clouds"
  | "light-silver"
  | "light-turquoise"
  | "light-river"
  | "light-amethyst"
  | "mail-purple"
  | "mail-lavender"
  | "mail-indigo"
  | "mail-violet";

export type SystemSettingsDocument = {
  key: "system";
  currencyCode: CurrencyCode;
  payrollBillingCycle: PayrollBillingCycle;
  payrollRunDay: number;
  payrollFirstCutoffStartDay: number;
  payrollFirstCutoffEndDay: number;
  payrollFirstCutoffPayDay: number;
  payrollSecondCutoffStartDay: number;
  payrollSecondCutoffEndDay: number;
  payrollSecondCutoffPayDay: number;
  autoAssignLeadsEnabled: boolean;
  adminLeadMiniTabsEnabled: boolean;
  employeeLeadMiniTabsEnabled: boolean;
  trackerClearDataEnabled: boolean;
  officialShiftStartTime: string;
  officialShiftEndTime: string;
  officialFirstBreakStartTime: string;
  officialFirstBreakEndTime: string;
  officialLunchBreakStartTime: string;
  officialLunchBreakEndTime: string;
  officialSecondBreakStartTime: string;
  officialSecondBreakEndTime: string;
  attendanceTimeZone: string;
  lateGraceMinutes: number;
  themeKey: ThemeKey;
};

const systemSettingsSchema = new Schema<SystemSettingsDocument>(
  {
    key: { type: String, required: true, unique: true, default: "system" },
    currencyCode: { type: String, enum: ["USD", "PHP", "EUR", "GBP", "JPY"], default: "PHP" },
    payrollBillingCycle: { type: String, enum: ["Monthly", "Semi-monthly", "Weekly"], default: "Semi-monthly" },
    payrollRunDay: { type: Number, min: 1, max: 30, default: 15 },
    payrollFirstCutoffStartDay: { type: Number, min: 1, max: 31, default: 6 },
    payrollFirstCutoffEndDay: { type: Number, min: 1, max: 31, default: 20 },
    payrollFirstCutoffPayDay: { type: Number, min: 1, max: 31, default: 25 },
    payrollSecondCutoffStartDay: { type: Number, min: 1, max: 31, default: 21 },
    payrollSecondCutoffEndDay: { type: Number, min: 1, max: 31, default: 5 },
    payrollSecondCutoffPayDay: { type: Number, min: 1, max: 31, default: 10 },
    autoAssignLeadsEnabled: { type: Boolean, default: true },
    adminLeadMiniTabsEnabled: { type: Boolean, default: true },
    employeeLeadMiniTabsEnabled: { type: Boolean, default: true },
    trackerClearDataEnabled: { type: Boolean, default: true },
    officialShiftStartTime: { type: String, trim: true, default: "23:00" },
    officialShiftEndTime: { type: String, trim: true, default: "08:00" },
    officialFirstBreakStartTime: { type: String, trim: true, default: "01:00" },
    officialFirstBreakEndTime: { type: String, trim: true, default: "01:15" },
    officialLunchBreakStartTime: { type: String, trim: true, default: "03:15" },
    officialLunchBreakEndTime: { type: String, trim: true, default: "04:15" },
    officialSecondBreakStartTime: { type: String, trim: true, default: "06:15" },
    officialSecondBreakEndTime: { type: String, trim: true, default: "06:30" },
    attendanceTimeZone: { type: String, trim: true, default: "Asia/Manila" },
    lateGraceMinutes: { type: Number, min: 0, max: 240, default: 0 },
    themeKey: {
      type: String,
      enum: [
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
      ],
      default: "theme-1",
    },
  },
  { timestamps: true }
);

export const SystemSettings = tenantModel<SystemSettingsDocument>("SystemSettings", systemSettingsSchema);
