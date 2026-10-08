import { Router } from "express";
import {
  clearBrowserActivityData,
  createBrowserActivityEvents,
  createBrowserActivityScreenshot,
  downloadBrowserActivityExtension,
  downloadLiveViewAgent,
  getBrowserActivityTrackingStatus,
  listBrowserActivityEvents,
  listBrowserActivityScreenshots,
  serveBrowserActivityScreenshotFile,
} from "../controllers/browserActivityController";

export const browserActivityRouter = Router();

browserActivityRouter.post("/events/bulk", createBrowserActivityEvents);
browserActivityRouter.post("/screenshots", createBrowserActivityScreenshot);
browserActivityRouter.get("/tracking-status", getBrowserActivityTrackingStatus);
browserActivityRouter.get("/events", listBrowserActivityEvents);
browserActivityRouter.get("/screenshots/file/:dateKey/:fileName", serveBrowserActivityScreenshotFile);
browserActivityRouter.get("/screenshots", listBrowserActivityScreenshots);
browserActivityRouter.get("/extension-package", downloadBrowserActivityExtension);
browserActivityRouter.get("/live-view-agent-package", downloadLiveViewAgent);
browserActivityRouter.delete("/", clearBrowserActivityData);
