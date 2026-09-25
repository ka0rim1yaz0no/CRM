import { createHash, randomUUID } from "node:crypto";
import { getPlaceSearchUsageModel } from "../models/PlaceSearchUsage";
import {
  evaluateTomTomPlaceRelevance,
  isSpecificTomTomSearchQuery,
  isTomTomPlaceWithinRadius,
  matchesTomTomLocationLabel,
  matchesTomTomRequestedRegion,
} from "./tomTomRelevance";

type TomTomOrbisAddress = {
  country?: string;
  countryCodeIso2?: string;
  countrySubdivision?: string;
  municipality?: string;
  municipalitySubdivision?: string;
  neighborhood?: string;
  postalCode?: string;
  street?: string;
  houseNumber?: string;
};

type TomTomOrbisResult = {
  id?: string;
  type?: string;
  title?: string;
  subtitles?: string[];
  position?: {
    coordinates?: number[];
  };
  address?: TomTomOrbisAddress;
  poiTypes?: Array<{ id?: string; name?: string }>;
  contacts?: Array<{ phones?: string[]; websites?: string[] }>;
};

type TomTomOrbisResponse = {
  results?: TomTomOrbisResult[];
  detailedError?: {
    code?: string;
    message?: string;
  };
  errorText?: string;
  message?: string;
};

type TomTomOrbisDetailsResponse = TomTomOrbisResult & Pick<TomTomOrbisResponse, "detailedError" | "errorText" | "message">;

type TomTomLegacyPoi = {
  name?: string;
  phone?: string;
  url?: string;
  classifications?: Array<{ names?: Array<{ name?: string }> }>;
};

type TomTomLegacySearchResult = {
  type?: string;
  id?: string;
  poi?: TomTomLegacyPoi;
  address?: {
    freeformAddress?: string;
    municipality?: string;
    countrySubdivision?: string;
  };
  position?: {
    lat?: number;
    lon?: number;
  };
};

type TomTomLegacySearchResponse = {
  summary?: {
    numResults?: number;
    offset?: number;
    totalResults?: number;
  };
  results?: TomTomLegacySearchResult[];
  errorText?: string;
  message?: string;
};

export type TomTomQuotaProduct = "places-discover" | "search" | "places-suggest" | "places-details" | "geocoding";

export type TomTomProductUsage = {
  product: TomTomQuotaProduct;
  periodKey: string;
  used: number;
  limit: number;
  remaining: number;
};

export type TomTomPlaceLead = {
  provider: "tomtom";
  providerPlaceId: string;
  googlePlaceId: string;
  businessName: string;
  businessAddress: string;
  phone: string;
  website: string;
  latitude?: number;
  longitude?: number;
  providerCategory?: string;
  municipality?: string;
  countrySubdivision?: string;
  matchedQuery?: string;
  relevanceScore?: number;
  relevanceReason?: string;
};

export type TomTomUsage = {
  provider: "tomtom";
  dayKey: string;
  periodKey: string;
  resetAt: string;
  usagePeriod: "month";
  used: number;
  limit: number;
  remaining: number;
  configured: boolean;
  evaluationMode: boolean;
  products: {
    discover: TomTomProductUsage;
    search: TomTomProductUsage;
    suggest: TomTomProductUsage;
    details: TomTomProductUsage;
    geocoding: TomTomProductUsage;
  };
};

export type TomTomSearchBatchResult = {
  places: TomTomPlaceLead[];
  searchedQueries: string[];
  searchedPages: number;
  searchedLocations: string[];
  requestCount: number;
  rejectedIrrelevantCount: number;
  limitReached: boolean;
  usage: TomTomUsage;
};

type TomTomLocation = {
  latitude: number;
  longitude: number;
};

type TomTomSearchCenter = TomTomLocation & {
  label: string;
  radiusMiles: number;
};

const TOMTOM_API_ORIGIN = "https://api.tomtom.com";
const TOMTOM_DISCOVER_PROVIDER_LIMIT = 5000;
const TOMTOM_SEARCH_PROVIDER_LIMIT = 2500;
const TOMTOM_SUGGEST_PROVIDER_LIMIT = 10000;
const TOMTOM_DETAILS_PROVIDER_LIMIT = 5000;
const TOMTOM_GEOCODING_PROVIDER_LIMIT = 20000;
const TOMTOM_DEFAULT_DISCOVER_MONTHLY_LIMIT = 4900;
const TOMTOM_DEFAULT_SEARCH_MONTHLY_LIMIT = 2400;
const TOMTOM_DEFAULT_SUGGEST_MONTHLY_LIMIT = 9900;
const TOMTOM_DEFAULT_DETAILS_MONTHLY_LIMIT = 4900;
const TOMTOM_DEFAULT_GEOCODING_MONTHLY_LIMIT = 19900;
const TOMTOM_DEFAULT_RESULT_LIMIT = 100;
const TOMTOM_MAX_REQUEST_BUDGET = 400;
const TOMTOM_METERS_PER_MILE = 1609.344;
const TOMTOM_MAX_RADIUS_METERS = 100000;
const TOMTOM_SEARCH_BATCH_SIZE = 12;
const TOMTOM_DETAILS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOMTOM_DETAILS_CACHE_MAX_ENTRIES = 5000;
const TOMTOM_GEOCODING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TOMTOM_GEOCODING_CACHE_MAX_ENTRIES = 1000;
const tomTomDetailsCache = new Map<string, { expiresAt: number; payload: TomTomOrbisDetailsResponse }>();
const tomTomDetailsInFlight = new Map<string, Promise<TomTomOrbisDetailsResponse>>();
const tomTomGeocodingCache = new Map<string, { expiresAt: number; location: TomTomLocation }>();
const TOMTOM_US_METRO_CENTERS: Array<[string, number, number]> = [
  ["New York, NY", 40.7128, -74.006], ["Los Angeles, CA", 34.0522, -118.2437],
  ["Chicago, IL", 41.8781, -87.6298], ["Dallas, TX", 32.7767, -96.797],
  ["Houston, TX", 29.7604, -95.3698], ["Washington, DC", 38.9072, -77.0369],
  ["Miami, FL", 25.7617, -80.1918], ["Philadelphia, PA", 39.9526, -75.1652],
  ["Atlanta, GA", 33.749, -84.388], ["Boston, MA", 42.3601, -71.0589],
  ["Phoenix, AZ", 33.4484, -112.074], ["San Francisco, CA", 37.7749, -122.4194],
  ["Seattle, WA", 47.6062, -122.3321], ["Detroit, MI", 42.3314, -83.0458],
  ["Minneapolis, MN", 44.9778, -93.265], ["San Diego, CA", 32.7157, -117.1611],
  ["Tampa, FL", 27.9506, -82.4572], ["Denver, CO", 39.7392, -104.9903],
  ["Baltimore, MD", 39.2904, -76.6122], ["St. Louis, MO", 38.627, -90.1994],
  ["Charlotte, NC", 35.2271, -80.8431], ["Orlando, FL", 28.5383, -81.3792],
  ["San Antonio, TX", 29.4241, -98.4936], ["Portland, OR", 45.5152, -122.6784],
  ["Sacramento, CA", 38.5816, -121.4944], ["Pittsburgh, PA", 40.4406, -79.9959],
  ["Las Vegas, NV", 36.1699, -115.1398], ["Austin, TX", 30.2672, -97.7431],
  ["Cincinnati, OH", 39.1031, -84.512], ["Kansas City, MO", 39.0997, -94.5786],
  ["Columbus, OH", 39.9612, -82.9988], ["Indianapolis, IN", 39.7684, -86.1581],
  ["Cleveland, OH", 41.4993, -81.6944], ["Nashville, TN", 36.1627, -86.7816],
  ["San Jose, CA", 37.3382, -121.8863], ["Jacksonville, FL", 30.3322, -81.6557],
  ["Raleigh, NC", 35.7796, -78.6382], ["Memphis, TN", 35.1495, -90.049],
  ["New Orleans, LA", 29.9511, -90.0715], ["Salt Lake City, UT", 40.7608, -111.891],
  ["Milwaukee, WI", 43.0389, -87.9065], ["Oklahoma City, OK", 35.4676, -97.5164],
  ["Louisville, KY", 38.2527, -85.7585], ["Richmond, VA", 37.5407, -77.436],
  ["Buffalo, NY", 42.8864, -78.8784], ["Birmingham, AL", 33.5186, -86.8104],
];
let nextTomTomRequestAt = 0;
let tomTomBlockedUntil = 0;
let tomTomRateLimitQueue = Promise.resolve();
let tomTomUnavailablePeriodKey = "";
const tomTomUnavailableProducts = new Set<TomTomQuotaProduct>();

export class TomTomUsageLimitError extends Error {
  statusCode = 429;

  constructor(message = "TomTom monthly free request limit reached.") {
    super(message);
    this.name = "TomTomUsageLimitError";
  }
}

export class TomTomSearchQueryError extends Error {
  statusCode = 400;

  constructor(message = "Enter a specific business type so TomTom results can be validated accurately.") {
    super(message);
    this.name = "TomTomSearchQueryError";
  }
}

function numericEnvironmentValue(name: string, fallback: number) {
  const parsedValue = Number(process.env[name]);
  return Number.isFinite(parsedValue) ? Math.round(parsedValue) : fallback;
}

function tomTomProductLimit(product: TomTomQuotaProduct) {
  if (product === "geocoding") {
    return Math.min(
      Math.max(numericEnvironmentValue("TOMTOM_GEOCODING_MONTHLY_REQUEST_LIMIT", TOMTOM_DEFAULT_GEOCODING_MONTHLY_LIMIT), 1),
      TOMTOM_GEOCODING_PROVIDER_LIMIT
    );
  }

  if (product === "search") {
    return Math.min(
      Math.max(numericEnvironmentValue("TOMTOM_SEARCH_MONTHLY_REQUEST_LIMIT", TOMTOM_DEFAULT_SEARCH_MONTHLY_LIMIT), 1),
      TOMTOM_SEARCH_PROVIDER_LIMIT
    );
  }

  if (product === "places-suggest") {
    return Math.min(
      Math.max(numericEnvironmentValue("TOMTOM_SUGGEST_MONTHLY_REQUEST_LIMIT", TOMTOM_DEFAULT_SUGGEST_MONTHLY_LIMIT), 1),
      TOMTOM_SUGGEST_PROVIDER_LIMIT
    );
  }

  if (product === "places-details") {
    return Math.min(
      Math.max(numericEnvironmentValue("TOMTOM_DETAILS_MONTHLY_REQUEST_LIMIT", TOMTOM_DEFAULT_DETAILS_MONTHLY_LIMIT), 1),
      TOMTOM_DETAILS_PROVIDER_LIMIT
    );
  }

  return Math.min(
    Math.max(numericEnvironmentValue("TOMTOM_DISCOVER_MONTHLY_REQUEST_LIMIT", TOMTOM_DEFAULT_DISCOVER_MONTHLY_LIMIT), 1),
    TOMTOM_DISCOVER_PROVIDER_LIMIT
  );
}

function tomTomResultLimit() {
  return Math.min(Math.max(numericEnvironmentValue("TOMTOM_RESULTS_PER_REQUEST", TOMTOM_DEFAULT_RESULT_LIMIT), 1), 100);
}

function tomTomMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function tomTomUsageKey(product: TomTomQuotaProduct, date = new Date()) {
  return `${tomTomMonthKey(date)}:${product}`;
}

function tomTomMonthlyResetAt(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}

function refreshTomTomUnavailableProducts() {
  const periodKey = tomTomMonthKey();

  if (tomTomUnavailablePeriodKey !== periodKey) {
    tomTomUnavailablePeriodKey = periodKey;
    tomTomUnavailableProducts.clear();
  }
}

function tomTomApiKey() {
  return String(process.env.TOMTOM_API_KEY || "").trim();
}

function tomTomCountrySet() {
  return String(process.env.TOMTOM_COUNTRY_SET || "US").trim().toUpperCase();
}

function tomTomEvaluationMode() {
  return String(process.env.TOMTOM_EVALUATION_MODE || "true").trim().toLowerCase() !== "false";
}

function tomTomQuotaBrokerUrl() {
  return String(process.env.TOMTOM_QUOTA_BROKER_URL || "").trim().replace(/\/+$/, "");
}

export function getTomTomQuotaBrokerSecret() {
  const configuredSecret = String(process.env.TOMTOM_QUOTA_BROKER_SECRET || "").trim();
  if (configuredSecret) return configuredSecret;

  const apiKey = tomTomApiKey();
  return apiKey
    ? createHash("sha256").update(`assistly-tomtom-quota-v1:${apiKey}`).digest("hex")
    : "";
}

function usesTomTomQuotaBroker() {
  return Boolean(tomTomQuotaBrokerUrl() && getTomTomQuotaBrokerSecret());
}

function tomTomQuotaBrokerError(message: string) {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 503;
  return error;
}

async function requestTomTomQuotaBroker(
  pathname: "usage" | "reserve",
  method: "GET" | "POST",
  product: TomTomQuotaProduct
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = new URL(`${tomTomQuotaBrokerUrl()}/${pathname}`);
    url.searchParams.set("product", product);
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "X-TomTom-Quota-Secret": getTomTomQuotaBrokerSecret(),
      },
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as Partial<TomTomUsage> & { message?: string };

    if (response.status === 429) {
      throw new TomTomUsageLimitError(payload.message);
    }

    if (!response.ok || payload.provider !== "tomtom" || !payload.dayKey) {
      throw tomTomQuotaBrokerError(payload.message || "Unable to verify the shared TomTom allowance.");
    }

    return payload as TomTomUsage;
  } catch (error) {
    if (error instanceof TomTomUsageLimitError || (error as { statusCode?: number }).statusCode === 503) {
      throw error;
    }

    if ((error as Error).name === "AbortError") {
      throw tomTomQuotaBrokerError("The shared TomTom allowance check timed out.");
    }

    throw tomTomQuotaBrokerError("Unable to reach the shared TomTom allowance service.");
  } finally {
    clearTimeout(timeout);
  }
}

export function isTomTomConfigured() {
  return Boolean(tomTomApiKey());
}

function waitForTomTomRateSlot() {
  const minimumIntervalMs = Math.min(Math.max(numericEnvironmentValue("TOMTOM_MIN_REQUEST_INTERVAL_MS", 350), 200), 2000);
  const scheduledRequest = tomTomRateLimitQueue.then(async () => {
    while (true) {
      const waitMs = Math.max(0, nextTomTomRequestAt, tomTomBlockedUntil) - Date.now();

      if (waitMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    nextTomTomRequestAt = Date.now() + minimumIntervalMs;
  });

  tomTomRateLimitQueue = scheduledRequest.catch(() => undefined);
  return scheduledRequest;
}

function getTomTomRetryDelay(response: Response, retryAttempt: number) {
  const retryAfter = String(response.headers.get("retry-after") || "").trim();
  const retryAfterSeconds = Number(retryAfter);
  const retryAfterDate = retryAfter && !Number.isFinite(retryAfterSeconds) ? Date.parse(retryAfter) : Number.NaN;
  const providerDelay = Number.isFinite(retryAfterSeconds)
    ? Math.max(0, retryAfterSeconds * 1000)
    : Number.isFinite(retryAfterDate)
      ? Math.max(0, retryAfterDate - Date.now())
      : 0;
  const baseDelay = Math.min(Math.max(numericEnvironmentValue("TOMTOM_429_RETRY_DELAY_MS", 1500), 500), 10000);
  const exponentialDelay = Math.min(baseDelay * (2 ** retryAttempt), 30000);
  return Math.max(providerDelay, exponentialDelay);
}

function pauseTomTomRequests(delayMs: number) {
  tomTomBlockedUntil = Math.max(tomTomBlockedUntil, Date.now() + delayMs);
}

export async function getLocalTomTomProductUsage(product: TomTomQuotaProduct): Promise<TomTomProductUsage> {
  const periodKey = tomTomMonthKey();
  const dayKey = tomTomUsageKey(product);
  const usage = await getPlaceSearchUsageModel().findOne({ provider: "tomtom", dayKey }).lean();
  const limit = tomTomProductLimit(product);
  const used = Math.max(0, Number(usage?.requestCount || 0));

  return {
    product,
    periodKey,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  };
}

export async function getLocalTomTomUsage(): Promise<TomTomUsage> {
  const [discover, search, suggest, details, geocoding] = await Promise.all([
    getLocalTomTomProductUsage("places-discover"),
    getLocalTomTomProductUsage("search"),
    getLocalTomTomProductUsage("places-suggest"),
    getLocalTomTomProductUsage("places-details"),
    getLocalTomTomProductUsage("geocoding"),
  ]);
  const used = discover.used + search.used + suggest.used + details.used;
  const limit = discover.limit + search.limit + suggest.limit + details.limit;

  return {
    provider: "tomtom",
    dayKey: discover.periodKey,
    periodKey: discover.periodKey,
    resetAt: tomTomMonthlyResetAt(),
    usagePeriod: "month",
    used,
    limit,
    remaining: Math.max(0, limit - used),
    configured: isTomTomConfigured(),
    evaluationMode: tomTomEvaluationMode(),
    products: { discover, search, suggest, details, geocoding },
  };
}

export async function getTomTomUsage(): Promise<TomTomUsage> {
  if (usesTomTomQuotaBroker()) {
    return requestTomTomQuotaBroker("usage", "GET", "places-discover");
  }

  return getLocalTomTomUsage();
}

export async function reserveLocalTomTomRequest(product: TomTomQuotaProduct = "places-discover") {
  const Usage = getPlaceSearchUsageModel();
  const dayKey = tomTomUsageKey(product);
  const limit = tomTomProductLimit(product);
  const filter = { provider: "tomtom" as const, dayKey, requestCount: { $lt: limit } };
  const updatedUsage = await Usage.findOneAndUpdate(filter, { $inc: { requestCount: 1 } }, { returnDocument: "after" });

  if (updatedUsage) {
    return;
  }

  try {
    await Usage.create({ provider: "tomtom", dayKey, requestCount: 1 });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) {
      throw error;
    }

    const retriedUsage = await Usage.findOneAndUpdate(filter, { $inc: { requestCount: 1 } }, { returnDocument: "after" });

    if (!retriedUsage) {
      throw new TomTomUsageLimitError(`TomTom ${product} monthly free request limit reached.`);
    }
  }
}

async function reserveTomTomRequest(product: TomTomQuotaProduct) {
  refreshTomTomUnavailableProducts();
  if (tomTomUnavailableProducts.has(product)) {
    throw new TomTomUsageLimitError(`TomTom ${product} monthly free request pool is unavailable or exhausted.`);
  }

  if (usesTomTomQuotaBroker()) {
    await requestTomTomQuotaBroker("reserve", "POST", product);
    return;
  }

  await reserveLocalTomTomRequest(product);
}

async function markTomTomProductUnavailable(product: TomTomQuotaProduct) {
  refreshTomTomUnavailableProducts();
  tomTomUnavailableProducts.add(product);

  if (usesTomTomQuotaBroker()) return;

  const dayKey = tomTomUsageKey(product);
  await getPlaceSearchUsageModel().updateOne(
    { provider: "tomtom", dayKey },
    { $max: { requestCount: tomTomProductLimit(product) } },
    { upsert: true }
  );
}

function tomTomPoolUnavailableMessage(product: TomTomQuotaProduct) {
  const label = product === "places-discover"
    ? "Places Discover"
    : product === "search"
      ? "Search API"
      : product === "places-suggest"
        ? "Places Suggest"
        : product === "places-details"
          ? "Places Details"
          : "Geocoding";
  return `TomTom ${label} monthly free request pool is unavailable or exhausted.`;
}

function isTomTomMonthlyQuotaMessage(message: string) {
  return /credits?|quota|monthly|free[ -]?tier|usage limit|request limit reached/i.test(message);
}

function getTomTomServerRetryDelay(retryAttempt: number) {
  const baseDelay = Math.min(Math.max(numericEnvironmentValue("TOMTOM_5XX_RETRY_DELAY_MS", 750), 250), 5000);
  return Math.min(baseDelay * (2 ** retryAttempt), 10000);
}

function isTomTomTransientServiceError(error: unknown) {
  const statusCode = Number((error as { statusCode?: number }).statusCode);
  return statusCode >= 500 && statusCode < 600;
}

async function requestTomTomOrbis<TPayload extends TomTomOrbisResponse>(input: {
  pathname: string;
  product: TomTomQuotaProduct;
  apiVersion: "2" | "3";
  attributes: string;
  method?: "GET" | "POST";
  parameters?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<TPayload> {
  const apiKey = tomTomApiKey();

  if (!apiKey) {
    const error = new Error("TomTom is not configured. Add TOMTOM_API_KEY to backend/.env.") as Error & { statusCode?: number };
    error.statusCode = 503;
    throw error;
  }

  const url = new URL(input.pathname, TOMTOM_API_ORIGIN);
  Object.entries(input.parameters || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const maxRateLimitRetries = Math.min(Math.max(numericEnvironmentValue("TOMTOM_429_MAX_RETRIES", 4), 0), 6);
  const maxServerRetries = Math.min(Math.max(numericEnvironmentValue("TOMTOM_5XX_MAX_RETRIES", 2), 0), 4);
  const maxRetries = Math.max(maxRateLimitRetries, maxServerRetries);

  for (let retryAttempt = 0; retryAttempt <= maxRetries; retryAttempt += 1) {
    await waitForTomTomRateSlot();
    await reserveTomTomRequest(input.product);

    const timeoutMs = Math.min(Math.max(numericEnvironmentValue("TOMTOM_REQUEST_TIMEOUT_MS", 10000), 1000), 30000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: input.method || "GET",
        headers: {
          Accept: "application/json",
          "TomTom-Api-Key": apiKey,
          "TomTom-Api-Version": input.apiVersion,
          Attributes: input.attributes,
          ...(input.headers || {}),
          ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        body: input.body ? JSON.stringify(input.body) : undefined,
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as TPayload;

      if (response.ok) {
        return payload;
      }

      const providerMessage = payload.detailedError?.message || payload.errorText || payload.message || "";

      if (response.status === 429) {
        if (isTomTomMonthlyQuotaMessage(providerMessage)) {
          await markTomTomProductUnavailable(input.product);
          throw new TomTomUsageLimitError(tomTomPoolUnavailableMessage(input.product));
        }

        const retryDelay = getTomTomRetryDelay(response, retryAttempt);
        pauseTomTomRequests(retryDelay);

        if (retryAttempt < maxRateLimitRetries) {
          continue;
        }

        const error = new Error("TomTom is temporarily rate-limiting searches. Wait one minute and try again.") as Error & { statusCode?: number };
        error.statusCode = 429;
        throw error;
      }

      if (response.status === 402 || response.status === 403) {
        await markTomTomProductUnavailable(input.product);
        throw new TomTomUsageLimitError(tomTomPoolUnavailableMessage(input.product));
      }

      if (response.status >= 500 && retryAttempt < maxServerRetries) {
        pauseTomTomRequests(getTomTomServerRetryDelay(retryAttempt));
        continue;
      }

      const error = new Error(providerMessage || `TomTom request failed with status ${response.status}.`) as Error & { statusCode?: number };
      error.statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
      throw error;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        if (retryAttempt < maxServerRetries) {
          pauseTomTomRequests(getTomTomServerRetryDelay(retryAttempt));
          continue;
        }

        const timeoutError = new Error(`TomTom request timed out after ${timeoutMs / 1000} seconds.`) as Error & { statusCode?: number };
        timeoutError.statusCode = 504;
        throw timeoutError;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("TomTom search failed after retrying.");
}

async function requestTomTomLegacy(pathname: string, parameters: Record<string, string | number | undefined>) {
  const apiKey = tomTomApiKey();

  if (!apiKey) {
    const error = new Error("TomTom is not configured. Add TOMTOM_API_KEY to backend/.env.") as Error & { statusCode?: number };
    error.statusCode = 503;
    throw error;
  }

  const url = new URL(pathname, TOMTOM_API_ORIGIN);
  url.searchParams.set("key", apiKey);
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const maxRateLimitRetries = Math.min(Math.max(numericEnvironmentValue("TOMTOM_429_MAX_RETRIES", 4), 0), 6);
  const maxServerRetries = Math.min(Math.max(numericEnvironmentValue("TOMTOM_5XX_MAX_RETRIES", 2), 0), 4);
  const maxRetries = Math.max(maxRateLimitRetries, maxServerRetries);

  for (let retryAttempt = 0; retryAttempt <= maxRetries; retryAttempt += 1) {
    await waitForTomTomRateSlot();
    await reserveTomTomRequest("search");

    const timeoutMs = Math.min(Math.max(numericEnvironmentValue("TOMTOM_REQUEST_TIMEOUT_MS", 10000), 1000), 30000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      const payload = (await response.json().catch(() => ({}))) as TomTomLegacySearchResponse;

      if (response.ok) {
        return payload;
      }

      const providerMessage = payload.errorText || payload.message || "";

      if (response.status === 429) {
        if (isTomTomMonthlyQuotaMessage(providerMessage)) {
          await markTomTomProductUnavailable("search");
          throw new TomTomUsageLimitError(tomTomPoolUnavailableMessage("search"));
        }

        const retryDelay = getTomTomRetryDelay(response, retryAttempt);
        pauseTomTomRequests(retryDelay);

        if (retryAttempt < maxRateLimitRetries) {
          continue;
        }

        const error = new Error("TomTom is temporarily rate-limiting searches. Wait one minute and try again.") as Error & { statusCode?: number };
        error.statusCode = 429;
        throw error;
      }

      if (response.status === 402 || response.status === 403) {
        await markTomTomProductUnavailable("search");
        throw new TomTomUsageLimitError(tomTomPoolUnavailableMessage("search"));
      }

      if (response.status >= 500 && retryAttempt < maxServerRetries) {
        pauseTomTomRequests(getTomTomServerRetryDelay(retryAttempt));
        continue;
      }

      const error = new Error(providerMessage || `TomTom request failed with status ${response.status}.`) as Error & { statusCode?: number };
      error.statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
      throw error;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        if (retryAttempt < maxServerRetries) {
          pauseTomTomRequests(getTomTomServerRetryDelay(retryAttempt));
          continue;
        }

        const timeoutError = new Error(`TomTom request timed out after ${timeoutMs / 1000} seconds.`) as Error & { statusCode?: number };
        timeoutError.statusCode = 504;
        throw timeoutError;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("TomTom search failed after retrying.");
}

async function geocodeTomTomLocation(location: string) {
  const normalizedLocation = location.trim();

  if (!normalizedLocation) {
    return null;
  }

  const cacheKey = normalizedLocation.toLowerCase();
  const cachedLocation = tomTomGeocodingCache.get(cacheKey);
  if (cachedLocation && cachedLocation.expiresAt > Date.now()) {
    return cachedLocation.location;
  }
  if (cachedLocation) tomTomGeocodingCache.delete(cacheKey);

  const payload = await requestTomTomOrbis<TomTomOrbisResponse>({
    pathname: "/maps/orbis/places/geocode",
    product: "geocoding",
    apiVersion: "2",
    attributes: "results(id,type,title,position,address)",
    parameters: {
      query: normalizedLocation,
      maxResults: 1,
      countryCodesIso2: tomTomCountrySet(),
      geopoliticalView: "Unified",
    },
  });
  const coordinates = payload.results?.[0]?.position?.coordinates;

  if (!Array.isArray(coordinates) || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) {
    return null;
  }

  const resolvedLocation = { latitude: Number(coordinates[1]), longitude: Number(coordinates[0]) } satisfies TomTomLocation;
  if (tomTomGeocodingCache.size >= TOMTOM_GEOCODING_CACHE_MAX_ENTRIES) {
    const oldestKey = tomTomGeocodingCache.keys().next().value;
    if (oldestKey) tomTomGeocodingCache.delete(oldestKey);
  }
  tomTomGeocodingCache.set(cacheKey, {
    expiresAt: Date.now() + TOMTOM_GEOCODING_CACHE_TTL_MS,
    location: resolvedLocation,
  });
  return resolvedLocation;
}

function offsetTomTomCoordinates(center: TomTomLocation, northMiles: number, eastMiles: number): TomTomLocation {
  const latitude = center.latitude + northMiles / 69;
  const longitudeScale = Math.max(Math.cos((center.latitude * Math.PI) / 180), 0.2);
  const longitude = center.longitude + eastMiles / (69 * longitudeScale);
  return { latitude, longitude };
}

function createLocalSearchCenters(center: TomTomLocation, label: string, radiusMiles: number, expanded: boolean): TomTomSearchCenter[] {
  if (!expanded || radiusMiles <= 5) {
    return [{ ...center, label, radiusMiles }];
  }

  const cellRadiusMiles = Math.max(5, radiusMiles * 0.34);
  const offsets = [-0.75, -0.375, 0, 0.375, 0.75];

  return offsets.flatMap((northFactor) => offsets.map((eastFactor) => ({ northFactor, eastFactor })))
    .filter(({ northFactor, eastFactor }) => Math.hypot(northFactor, eastFactor) <= 0.9)
    .sort((first, second) => Math.hypot(first.northFactor, first.eastFactor) - Math.hypot(second.northFactor, second.eastFactor))
    .map(({ northFactor, eastFactor }, index) => ({
      ...offsetTomTomCoordinates(center, radiusMiles * northFactor, radiusMiles * eastFactor),
      label: index === 0 ? label : `${label} area ${index + 1}`,
      radiusMiles: cellRadiusMiles,
    }));
}

function createNationalSearchCenters(): TomTomSearchCenter[] {
  return TOMTOM_US_METRO_CENTERS.map(([label, latitude, longitude]) => ({
    label,
    latitude,
    longitude,
    radiusMiles: 50,
  }));
}

function formatTomTomOrbisAddress(result: TomTomOrbisResult) {
  const subtitles = (result.subtitles || []).map((value) => String(value || "").trim()).filter(Boolean);
  if (subtitles.length > 0) return subtitles.join(", ");

  const address = result.address || {};
  const streetAddress = [address.houseNumber, address.street].filter(Boolean).join(" ").trim();
  const locality = [address.municipality, address.countrySubdivision, address.postalCode].filter(Boolean).join(", ");
  return [streetAddress, locality, address.country].filter(Boolean).join(", ");
}

export function mapTomTomOrbisPlace(result: TomTomOrbisResult): TomTomPlaceLead | null {
  const businessName = String(result.title || "").trim();

  if (String(result.type || "").toLowerCase() !== "poi" || !businessName) {
    return null;
  }

  const providerCategories = (result.poiTypes || [])
    .map((poiType) => String(poiType.name || poiType.id || "").trim())
    .filter(Boolean);
  const providerCategory = Array.from(new Set(providerCategories)).join(", ");
  const contacts = result.contacts || [];
  const phone = contacts.flatMap((contact) => contact.phones || []).map((value) => String(value || "").trim()).find(Boolean) || "";
  const website = contacts.flatMap((contact) => contact.websites || []).map((value) => String(value || "").trim()).find(Boolean) || "";
  const coordinates = result.position?.coordinates;

  return {
    provider: "tomtom",
    providerPlaceId: String(result.id || "").trim(),
    googlePlaceId: "",
    businessName,
    businessAddress: formatTomTomOrbisAddress(result),
    phone,
    website,
    latitude: Array.isArray(coordinates) && Number.isFinite(coordinates[1]) ? Number(coordinates[1]) : undefined,
    longitude: Array.isArray(coordinates) && Number.isFinite(coordinates[0]) ? Number(coordinates[0]) : undefined,
    providerCategory,
    municipality: String(result.address?.municipality || "").trim(),
    countrySubdivision: String(result.address?.countrySubdivision || "").trim(),
  };
}

export function mapTomTomLegacyPlace(result: TomTomLegacySearchResult): TomTomPlaceLead | null {
  const businessName = String(result.poi?.name || "").trim();

  if (result.type !== "POI" || !businessName) {
    return null;
  }

  const providerCategories = result.poi?.classifications
    ?.flatMap((classification) => classification.names || [])
    .map((name) => String(name.name || "").trim())
    .filter(Boolean) || [];

  return {
    provider: "tomtom",
    providerPlaceId: String(result.id || "").trim(),
    googlePlaceId: "",
    businessName,
    businessAddress: String(result.address?.freeformAddress || "").trim(),
    phone: String(result.poi?.phone || "").trim(),
    website: String(result.poi?.url || "").trim(),
    latitude: Number.isFinite(result.position?.lat) ? Number(result.position?.lat) : undefined,
    longitude: Number.isFinite(result.position?.lon) ? Number(result.position?.lon) : undefined,
    providerCategory: Array.from(new Set(providerCategories)).join(", "),
    municipality: String(result.address?.municipality || "").trim(),
    countrySubdivision: String(result.address?.countrySubdivision || "").trim(),
  };
}

async function searchTomTomDiscoverPoi(query: string, location: TomTomLocation | null, locationLabel: string, radiusMiles: number) {
  const normalizedQuery = query.trim();
  const queryWithLocation = !location && locationLabel ? `${normalizedQuery} in ${locationLabel}` : normalizedQuery;
  const radius = location && radiusMiles > 0
    ? Math.min(Math.round(radiusMiles * TOMTOM_METERS_PER_MILE), TOMTOM_MAX_RADIUS_METERS)
    : undefined;
  const coordinates = location ? [location.longitude, location.latitude] : null;
  const countryCodesIso2 = tomTomCountrySet().split(",").map((value) => value.trim()).filter(Boolean);
  const filters: Record<string, unknown> = {
    types: ["poi"],
    countryCodesIso2,
  };

  if (coordinates && radius) {
    filters.geometry = { type: "circle", center: coordinates, radiusInMeters: radius };
  }

  const payload = await requestTomTomOrbis<TomTomOrbisResponse>({
    pathname: "/maps/orbis/places/discover",
    product: "places-discover",
    apiVersion: "3",
    attributes: "results(id,type,title,subtitles,position,address,poiTypes,contacts)",
    method: "POST",
    body: {
      query: queryWithLocation,
      maxResults: tomTomResultLimit(),
      geopoliticalView: "Unified",
      ...(coordinates ? {
        origin: { type: "point", coordinates },
        preferences: { geometry: { type: "point", coordinates } },
      } : {}),
      filters,
    },
  });

  const places = (payload.results || []).map(mapTomTomOrbisPlace).filter((place): place is TomTomPlaceLead => Boolean(place));

  return {
    places,
    numResults: places.length,
    offset: 0,
    totalResults: places.length,
    exhausted: true,
  };
}

function cacheTomTomDetails(placeId: string, payload: TomTomOrbisDetailsResponse) {
  if (tomTomDetailsCache.size >= TOMTOM_DETAILS_CACHE_MAX_ENTRIES) {
    const oldestKey = tomTomDetailsCache.keys().next().value;
    if (oldestKey) tomTomDetailsCache.delete(oldestKey);
  }

  tomTomDetailsCache.set(placeId, {
    expiresAt: Date.now() + TOMTOM_DETAILS_CACHE_TTL_MS,
    payload,
  });
}

function getTomTomPoiDetails(placeId: string, sessionId: string) {
  const cachedDetails = tomTomDetailsCache.get(placeId);
  if (cachedDetails && cachedDetails.expiresAt > Date.now()) {
    return Promise.resolve(cachedDetails.payload);
  }
  if (cachedDetails) tomTomDetailsCache.delete(placeId);

  const inFlightDetails = tomTomDetailsInFlight.get(placeId);
  if (inFlightDetails) return inFlightDetails;

  const detailsRequest = requestTomTomOrbis<TomTomOrbisDetailsResponse>({
    pathname: `/maps/orbis/places/details/pois/${encodeURIComponent(placeId)}`,
    product: "places-details",
    apiVersion: "3",
    attributes: "id,type,title,subtitles,position,address,poiTypes,contacts",
    headers: { "Session-Id": sessionId },
  }).then((payload) => {
    cacheTomTomDetails(placeId, payload);
    return payload;
  }).finally(() => {
    tomTomDetailsInFlight.delete(placeId);
  });

  tomTomDetailsInFlight.set(placeId, detailsRequest);
  return detailsRequest;
}

export async function searchTomTomSuggestDetailsPoi(
  query: string,
  location: TomTomLocation | null,
  locationLabel: string,
  radiusMiles: number
) {
  const normalizedQuery = query.trim();
  const queryWithLocation = !location && locationLabel ? `${normalizedQuery} in ${locationLabel}` : normalizedQuery;
  const radius = location && radiusMiles > 0
    ? Math.min(Math.round(radiusMiles * TOMTOM_METERS_PER_MILE), TOMTOM_MAX_RADIUS_METERS)
    : undefined;
  const coordinates = location ? [location.longitude, location.latitude] : null;
  const countryCodesIso2 = tomTomCountrySet().split(",").map((value) => value.trim()).filter(Boolean);
  const filters: Record<string, unknown> = {
    types: ["poi"],
    countryCodesIso2,
  };
  const sessionId = randomUUID();

  if (coordinates && radius) {
    filters.geometry = { type: "circle", center: coordinates, radiusInMeters: radius };
  }

  const suggestions = await requestTomTomOrbis<TomTomOrbisResponse>({
    pathname: "/maps/orbis/places/suggest",
    product: "places-suggest",
    apiVersion: "3",
    attributes: "results",
    method: "POST",
    headers: { "Session-Id": sessionId },
    body: {
      query: queryWithLocation,
      maxResults: 10,
      geopoliticalView: "Unified",
      ...(coordinates ? {
        origin: { type: "point", coordinates },
        preferences: { geometry: { type: "point", coordinates } },
      } : {}),
      filters,
    },
  });
  const candidates = Array.from(new Map(
    (suggestions.results || [])
      .filter((result) => String(result.type || "").toLowerCase() === "poi" && String(result.id || "").trim())
      .map((result) => [String(result.id), result])
  ).values());

  if (candidates.length === 0) {
    return { places: [], numResults: 0, offset: 0, totalResults: 0, exhausted: true };
  }

  const detailResults = await Promise.allSettled(
    candidates.map((candidate) => getTomTomPoiDetails(String(candidate.id), sessionId))
  );
  const fulfilledDetails = detailResults
    .filter((result): result is PromiseFulfilledResult<TomTomOrbisDetailsResponse> => result.status === "fulfilled")
    .map((result) => result.value);

  if (fulfilledDetails.length === 0) {
    const usageError = detailResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
      .find((error) => error instanceof TomTomUsageLimitError);
    if (usageError) throw usageError;

    const transientError = detailResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
      .find(isTomTomTransientServiceError);
    if (transientError) throw transientError;
  }

  const places = fulfilledDetails.map(mapTomTomOrbisPlace).filter((place): place is TomTomPlaceLead => Boolean(place));
  return {
    places,
    numResults: places.length,
    offset: 0,
    totalResults: places.length,
    exhausted: true,
  };
}

async function searchTomTomLegacyPoi(
  query: string,
  location: TomTomLocation | null,
  locationLabel: string,
  radiusMiles: number,
  offset: number
) {
  const normalizedQuery = query.trim();
  const queryWithLocation = !location && locationLabel ? `${normalizedQuery} in ${locationLabel}` : normalizedQuery;
  const radius = location && radiusMiles > 0
    ? Math.min(Math.round(radiusMiles * TOMTOM_METERS_PER_MILE), TOMTOM_MAX_RADIUS_METERS)
    : undefined;
  const payload = await requestTomTomLegacy(`/search/2/poiSearch/${encodeURIComponent(queryWithLocation)}.json`, {
    limit: tomTomResultLimit(),
    countrySet: tomTomCountrySet(),
    typeahead: "false",
    ofs: offset,
    lat: location?.latitude,
    lon: location?.longitude,
    radius,
  });
  const places = (payload.results || []).map(mapTomTomLegacyPlace).filter((place): place is TomTomPlaceLead => Boolean(place));
  const numResults = Math.max(0, Number(payload.summary?.numResults ?? payload.results?.length ?? 0));
  const responseOffset = Math.max(0, Number(payload.summary?.offset ?? offset));
  const totalResults = Math.max(0, Number(payload.summary?.totalResults ?? 0));

  return {
    places,
    numResults,
    offset: responseOffset,
    totalResults,
    exhausted: numResults === 0 || numResults < tomTomResultLimit() || (totalResults > 0 && responseOffset + numResults >= totalResults),
  };
}

async function searchTomTomPoi(
  query: string,
  location: TomTomLocation | null,
  locationLabel: string,
  radiusMiles: number,
  offset: number
) {
  try {
    return await searchTomTomDiscoverPoi(query, location, locationLabel, radiusMiles);
  } catch (error) {
    if (!(error instanceof TomTomUsageLimitError)) throw error;
    try {
      return await searchTomTomLegacyPoi(query, location, locationLabel, radiusMiles, offset);
    } catch (legacyError) {
      if (!(legacyError instanceof TomTomUsageLimitError)) throw legacyError;
      return searchTomTomSuggestDetailsPoi(query, location, locationLabel, radiusMiles);
    }
  }
}

function placeDedupKey(place: TomTomPlaceLead) {
  const phone = place.phone.replace(/\D/g, "");
  if (phone.length >= 7) return `phone:${phone.slice(-10)}`;
  if (place.providerPlaceId) return `tomtom:${place.providerPlaceId}`;
  return `business:${place.businessName.toLowerCase()}|${place.businessAddress.toLowerCase()}`;
}

function hasCallablePhone(place: TomTomPlaceLead) {
  return place.phone.replace(/\D/g, "").length >= 7;
}

export async function searchTomTomPlaceQueries(input: {
  queries: string[];
  validationQuery?: string;
  location?: string;
  radiusMiles?: number;
  requestBudget?: number;
  targetCallablePlaces?: number;
}): Promise<TomTomSearchBatchResult> {
  const queries = Array.from(new Set(input.queries.map((query) => String(query || "").trim()).filter(Boolean)));
  const validationQuery = String(input.validationQuery || "").trim();
  if (
    queries.length === 0
    || queries.some((query) => !isSpecificTomTomSearchQuery(query))
    || (validationQuery && !isSpecificTomTomSearchQuery(validationQuery))
  ) {
    throw new TomTomSearchQueryError();
  }
  const locationLabel = String(input.location || "").trim();
  const radiusMiles = Math.min(Math.max(Number(input.radiusMiles || 0), 0), 50);
  const requestBudget = Math.min(Math.max(Math.round(Number(input.requestBudget || queries.length + (locationLabel ? 1 : 0))), 1), TOMTOM_MAX_REQUEST_BUDGET);
  const requestedTarget = Number(input.targetCallablePlaces);
  const targetCallablePlaces = Number.isFinite(requestedTarget) && requestedTarget > 0
    ? Math.min(Math.max(Math.round(requestedTarget), 1), 10000)
    : Number.POSITIVE_INFINITY;
  const resultLimit = tomTomResultLimit();
  const usageBefore = await getTomTomUsage();
  const placesByKey = new Map<string, TomTomPlaceLead>();
  const searchedQueries: string[] = [];
  const searchedLocations = new Set<string>();
  let requestsMade = 0;
  let businessRequestsMade = 0;
  let searchedPages = 0;
  let rejectedIrrelevantCount = 0;
  let limitReached = false;
  let providerInterrupted = false;
  let location: TomTomLocation | null = null;

  if (locationLabel) {
    try {
      location = await geocodeTomTomLocation(locationLabel);
      requestsMade += 1;
    } catch (error) {
      if (error instanceof TomTomUsageLimitError) {
        limitReached = true;
      } else if (isTomTomTransientServiceError(error)) {
        providerInterrupted = true;
      } else {
        throw error;
      }
    }
  }

  const expandedSearch = Number.isFinite(targetCallablePlaces) && targetCallablePlaces > resultLimit;
  const searchCenters: Array<{ location: TomTomLocation | null; locationLabel: string; radiusMiles: number }> = locationLabel
    ? location
      ? createLocalSearchCenters(location, locationLabel, radiusMiles, expandedSearch).map((center) => ({
        location: { latitude: center.latitude, longitude: center.longitude },
        locationLabel: center.label,
        radiusMiles: center.radiusMiles,
      }))
      : [{ location: null, locationLabel, radiusMiles }]
    : expandedSearch
      ? createNationalSearchCenters().map((center) => ({
        location: { latitude: center.latitude, longitude: center.longitude },
        locationLabel: center.label,
        radiusMiles: center.radiusMiles,
      }))
      : [{ location: null, locationLabel: "", radiusMiles }];
  const queryStates = searchCenters.flatMap((searchCenter) => queries.map((query) => ({
    ...searchCenter,
    query,
    offset: 0,
    exhausted: false,
  })));

  while (businessRequestsMade < requestBudget && !limitReached) {
    const callablePlaceCount = Array.from(placesByKey.values()).filter(hasCallablePhone).length;
    if (callablePlaceCount >= targetCallablePlaces) break;

    const activeQueries = queryStates
      .filter((queryState) => !queryState.exhausted)
      .slice(0, Math.min(TOMTOM_SEARCH_BATCH_SIZE, requestBudget - businessRequestsMade));

    if (activeQueries.length === 0) break;

    const pageResults = await Promise.allSettled(
      activeQueries.map(async (queryState) => ({
        queryState,
        page: await searchTomTomPoi(
          queryState.query,
          queryState.location,
          queryState.locationLabel,
          queryState.radiusMiles,
          queryState.offset
        ),
      }))
    );
    const pages: Array<Awaited<ReturnType<typeof searchTomTomPoi>> extends infer TPage
      ? { queryState: typeof activeQueries[number]; page: TPage }
      : never> = [];
    let transientFailureCount = 0;

    pageResults.forEach((pageResult, index) => {
      if (pageResult.status === "fulfilled") {
        pages.push(pageResult.value);
        return;
      }

      const queryState = activeQueries[index];
      if (pageResult.reason instanceof TomTomUsageLimitError) {
        limitReached = true;
        queryState.exhausted = true;
        return;
      }

      if (isTomTomTransientServiceError(pageResult.reason)) {
        providerInterrupted = true;
        transientFailureCount += 1;
        queryState.exhausted = true;
        return;
      }

      throw pageResult.reason;
    });

    if (pages.length > 0) {
      requestsMade += pages.length;
      businessRequestsMade += pages.length;
      searchedPages += pages.length;

      pages.forEach(({ queryState, page }) => {
        if (!searchedQueries.includes(queryState.query)) {
          searchedQueries.push(queryState.query);
        }

        if (queryState.locationLabel) {
          searchedLocations.add(queryState.locationLabel.replace(/ area \d+$/, ""));
        }

        page.places.forEach((place) => {
          const relevance = evaluateTomTomPlaceRelevance(place, queryState.query);
          const validationRelevance = validationQuery
            ? evaluateTomTomPlaceRelevance(place, validationQuery)
            : relevance;
          const locationMatches = location && radiusMiles > 0
            ? isTomTomPlaceWithinRadius(place, location, radiusMiles)
              && matchesTomTomRequestedRegion(place, locationLabel)
            : !locationLabel || matchesTomTomLocationLabel(place, locationLabel);

          if (!relevance.relevant || !validationRelevance.relevant || !locationMatches) {
            rejectedIrrelevantCount += 1;
            return;
          }

          const relevantPlace: TomTomPlaceLead = {
            ...place,
            matchedQuery: queryState.query,
            relevanceScore: Math.min(relevance.score, validationRelevance.score),
            relevanceReason: locationMatches ? validationRelevance.reason : "outside the requested location",
          };
          const dedupKey = placeDedupKey(relevantPlace);
          const existingPlace = placesByKey.get(dedupKey);

          if (!existingPlace || (relevantPlace.relevanceScore || 0) > (existingPlace.relevanceScore || 0)) {
            placesByKey.set(dedupKey, relevantPlace);
          }
        });
        const nextOffset = page.offset + page.numResults;
        queryState.offset = nextOffset;
        queryState.exhausted = page.exhausted
          || page.numResults === 0
          || page.numResults < resultLimit
          || (page.totalResults > 0 && nextOffset >= page.totalResults);
      });
    }

    if (pages.length === 0 && transientFailureCount > 0) break;
  }

  if (
    Number.isFinite(targetCallablePlaces)
    && Array.from(placesByKey.values()).filter(hasCallablePhone).length < targetCallablePlaces
    && businessRequestsMade >= requestBudget
  ) {
    limitReached = true;
  }

  const usage = await getTomTomUsage();

  return {
    places: Array.from(placesByKey.values()),
    searchedQueries,
    searchedPages,
    searchedLocations: Array.from(searchedLocations),
    requestCount: Math.max(requestsMade, usage.used - usageBefore.used),
    rejectedIrrelevantCount,
    limitReached: limitReached || providerInterrupted,
    usage,
  };
}
