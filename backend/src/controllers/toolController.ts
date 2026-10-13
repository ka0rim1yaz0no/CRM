import type { Request, Response } from "express";
import { Tool, type ToolDocument } from "../models/Tool";
import { runForEachBusiness } from "../config/tenancy";

const defaultTools = [
  { name: "Google Workspace", link: "https://workspace.google.com", branches: ["Assistly HQ"] },
  { name: "Stripe", link: "https://stripe.com", branches: ["Finance"] },
  { name: "CRM Admin", link: "", branches: ["Assistly HQ", "Sales Branch"] },
];

async function ensureDefaultTools() {
  const count = await Tool.countDocuments();

  if (count > 0) return;

  await Tool.insertMany(defaultTools);
}

function getToolInput(request: Request) {
  return {
    name: request.body.name,
    link: request.body.link || "",
    branches: Array.isArray(request.body.branches) ? request.body.branches.map(String).filter(Boolean) : [],
  };
}

export async function listTools(_request: Request, response: Response) {
  await ensureDefaultTools();

  const toolMap = new Map<string, ToolDocument & { _id?: unknown }>();

  await runForEachBusiness(async () => {
    try {
      const businessTools = await Tool.find({ isArchived: false }).lean();
      for (const tool of businessTools) {
        const key = String(tool.name || "").trim().toLowerCase();
        if (key && !toolMap.has(key)) {
          toolMap.set(key, tool);
        }
      }
    } catch {
      // Continue to next business
    }
  });

  if (toolMap.size === 0) {
    const currentTools = await Tool.find({ isArchived: false }).lean();
    for (const tool of currentTools) {
      const key = String(tool.name || "").trim().toLowerCase();
      if (key && !toolMap.has(key)) {
        toolMap.set(key, tool);
      }
    }
  }

  const tools = Array.from(toolMap.values()).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" })
  );
  response.json(tools);
}

export async function createTool(request: Request, response: Response) {
  const input = getToolInput(request);

  if (!input.name?.trim()) {
    response.status(400).json({ message: "name is required" });
    return;
  }

  const tool = await Tool.create(input);
  response.status(201).json(tool);
}

export async function updateTool(request: Request, response: Response) {
  const tool = await Tool.findByIdAndUpdate(request.params.id, getToolInput(request), {
    returnDocument: "after",
    runValidators: true,
  });

  if (!tool) {
    response.status(404).json({ message: "Tool not found" });
    return;
  }

  response.json(tool);
}

export async function archiveTool(request: Request, response: Response) {
  const tool = await Tool.findByIdAndUpdate(
    request.params.id,
    { isArchived: true },
    { returnDocument: "after", runValidators: true }
  );

  if (!tool) {
    response.status(404).json({ message: "Tool not found" });
    return;
  }

  response.json(tool);
}
