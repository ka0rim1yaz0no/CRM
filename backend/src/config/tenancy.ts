import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import mongoose, { type Connection, type Model, type Schema } from "mongoose";
import { createBusinessProfile, getBusinessDisplayNameMap, getCreatedBusinessProfiles, setBusinessDisplayName } from "../models/BusinessProfile";
import { toBusinessDatabaseAccessError } from "../utils/mongoErrors";

export type BusinessConfig = {
  id: string;
  name: string;
  databaseName: string;
  isDefault: boolean;
};

type BusinessInput = {
  id?: unknown;
  name?: unknown;
  database?: unknown;
  databaseName?: unknown;
  db?: unknown;
};

declare global {
  namespace Express {
    interface Request {
      business?: BusinessConfig;
    }
  }
}

const businessContext = new AsyncLocalStorage<BusinessConfig>();
const modelRegistry = new Map<string, Schema>();
const modelRegistryVersions = new WeakMap<Connection, number>();
const businessConnectionCache = new Map<string, Connection>();
let modelRegistryVersion = 0;
let configuredBusinesses: BusinessConfig[] | null = null;
let createdBusinessConfigs: Array<Omit<BusinessConfig, "isDefault">> = [];

function titleFromId(id: string) {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function databaseNameFromMongoUri(uri: string) {
  try {
    const parsedUri = new URL(uri);
    const [databaseName] = parsedUri.pathname.replace(/^\/+/, "").split("/");
    return decodeURIComponent(databaseName || "").trim();
  } catch {
    return "";
  }
}

function normalizeBusiness(input: BusinessInput, index: number): Omit<BusinessConfig, "isDefault"> | null {
  const id = String(input.id || "").trim();
  const databaseName = String(input.databaseName || input.database || input.db || "").trim();

  if (!id || !databaseName) {
    return null;
  }

  const name = String(input.name || "").trim() || titleFromId(id) || `Business ${index + 1}`;

  return { id, name, databaseName };
}

function parseJsonBusinesses(rawValue: string) {
  const parsedValue = JSON.parse(rawValue) as unknown;

  if (Array.isArray(parsedValue)) {
    return parsedValue
      .map((item, index) => normalizeBusiness((item || {}) as BusinessInput, index))
      .filter((business): business is Omit<BusinessConfig, "isDefault"> => Boolean(business));
  }

  if (parsedValue && typeof parsedValue === "object") {
    return Object.entries(parsedValue as Record<string, unknown>)
      .map(([id, value], index) => {
        if (typeof value === "string") {
          return normalizeBusiness({ id, databaseName: value }, index);
        }

        return normalizeBusiness({ id, ...((value || {}) as BusinessInput) }, index);
      })
      .filter((business): business is Omit<BusinessConfig, "isDefault"> => Boolean(business));
  }

  return [];
}

function parseDelimitedBusinesses(rawValue: string) {
  return rawValue
    .split(/[,;\n]+/)
    .map((entry, index) => {
      const value = entry.trim();
      if (!value) {
        return null;
      }

      if (value.includes("|")) {
        const [id, nameOrDatabase, databaseOrName] = value.split("|").map((part) => part.trim());

        if (!databaseOrName) {
          return normalizeBusiness({ id, databaseName: nameOrDatabase }, index);
        }

        return normalizeBusiness({ id, name: nameOrDatabase, databaseName: databaseOrName }, index);
      }

      if (value.includes("=")) {
        const [id, databaseName] = value.split("=").map((part) => part.trim());
        return normalizeBusiness({ id, databaseName }, index);
      }

      const [id, databaseName, name] = value.split(":").map((part) => part.trim());
      return normalizeBusiness({ id, name, databaseName }, index);
    })
    .filter((business): business is Omit<BusinessConfig, "isDefault"> => Boolean(business));
}

function getBusinessInputs() {
  const rawValue = String(process.env.BUSINESS_DATABASES || process.env.TENANT_DATABASES || "").trim();

  if (!rawValue) {
    return [];
  }

  if (rawValue.startsWith("{") || rawValue.startsWith("[")) {
    return parseJsonBusinesses(rawValue);
  }

  return parseDelimitedBusinesses(rawValue);
}

function lettersFromNumber(value: number) {
  let currentValue = Math.max(0, Math.floor(value));
  let letters = "";

  do {
    letters = String.fromCharCode(97 + (currentValue % 26)) + letters;
    currentValue = Math.floor(currentValue / 26) - 1;
  } while (currentValue >= 0);

  return letters;
}

function nextBusinessIdentifiers(existingBusinesses: Array<Pick<BusinessConfig, "id" | "databaseName">>) {
  const existingIds = new Set(existingBusinesses.map((business) => business.id));
  const existingDatabaseNames = new Set(existingBusinesses.map((business) => business.databaseName));

  for (let index = 0; index < 500; index += 1) {
    const suffix = lettersFromNumber(index);
    const id = `business-${suffix}`;
    const databaseName = suffix === "a" ? "crm" : `crm_${suffix}`;

    if (!existingIds.has(id) && !existingDatabaseNames.has(databaseName)) {
      return { id, databaseName };
    }
  }

  throw new Error("Unable to allocate a new business id.");
}

async function verifyBusinessDatabaseAccess(databaseName: string) {
  const connection = mongoose.connection.useDb(databaseName, { useCache: true });
  const markerCollection = connection.collection("__tenant_setup");
  const markerQuery = { key: "database-access-check" };

  try {
    await markerCollection.updateOne(
      markerQuery,
      { $set: { checkedAt: new Date().toISOString() } },
      { upsert: true }
    );
    await markerCollection.findOne(markerQuery);
    await markerCollection.deleteOne(markerQuery);
  } catch (error) {
    throw toBusinessDatabaseAccessError(error, databaseName) || error;
  }
}

export function getConfiguredBusinesses() {
  if (configuredBusinesses) {
    return configuredBusinesses;
  }

  const mongoUriDatabaseName = databaseNameFromMongoUri(process.env.MONGODB_URI || "");
  const defaultDatabaseName = process.env.DEFAULT_BUSINESS_DATABASE || mongoUriDatabaseName || "crm";
  const rawBusinesses = getBusinessInputs();
  const businessMap = new Map<string, Omit<BusinessConfig, "isDefault">>();

  if (rawBusinesses.length === 0) {
    const defaultBusinessId = String(process.env.DEFAULT_BUSINESS_ID || "default").trim();
    businessMap.set(defaultBusinessId, {
      id: defaultBusinessId,
      name: process.env.DEFAULT_BUSINESS_NAME || "Default Business",
      databaseName: defaultDatabaseName,
    });
  } else {
    rawBusinesses.forEach((business) => {
      businessMap.set(business.id, business);
    });
  }

  createdBusinessConfigs.forEach((business) => {
    if (!businessMap.has(business.id)) {
      businessMap.set(business.id, business);
    }
  });

  const businesses = Array.from(businessMap.values());
  const requestedDefaultBusinessId = String(process.env.DEFAULT_BUSINESS_ID || businesses[0]?.id || "default").trim();
  const fallbackDefaultBusinessId = businesses.some((business) => business.id === requestedDefaultBusinessId)
    ? requestedDefaultBusinessId
    : businesses[0]?.id || requestedDefaultBusinessId;

  configuredBusinesses = businesses.map((business) => ({
    ...business,
    isDefault: business.id === fallbackDefaultBusinessId,
  }));

  return configuredBusinesses;
}

export type PublicBusinessConfig = Pick<BusinessConfig, "id" | "name" | "isDefault">;

export async function refreshConfiguredBusinessesFromStore() {
  createdBusinessConfigs = await getCreatedBusinessProfiles();
  configuredBusinesses = null;
  return getConfiguredBusinesses();
}

export async function getPublicBusinesses(): Promise<PublicBusinessConfig[]> {
  await refreshConfiguredBusinessesFromStore();
  const displayNames = await getBusinessDisplayNameMap();

  return getConfiguredBusinesses().map(({ id, name, isDefault }) => ({
    id,
    name: displayNames.get(id) || name,
    isDefault,
  }));
}

export async function getPublicBusinessById(businessId: string) {
  const normalizedBusinessId = String(businessId || "").trim();
  const businesses = await getPublicBusinesses();

  return businesses.find((business) => business.id === normalizedBusinessId) || null;
}

export async function updateBusinessDisplayName(businessId: string, name: string) {
  const business = getBusinessById(businessId);

  if (!business) {
    return null;
  }

  await setBusinessDisplayName(business.id, name);
  return getPublicBusinessById(business.id);
}

export async function createBusiness(name: string) {
  const normalizedName = String(name || "").trim();

  if (!normalizedName) {
    return null;
  }

  await refreshConfiguredBusinessesFromStore();

  const attemptedBusinesses = getConfiguredBusinesses().map(({ id, databaseName }) => ({ id, databaseName }));

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const identifiers = nextBusinessIdentifiers(attemptedBusinesses);

    await verifyBusinessDatabaseAccess(identifiers.databaseName);

    const profile = await createBusinessProfile({
      businessId: identifiers.id,
      databaseName: identifiers.databaseName,
      name: normalizedName,
    });

    if (profile) {
      await refreshConfiguredBusinessesFromStore();
      return getPublicBusinessById(identifiers.id);
    }

    attemptedBusinesses.push(identifiers);
  }

  return null;
}

export function getDefaultBusiness() {
  return getConfiguredBusinesses().find((business) => business.isDefault) || getConfiguredBusinesses()[0];
}

export function getBusinessById(businessId: string) {
  const normalizedBusinessId = businessId.trim();
  return getConfiguredBusinesses().find((business) => business.id === normalizedBusinessId) || null;
}

export function getCurrentBusiness() {
  return businessContext.getStore() || getDefaultBusiness();
}

export function getCurrentBusinessId() {
  return getCurrentBusiness().id;
}

export function runWithBusiness<T>(businessId: string, callback: () => T) {
  const business = getBusinessById(businessId);

  if (!business) {
    throw new Error(`Unknown business: ${businessId}`);
  }

  return businessContext.run(business, callback);
}

export async function runForEachBusiness(callback: (business: BusinessConfig) => Promise<void>) {
  for (const business of getConfiguredBusinesses()) {
    await businessContext.run(business, () => callback(business));
  }
}

function ensureModelsOnConnection(connection: Connection) {
  if (modelRegistryVersions.get(connection) === modelRegistryVersion) {
    return;
  }

  for (const [modelName, schema] of modelRegistry) {
    if (!connection.models[modelName]) {
      connection.model(modelName, schema);
    }
  }

  modelRegistryVersions.set(connection, modelRegistryVersion);
}

export function getBusinessConnection(businessId = getCurrentBusinessId()) {
  const business = getBusinessById(businessId);

  if (!business) {
    throw new Error(`Unknown business: ${businessId}`);
  }

  const cachedConnection = businessConnectionCache.get(business.databaseName);

  if (cachedConnection) {
    ensureModelsOnConnection(cachedConnection);
    return cachedConnection;
  }

  const connection = mongoose.connection.useDb(business.databaseName, { useCache: true });
  businessConnectionCache.set(business.databaseName, connection);
  ensureModelsOnConnection(connection);
  return connection;
}

export function tenantModel<T>(modelName: string, schema: Schema<T>) {
  if (!modelRegistry.has(modelName)) {
    modelRegistry.set(modelName, schema);
    modelRegistryVersion += 1;
  }

  const getModel = () => {
    const connection = getBusinessConnection();
    return connection.model<T>(modelName);
  };

  const proxyTarget = function TenantModel(this: unknown, ...args: unknown[]) {
    const ActiveModel = getModel() as unknown as new (...modelArgs: unknown[]) => unknown;
    return Reflect.construct(ActiveModel, args);
  };

  return new Proxy(proxyTarget, {
    get(_target, property) {
      const activeModel = getModel() as unknown as Record<PropertyKey, unknown>;
      const value = Reflect.get(activeModel, property);

      return typeof value === "function" ? value.bind(activeModel) : value;
    },
    set(_target, property, value) {
      const activeModel = getModel() as unknown as Record<PropertyKey, unknown>;
      return Reflect.set(activeModel, property, value);
    },
    has(_target, property) {
      return property in (getModel() as unknown as Record<PropertyKey, unknown>);
    },
    apply(_target, thisArg, args) {
      return Reflect.apply(getModel() as unknown as (...modelArgs: unknown[]) => unknown, thisArg, args);
    },
    construct(_target, args) {
      const ActiveModel = getModel() as unknown as new (...modelArgs: unknown[]) => unknown;
      return Reflect.construct(ActiveModel, args) as object;
    },
  }) as unknown as Model<T>;
}

function requestBusinessId(request: Request) {
  const rawHeader = request.header("x-business-id") || request.header("x-tenant-id");
  const rawQuery = typeof request.query.businessId === "string" ? request.query.businessId : "";
  return String(rawHeader || rawQuery || getDefaultBusiness().id).trim();
}

export function businessContextMiddleware(request: Request, response: Response, next: NextFunction) {
  const businessId = requestBusinessId(request);
  const business = getBusinessById(businessId);

  if (!business) {
    response.status(400).json({ message: "Unknown business selected." });
    return;
  }

  businessContext.run(business, () => {
    request.business = business;
    next();
  });
}
