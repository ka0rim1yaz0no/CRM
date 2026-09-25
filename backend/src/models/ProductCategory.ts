import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type ProductCategoryDocument = {
  name: string;
  description: string;
  isArchived: boolean;
};

const productCategorySchema = new Schema<ProductCategoryDocument>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true, default: "" },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const ProductCategory = tenantModel<ProductCategoryDocument>("ProductCategory", productCategorySchema);
