import type { Request, Response } from "express";
import { ProductCategory } from "../models/ProductCategory";

const defaultProductCategories = ["Website", "CRM", "Support", "Consulting"];

async function ensureDefaultProductCategories() {
  const count = await ProductCategory.countDocuments();

  if (count > 0) {
    return;
  }

  await ProductCategory.insertMany(defaultProductCategories.map((name) => ({ name })));
}

export async function listProductCategories(_request: Request, response: Response) {
  await ensureDefaultProductCategories();
  const categories = await ProductCategory.find({ isArchived: false }).sort({ name: 1 });
  response.json(categories);
}

export async function createProductCategory(request: Request, response: Response) {
  const category = await ProductCategory.create({
    name: request.body.name,
    description: request.body.description || "",
  });

  response.status(201).json(category);
}

export async function updateProductCategory(request: Request, response: Response) {
  const category = await ProductCategory.findByIdAndUpdate(
    request.params.id,
    {
      name: request.body.name,
      description: request.body.description || "",
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!category) {
    response.status(404).json({ message: "Product category not found" });
    return;
  }

  response.json(category);
}

export async function archiveProductCategory(request: Request, response: Response) {
  const category = await ProductCategory.findByIdAndUpdate(
    request.params.id,
    { isArchived: true },
    { returnDocument: "after", runValidators: true }
  );

  if (!category) {
    response.status(404).json({ message: "Product category not found" });
    return;
  }

  response.json(category);
}
