import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import {
  getLocalTomTomUsage,
  getTomTomQuotaBrokerSecret,
  reserveLocalTomTomRequest,
  type TomTomQuotaProduct,
} from "../services/tomTomSearchService";

function requestedProduct(request: Request): TomTomQuotaProduct {
  const product = String(request.query.product || "").trim();
  if (
    product === "geocoding"
    || product === "search"
    || product === "places-suggest"
    || product === "places-details"
  ) return product;
  return "places-discover";
}

function isAuthorizedQuotaBrokerRequest(request: Request) {
  const expectedSecret = getTomTomQuotaBrokerSecret();
  const providedSecret = String(request.header("x-tomtom-quota-secret") || "").trim();

  if (!expectedSecret || !providedSecret) return false;

  const expectedBuffer = Buffer.from(expectedSecret);
  const providedBuffer = Buffer.from(providedSecret);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireQuotaBrokerAccess(request: Request, response: Response) {
  if (isAuthorizedQuotaBrokerRequest(request)) return true;

  response.status(401).json({ message: "Invalid quota service credentials." });
  return false;
}

export async function readSharedTomTomUsage(request: Request, response: Response) {
  if (!requireQuotaBrokerAccess(request, response)) return;
  response.json(await getLocalTomTomUsage());
}

export async function reserveSharedTomTomRequest(request: Request, response: Response) {
  if (!requireQuotaBrokerAccess(request, response)) return;
  await reserveLocalTomTomRequest(requestedProduct(request));
  response.json(await getLocalTomTomUsage());
}
