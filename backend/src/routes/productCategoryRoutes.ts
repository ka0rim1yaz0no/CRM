import { Router } from "express";
import {
  archiveProductCategory,
  createProductCategory,
  listProductCategories,
  updateProductCategory,
} from "../controllers/productCategoryController";

export const productCategoryRouter = Router();

productCategoryRouter.get("/", listProductCategories);
productCategoryRouter.post("/", createProductCategory);
productCategoryRouter.put("/:id", updateProductCategory);
productCategoryRouter.patch("/:id/archive", archiveProductCategory);
