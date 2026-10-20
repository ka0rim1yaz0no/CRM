import mongoose from "mongoose";

// Deliberately no dotenv import: explicit loopback target only, never a production default.
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const uri = args.includes("--uri") ? option("--uri") : "";
const control = args.includes("--control-db") ? option("--control-db") : "";
const businessesText = args.includes("--businesses") ? option("--businesses") : "";
const target = new URL(uri || "mongodb://invalid");
if (target.protocol !== "mongodb:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password || !/^\/[a-zA-Z0-9_-]+$/.test(target.pathname) || !/^[a-zA-Z0-9_-]+$/.test(control)) {
  throw new Error("Supply an explicit credential-free loopback Mongo URI, --control-db and --businesses JSON. No writes are performed.");
}
const businesses = JSON.parse(businessesText) as Array<{ id: string; databaseName: string }>;
if (!Array.isArray(businesses) || !businesses.length || businesses.some(item => !item.id || !/^[a-zA-Z0-9_-]+$/.test(item.databaseName))) throw new Error("Invalid explicit local business mapping");
process.env.MONGO_URI = uri;
process.env.MONGODB_URI = uri;
process.env.DEFAULT_BUSINESS_ID = businesses[0].id;
process.env.DEFAULT_BUSINESS_DATABASE = businesses[0].databaseName;
process.env.CONTROL_DATABASE_NAME = control;
process.env.BUSINESS_DATABASES = JSON.stringify(businesses);
process.env.CRM_PAYROLL_ACCURACY = "true";
process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
process.env.CRM_ATTENDANCE_BREAK_GAP = "false";
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { PayrollRecord } = await import("../models/Payroll");
const { calculatePayrollCandidate } = await import("../services/payrollRecomputeService");
const { roundMoney } = await import("../services/payrollAccuracy");
const seen = new Set<string>();
await mongoose.connect(uri);
try {
  for (const business of businesses) await runWithBusiness(business.id, async () => {
    const periods = await PayrollRecord.aggregate<{ _id: string }>([{ $match: { isArchived: false } },
      { $group: { _id: "$payPeriod", latest: { $max: "$createdAt" } } }, { $sort: { latest: -1, _id: 1 } }, { $limit: 3 }]);
    for (const period of periods) for (const employee of await Employee.find({ status: { $ne: "Archived" } }).sort({ employeeCode: 1 }).lean()) {
      const key = `${employee.employeeCode}:${period._id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const { value, record } = await calculatePayrollCandidate(employee, period._id);
        const differences = { gross: roundMoney(value.grossPay - (record?.grossPay || 0)), deductions: roundMoney(value.deductions - (record?.deductions || 0)), net: roundMoney(value.netPay - (record?.netPay || 0)) };
        if (!Object.values(differences).some(value => Math.abs(value) > 0.000001) && !value.incompleteShiftDays) continue;
        console.log(JSON.stringify({ business: business.id, employeeCode: employee.employeeCode, cutoff: period._id, differences,
          reviewDays: value.incompleteShiftDays, writes: 0 }));
      } catch (error) { console.log(JSON.stringify({ business: business.id, employeeCode: employee.employeeCode, cutoff: period._id,
        review: error instanceof Error ? error.message : "Cannot calculate", writes: 0 })); }
    }
  });
} finally { await mongoose.disconnect(); }
