import { getBusinessById } from "../config/tenancy";
import { getBusinessAccessForEmployeeCode, normalizeBusinessAccessIds } from "../models/BusinessUserAccess";
import { getCallBridgeDeviceModel, getCallBridgePairingModel } from "../models/CallBridge";

export function selectCallBridgeBusinessIds(
  assignedBusinessIds: string[],
  fallbackBusinessIds: string[],
  isConfigured: (businessId: string) => boolean,
) {
  const sourceIds = assignedBusinessIds.length > 0 ? assignedBusinessIds : fallbackBusinessIds;
  return normalizeBusinessAccessIds(sourceIds).filter(isConfigured);
}

export async function resolveCallBridgeBusinessIds(employeeCode: string, fallbackBusinessIds: string[] = []) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();
  if (!normalizedEmployeeCode) return [];

  const assignedBusinessIds = await getBusinessAccessForEmployeeCode(normalizedEmployeeCode);
  return selectCallBridgeBusinessIds(
    assignedBusinessIds,
    fallbackBusinessIds,
    (businessId) => Boolean(getBusinessById(businessId)),
  );
}

export async function syncCallBridgeBusinessIds(employeeCode: string, fallbackBusinessIds: string[] = []) {
  const businessIds = await resolveCallBridgeBusinessIds(employeeCode, fallbackBusinessIds);
  if (!employeeCode || businessIds.length === 0) return businessIds;

  await Promise.all([
    getCallBridgeDeviceModel().updateMany({ employeeCode }, { $set: { businessIds } }),
    getCallBridgePairingModel().updateMany({ employeeCode }, { $set: { businessIds } }),
  ]);

  return businessIds;
}
