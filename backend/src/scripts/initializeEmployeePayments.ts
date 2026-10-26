import "dotenv/config";
import mongoose from "mongoose";
import { connectDatabase } from "../config/db";
import { refreshConfiguredBusinessesFromStore } from "../config/tenancy";
import { initializeEmployeePaymentHistory } from "../services/employeePayments";

try {
    await connectDatabase(process.env.MONGODB_URI || "");
    await refreshConfiguredBusinessesFromStore();
    console.log(JSON.stringify(await initializeEmployeePaymentHistory(process.argv.includes("--apply"))));
} finally { await mongoose.disconnect(); }
