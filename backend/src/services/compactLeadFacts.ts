import type { PipelineStage } from "mongoose";

export type CompactLeadFact = { p: number; v: unknown[] };

export function compactLeadFactsStage(fields: readonly string[]): PipelineStage.Project {
    if (!fields.length || fields.length > 24 || new Set(fields).size !== fields.length ||
        fields.some(field => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))) throw new Error("INVALID_COMPACT_FACT_FIELDS");
    // The presence mask distinguishes an absent field from an explicit null.
    return { $project: { _id: 0,
        p: { $sum: fields.map((field, index) => ({ $cond: [{ $ne: [{ $type: `$${field}` }, "missing"] }, 2 ** index, 0] })) },
        v: fields.map(field => `$${field}`),
    } };
}

export function expandCompactLeadFacts<T>(rows: readonly CompactLeadFact[], fields: readonly string[]): T[] {
    return rows.map(row => expandCompactLeadFact<T>(row, fields));
}

function expandCompactLeadFact<T>(row: CompactLeadFact, fields: readonly string[]): T {
    if (!Number.isInteger(row.p) || row.p < 0 || row.p >= 2 ** fields.length || !Array.isArray(row.v) || row.v.length !== fields.length) {
        throw new Error("INVALID_COMPACT_LEAD_FACT");
    }
    const value: Record<string, unknown> = {};
    fields.forEach((field, index) => { if (row.p & 2 ** index) value[field] = row.v[index]; });
    return value as T;
}

export const compactLeadFactBatchSize = 1024;

export async function readCompactLeadFacts<T>(cursor: AsyncIterable<CompactLeadFact> & { close(): Promise<unknown> }, fields: readonly string[]): Promise<T[]> {
    const rows: T[] = [];
    try {
        for await (const row of cursor) rows.push(expandCompactLeadFact<T>(row, fields));
    } catch (error) { await cursor.close().catch(() => undefined); throw error; }
    await cursor.close();
    return rows;
}
