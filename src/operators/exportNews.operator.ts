import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { type BriefNews, type NewsCategory } from "./common/BriefNews.schema.js";
import { LanguageSchema } from "./common/Language.schema.js";

/** Exported item representation with `raw` article body excluded to keep JSON output concise. */
type ExportedBriefNews = Omit<BriefNews, "raw">;

/** Runtime configuration options accepted by the export news operator. */
export const ExportNewsOptionsSchema = z.object({
    /** Target directory path where `latest_<language>.json` and `previous_<language>.json` are written. */
    export_dir: z.string().nonempty(),
    /** Output briefing language reflected in exported filenames (`latest_<language>.json`). */
    language: LanguageSchema.default("English"),
    /** Whether to log per-category exported item counts and output file paths. */
    debug: z.boolean().default(false),
});
export type ExportNewsOptions = z.infer<typeof ExportNewsOptionsSchema>;

/** DAG input schema: `category -> (hash_id -> BriefNews)` map to export as JSON. */
const ExportNewsInputSchema = z.object({
    export_input_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type ExportNewsInput = z.infer<typeof ExportNewsInputSchema>;

/** DAG output schema: boolean completion flag (`exported`). */
const ExportNewsOutputSchema = z.object({
    exported: z.boolean().default(true),
});
type ExportNewsOutput = z.infer<typeof ExportNewsOutputSchema>;

function isEnoentError(err: unknown): boolean {
    return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/**
 * Exports news items as structured JSON to `<export_dir>/latest_<language>.json`,
 * including an outer `exported_at` ISO timestamp and ordered item arrays per category.
 *
 * Uses a staging temp file before rotating any existing `latest_<language>.json`
 * to `previous_<language>.json` (overwriting any prior `previous_<language>.json`),
 * ensuring existing files are never lost on write errors or cooperative abort via `signal`.
 * Errors propagate directly to LightDag's unified error handler.
 */
export default async function exportNews({ inputs, options, signal }: OperatorArgs): Promise<OperatorOutput> {
    const { export_input_items } = inputs as ExportNewsInput;
    const { export_dir, language, debug } = options as ExportNewsOptions;

    const exportedCategories: Partial<Record<NewsCategory, ExportedBriefNews[]>> = {};
    const debugParts: string[] = [];
    let totalExported = 0;

    for (const [category, items] of export_input_items.entries()) {
        const list: ExportedBriefNews[] = [];
        for (const item of items.values()) {
            const { raw: _raw, ...rest } = item;
            list.push(rest);
        }
        exportedCategories[category] = list;
        totalExported += list.length;
        if (debug) {
            debugParts.push(`${category}: ${list.length}`);
        }
    }

    const payload = {
        exported_at: new Date().toISOString(),
        items: exportedCategories,
    };

    const langSuffix = language.toLowerCase();
    const latestFilename = `latest_${langSuffix}.json`;
    const previousFilename = `previous_${langSuffix}.json`;

    const targetDir = path.resolve(export_dir);
    const latestPath = path.join(targetDir, latestFilename);
    const previousPath = path.join(targetDir, previousFilename);
    const tempPath = path.join(targetDir, `.${latestFilename}.${randomUUID()}.tmp`);

    await mkdir(targetDir, { recursive: true });

    try {
        // Stage new content first so existing `latest_*.json` / `previous_*.json` stay intact on abort or write failure
        await writeFile(
            tempPath,
            JSON.stringify(payload, null, 2),
            signal ? { encoding: "utf8", signal } : "utf8",
        );

        try {
            await rename(latestPath, previousPath);
        } catch (err) {
            if (!isEnoentError(err)) {
                throw err;
            }
        }

        await rename(tempPath, latestPath);
    } catch (err) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw err;
    }

    if (debug) {
        console.log(`[EXPORT] Exported to ${latestPath} (${debugParts.join(", ")}, total: ${totalExported})`);
    }

    const op_output: ExportNewsOutput = { exported: true };
    return { branch: "default", output: op_output };
}

/** LightDag operator that exports news items to JSON files with `latest.json` / `previous.json` rotation. */
export class ExportNewsOperator extends Operator {
    /** Unique operator identifier within the DAG. */
    name: string = "export_news";
    /** Expected DAG input schema (`export_input_items`). */
    input_schema = ExportNewsInputSchema;
    /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
    output_schemas = { default: ExportNewsOutputSchema };
    /** Optional per-run configuration (`ExportNewsOptions`). */
    options_schema = ExportNewsOptionsSchema;
    /** Operator execution entrypoint. */
    exec = exportNews;
}
