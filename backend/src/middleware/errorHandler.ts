import type { ErrorRequestHandler } from "express";
import { toBusinessDatabaseAccessError } from "../utils/mongoErrors";

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  // Express identifies error middleware by its four-argument signature.
  void _next;
  if (error.code === 11000 && (error.keyPattern?.activePhoneKey || String(error.message).includes("active_phone_key_unique"))) {
    response.status(409).json({ code: "LEAD_PHONE_EXISTS", message: "An active lead already uses this telephone number in this business." });
    return;
  }
  const businessDatabaseAccessError = toBusinessDatabaseAccessError(error);

  if (businessDatabaseAccessError) {
    response.status(businessDatabaseAccessError.statusCode).json({
      message: businessDatabaseAccessError.message,
    });
    return;
  }

  const statusCode = Number(error.statusCode || error.status || 0);
  const status = statusCode >= 400 && statusCode < 600 ? statusCode : error.name === "ValidationError" ? 400 : 500;

  response.status(status).json({
    message: error.message || "Server error",
  });
};
