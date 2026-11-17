import dotenv from "dotenv";
import * as z from "zod";
import { NewsCategorySchema } from "./operators/common/BriefNews.schema.js";
import { ExportNewsOptionsSchema } from "./operators/exportNews.operator.js";
import { FetchOptionsSchema } from "./operators/fetchNews.operator.js";
import { FilterRecencyOptionsSchema } from "./operators/filterRecency.operator.js";
import { HistoryNewsOptionsSchema } from "./operators/historyNews.operator.js";
import { PruneNewsOptionsSchema } from "./operators/pruneNews.operator.js";
import { ReadOptionsSchema } from "./operators/readNews.operator.js";
import { SummarizeNewsOptionsSchema } from "./operators/summarizeNews.operator.js";
import { AIClientConfigSchema } from "./utils/ai.js";

/** PostgreSQL connection configuration schema. */
const DbConfigSchema = z.object({
    db_host: z.string().nonempty().default("localhost"),
    db_port: z.coerce.number().int().positive().default(5432),
    db_user: z.string().nonempty(),
    db_password: z.string(),
    db_name: z.string().nonempty(),
});
export type DBConfig = z.infer<typeof DbConfigSchema>;

const BooleanConfigSchema = z
    .union([
        z.boolean(),
        z
            .enum(["true", "false", "True", "False", "1", "0"])
            .transform((val) => val === "true" || val === "True" || val === "1"),
    ])
    .default(false);

const CategoriesConfigSchema = z
    .union([
        z
            .string()
            .nonempty()
            .transform((val) => val.split(",").map((s) => s.trim()).filter(Boolean)),
        z.array(z.string()),
    ])
    .pipe(z.array(NewsCategorySchema).nonempty());

const CategoryCountMapConfigSchema = z
    .union([
        z.string().transform((val, ctx) => {
            try {
                return JSON.parse(val) as unknown;
            } catch {
                ctx.addIssue({
                    code: "custom",
                    message: `Invalid JSON for category count map: ${val}`,
                });
                return z.NEVER;
            }
        }),
        z.record(z.string(), z.unknown()),
    ])
    .pipe(z.partialRecord(NewsCategorySchema, z.coerce.number().int().positive()));

/** Enabled categories and per-stage selection limits used across the DAG pipeline. */
const SelectStageConfigSchema = z.object({
    categories: CategoriesConfigSchema,
    pre_read_select_count_by_category: CategoryCountMapConfigSchema,
    pre_summarize_select_count_by_category: CategoryCountMapConfigSchema,
    post_summarize_select_count_by_category: CategoryCountMapConfigSchema,
});

/** Cron schedule settings for daemon execution (`cron_main`). */
const CronConfigSchema = z.object({
    cron_expr: z.string().nonempty().optional(),
    time_zone: z.string().nonempty().optional(),
});

/** Top-level DAG execution settings. */
const DagConfigSchema = z.object({
    dag_timeout: z.coerce.number().positive().optional(),
    debug: BooleanConfigSchema,
});

/** Unified runtime configuration schema validated from `.env` or environment objects. */
export const ConfigSchema = DbConfigSchema
    .and(AIClientConfigSchema)
    .and(FetchOptionsSchema.omit({ categories: true, debug: true }))
    .and(HistoryNewsOptionsSchema.omit({ categories: true, debug: true }))
    .and(PruneNewsOptionsSchema.omit({ debug: true }))
    .and(ReadOptionsSchema.omit({ debug: true }))
    .and(FilterRecencyOptionsSchema.omit({ debug: true }))
    .and(SummarizeNewsOptionsSchema.omit({ debug: true }))
    .and(ExportNewsOptionsSchema.omit({ debug: true }))
    .and(SelectStageConfigSchema)
    .and(CronConfigSchema)
    .and(DagConfigSchema);

export type Config = z.infer<typeof ConfigSchema>;

/** Loads and validates configuration from an `.env` file path. */
export const loadConfig = (config_path: string = "./.env"): Config => {
    const { parsed, error } = dotenv.config({ path: config_path });
    if (error) {
        throw error;
    }
    return ConfigSchema.parse(parsed);
};
