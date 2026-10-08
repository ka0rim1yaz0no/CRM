import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { employeeRouter } from "./routes/employeeRoutes";
import { roleRouter } from "./routes/roleRoutes";
import { branchRouter } from "./routes/branchRoutes";
import { toolRouter } from "./routes/toolRoutes";
import { productCategoryRouter } from "./routes/productCategoryRoutes";
import { mediaRouter } from "./routes/mediaRoutes";
import { featureFlagRouter } from "./routes/featureFlagRoutes";
import { systemSettingsRouter } from "./routes/systemSettingsRoutes";
import { taskRouter } from "./routes/taskRoutes";
import { hrRouter } from "./routes/hrRoutes";
import { teamRouter } from "./routes/teamRoutes";
import { adminLeadRouter } from "./routes/adminLeadRoutes";
import { leadRouter } from "./routes/leadRoutes";
import { integrationRouter } from "./routes/integrationRoutes";
import { myLeadRouter } from "./routes/myLeadRoutes";
import { messageRouter } from "./routes/messageRoutes";
import { noticeRouter } from "./routes/noticeRoutes";
import { leaveRequestRouter } from "./routes/leaveRequestRoutes";
import { knowledgeBaseRouter } from "./routes/knowledgeBaseRoutes";
import { credentialRouter } from "./routes/credentialRoutes";
import { payrollRouter } from "./routes/payrollRoutes";
import { reportRouter } from "./routes/reportRoutes";
import { authRouter } from "./routes/authRoutes";
import { attendanceRouter } from "./routes/attendanceRoutes";
import { employeeTransactionRouter } from "./routes/employeeTransactionRoutes";
import { browserActivityRouter } from "./routes/browserActivityRoutes";
import { errorHandler } from "./middleware/errorHandler";
import { callRouter } from "./routes/callLoggerRoutes";
import { callBridgeRouter } from "./routes/callBridgeRoutes";
import { callDashboardRouter } from "./routes/callDashboardRoutes";
import { tomTomQuotaRouter } from "./routes/tomTomQuotaRoutes";
import { businessContextMiddleware, createBusiness, getPublicBusinesses, updateBusinessDisplayName } from "./config/tenancy";
import { publicSurveyRouter } from "./routes/publicSurveyRoutes";
import { employeeEvaluationRouter } from "./routes/employeeEvaluationRoutes";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRootDirectory = path.resolve(appDirectory, "..");
const uploadDirectories = Array.from(
  new Set([
    path.resolve("public", "uploads"),
    path.resolve("uploads"),
    path.resolve(backendRootDirectory, "public", "uploads"),
    path.resolve(backendRootDirectory, "uploads"),
    path.resolve(process.cwd(), "backend", "public", "uploads"),
    path.resolve(process.cwd(), "backend", "uploads"),
  ])
);
const requestBodyLimit = process.env.REQUEST_BODY_LIMIT || "500mb";
const defaultClientOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://crm.assistly123.com",
  "https://assistly123.com",
  "https://www.assistly123.com",
];

const clientOrigins = Array.from(
  new Set([
    ...defaultClientOrigins,
    ...(process.env.CLIENT_ORIGIN || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ])
);

function isAllowedDevOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["5173", "5174"].includes(url.port);
  } catch {
    return false;
  }
}

function isAllowedExtensionOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return url.protocol === "chrome-extension:";
  } catch {
    return false;
  }
}

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        if (
          !origin ||
          clientOrigins.includes(origin) ||
          isAllowedDevOrigin(origin) ||
          isAllowedExtensionOrigin(origin)
        ) {
          callback(null, true);
          return;
        }

        console.warn(`CORS blocked origin: ${origin}`);
        callback(null, false);
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "Accept",
        "Cache-Control",
        "Pragma",
        "X-Business-Id",
        "X-Tenant-Id",
        "X-Integration-Key",
        "X-CRM-User-Code",
        "X-CRM-User-Name",
        "X-CRM-User-Type",
        "X-TomTom-Quota-Secret",
      ],
    })
  );

  app.use(express.json({ limit: requestBodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: requestBodyLimit }));


  uploadDirectories.forEach((uploadDirectory) => {
    app.use("/uploads", express.static(uploadDirectory));
  });

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/businesses", async (_request, response) => {
    response.json(await getPublicBusinesses());
  });

  app.post("/api/businesses", async (request, response) => {
    const name = String(request.body.name || "").trim();

    if (!name) {
      response.status(400).json({ message: "Business name is required." });
      return;
    }

    const business = await createBusiness(name);

    if (!business) {
      response.status(409).json({ message: "Unable to create business. Please try another name." });
      return;
    }

    response.status(201).json(business);
  });

  app.patch("/api/businesses/:businessId", async (request, response) => {
    const name = String(request.body.name || "").trim();

    if (!name) {
      response.status(400).json({ message: "Business name is required." });
      return;
    }

    const business = await updateBusinessDisplayName(String(request.params.businessId || ""), name);

    if (!business) {
      response.status(404).json({ message: "Business not found." });
      return;
    }

    response.json(business);
  });

  app.use("/api/tomtom-quota", tomTomQuotaRouter);
  app.use("/api/public/surveys", publicSurveyRouter);

  app.use("/api", businessContextMiddleware);

  app.use("/api/auth", authRouter);
  app.use("/api/employees", employeeRouter);
  app.use("/api/roles", roleRouter);
  app.use("/api/branches", branchRouter);
  app.use("/api/tools", toolRouter);
  app.use("/api/product-categories", productCategoryRouter);
  app.use("/api/media", mediaRouter);
  app.use("/api/features", featureFlagRouter);
  app.use("/api/system-settings", systemSettingsRouter);
  app.use("/api/tasks", taskRouter);
  app.use("/api/hr", hrRouter);
  app.use("/api/teams", teamRouter);
  app.use("/api/integrations", integrationRouter);
  app.use("/api/admin-leads", adminLeadRouter);
  app.use("/api/my-leads", myLeadRouter);
  app.use("/api/leads", leadRouter);
  app.use("/api/knowledge-base", knowledgeBaseRouter);
  app.use("/api/credentials", credentialRouter);
  app.use("/api/payroll", payrollRouter);
  app.use("/api/evaluations", employeeEvaluationRouter);
  app.use("/api/reports", reportRouter);
  app.use("/api/messages", messageRouter);
  app.use("/api/browser-activity", browserActivityRouter);
  app.use("/api/call-bridge", callBridgeRouter);
  app.use("/api/call-dashboard", callDashboardRouter);
  app.use("/api", noticeRouter);
  app.use("/api", leaveRequestRouter);
  app.use("/api", attendanceRouter);
  app.use("/api", employeeTransactionRouter);
  app.use("/api/log", callRouter);
  app.use(errorHandler);

  return app;
}
