import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { type BriefNews, type NewsCategory } from "./common/BriefNews.schema.js";

/** Runtime configuration options accepted by the recency filter operator. */
export const FilterRecencyOptionsSchema = z.object({
    /** Maximum allowed article age in hours relative to current time. */
    filter_recency_td_hours: z.coerce.number().positive().default(24),
    /** Whether to log per-category filtered and remaining item counts. */
    debug: z.boolean().default(false),
});
export type FilterRecencyOptions = z.infer<typeof FilterRecencyOptionsSchema>;

/** DAG input schema: `category -> (hash_id -> BriefNews)` map to filter by recency. */
const FilterRecencyInputSchema = z.object({
    filter_recency_input_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type FilterRecencyInput = z.infer<typeof FilterRecencyInputSchema>;

/** DAG output schema: `category -> (hash_id -> BriefNews)` containing only items within the recency window. */
const FilterRecencyOutputSchema = z.object({
    filtered_recency_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type FilterRecencyOutput = z.infer<typeof FilterRecencyOutputSchema>;

/**
 * Filters out news items in place whose `source_date` is missing, invalid, or
 * falls outside the configured recency window (`filter_recency_td_hours` hours
 * before now), preserving item order.
 *
 * Errors propagate directly to LightDag's unified error handler.
 */
export default async function filterRecency({ inputs, options }: OperatorArgs): Promise<OperatorOutput> {
    const { filter_recency_input_items } = inputs as FilterRecencyInput;
    const { filter_recency_td_hours, debug } = options as FilterRecencyOptions;

    const earliestMs = Date.now() - filter_recency_td_hours * 60 * 60 * 1000;
    let filteredCount = 0;

    for (const [category, items] of filter_recency_input_items.entries()) {
        for (const [hash_id, item] of items.entries()) {
            const sourceTime = item.source_date?.getTime();
            if (sourceTime === undefined || Number.isNaN(sourceTime) || sourceTime < earliestMs) {
                items.delete(hash_id);
                filteredCount++;
            }
        }
        if (items.size === 0) {
            filter_recency_input_items.delete(category);
        }
    }

    if (filter_recency_input_items.size === 0) {
        throw new Error("No news items remaining after recency filtering.");
    }

    if (debug) {
        const remaining = Array.from(filter_recency_input_items.values()).reduce((sum, map) => sum + map.size, 0);
        const remainingCounts = Array.from(
            filter_recency_input_items.entries(),
            ([category, items]) => `${category}: ${items.size}`,
        ).join(", ");
        console.log(
            `[FILTER RECENCY] Filtered ${filteredCount} items older than ${filter_recency_td_hours} hours (remaining: ${remaining}, per category: ${remainingCounts})`,
        );
    }

    const op_output: FilterRecencyOutput = { filtered_recency_items: filter_recency_input_items };
    return { branch: "default", output: op_output };
}

/** LightDag operator that drops articles older than the configured recency threshold. */
export class FilterRecencyOperator extends Operator {
    /** Unique operator identifier within the DAG. */
    name: string = "filter_recency";
    /** Expected DAG input schema (`filter_recency_input_items`). */
    input_schema = FilterRecencyInputSchema;
    /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
    output_schemas = { default: FilterRecencyOutputSchema };
    /** Optional per-run configuration (`FilterRecencyOptions`). */
    options_schema = FilterRecencyOptionsSchema;
    /** Operator execution entrypoint. */
    exec = filterRecency;
}
