import crypto from "node:crypto";
import type { CallBridgeDeviceDocument } from "../models/CallBridge";

export const NATIVE_DIAL_PROTOCOL = 1;
export const nativeSecretHash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export function supportsNativeDial(device: Pick<CallBridgeDeviceDocument, "bridgeVersion" | "nativeDialProtocol">) {
  return device.bridgeVersion === "0.5.0" && device.nativeDialProtocol === NATIVE_DIAL_PROTOCOL;
}

export function boundNativeDevice<T extends CallBridgeDeviceDocument>(devices: T[], business: string, key: string, session: string) {
  if (key.length < 24 || key.length > 200 || session.length < 16 || session.length > 120) return undefined;
  return devices.find(device => supportsNativeDial(device) && device.accountSwitchingEnabled &&
    device.businessIds.includes(business) && device.browserDeviceKeyHash === nativeSecretHash(key) && device.browserSessionId === session);
}
