import path from "node:path";

// An explicit root lets local fixture runs keep generated files away from real uploads.
export const configuredUploadRoot = process.env.CRM_UPLOAD_ROOT?.trim();
export const uploadRoot = path.resolve(configuredUploadRoot || path.join(process.cwd(), "uploads"));
