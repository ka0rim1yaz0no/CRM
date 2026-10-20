import { Router } from "express";
import { authenticateLegacyAuthRoute } from "../middleware/legacyAuthentication";
import { listEmployeeBusinesses, loginWithEmployeeCode, logoutEmployee, switchEmployeeBusiness } from "../controllers/authController";
import { clearFileSession } from "../middleware/securityFileSession";

export const authRouter = Router();

authRouter.post("/login", loginWithEmployeeCode);
authRouter.get("/businesses", authenticateLegacyAuthRoute, listEmployeeBusinesses);
authRouter.post("/switch-business", authenticateLegacyAuthRoute, switchEmployeeBusiness);
authRouter.post("/logout", authenticateLegacyAuthRoute, logoutEmployee);
authRouter.post("/file-session/logout", (_request, response) => { clearFileSession(response); response.json({ success: true }); });
