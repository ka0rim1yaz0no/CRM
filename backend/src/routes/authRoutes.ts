import { Router } from "express";
import { listEmployeeBusinesses, loginWithEmployeeCode, logoutEmployee, switchEmployeeBusiness } from "../controllers/authController";

export const authRouter = Router();

authRouter.post("/login", loginWithEmployeeCode);
authRouter.get("/businesses", listEmployeeBusinesses);
authRouter.post("/switch-business", switchEmployeeBusiness);
authRouter.post("/logout", logoutEmployee);
