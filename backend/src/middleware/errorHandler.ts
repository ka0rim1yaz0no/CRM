import type { ErrorRequestHandler } from "express";
import { toBusinessDatabaseAccessError } from "../utils/mongoErrors";

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  // Express identifies error middleware by its four-argument signature.
  void _next;
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
