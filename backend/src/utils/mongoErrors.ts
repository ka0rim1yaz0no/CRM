export class BusinessDatabaseAccessError extends Error {
  statusCode = 503;
  databaseName: string;

  constructor(databaseName: string) {
    super(
      `The CRM database user cannot access ${databaseName}. Grant readWrite access on ${databaseName} to the CRM MongoDB user, then try again.`
    );
    this.name = "BusinessDatabaseAccessError";
    this.databaseName = databaseName;
  }
}

function getErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return String(error || "");
}

export function getMongoAuthorizationDatabaseName(error: unknown) {
  const message = getErrorMessage(error);
  const match = message.match(/not authorized on\s+([^\s]+)\s+to execute/i);
  return match?.[1] || "";
}

export function isMongoAuthorizationError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeMongoError = error as { code?: unknown; codeName?: unknown; message?: unknown };
  const message = getErrorMessage(error);

  return (
    maybeMongoError.code === 13 ||
    maybeMongoError.codeName === "Unauthorized" ||
    /not authorized on\s+[^\s]+\s+to execute/i.test(message)
  );
}

export function isMongoNamespaceNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeMongoError = error as { code?: unknown; codeName?: unknown };
  const message = getErrorMessage(error);

  return (
    maybeMongoError.code === 26 ||
    maybeMongoError.codeName === "NamespaceNotFound" ||
    /ns does not exist/i.test(message)
  );
}

export function toBusinessDatabaseAccessError(error: unknown, databaseName?: string) {
  if (!isMongoAuthorizationError(error)) {
    return null;
  }

  const resolvedDatabaseName = databaseName || getMongoAuthorizationDatabaseName(error) || "the selected business database";
  return new BusinessDatabaseAccessError(resolvedDatabaseName);
}
