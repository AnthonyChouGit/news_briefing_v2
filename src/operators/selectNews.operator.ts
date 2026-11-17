import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { type BriefNews, type NewsCategory, NewsCategorySchema } from "./common/BriefNews.schema.js";

/** Runtime configuration options accepted by the select news operator. */
export const SelectNewsOptionsSchema = z.object({
    /** Target number of top-ranked items to select per configured category; unconfigured categories are excluded. */
    select_count_by_category: z.partialRecord(NewsCategorySchema, z.coerce.number().int().positive()).default({}),
    /** Whether to log per-category input and selected item counts. */
    debug: z.boolean().default(false),
});
export type SelectNewsOptions = z.infer<typeof SelectNewsOptionsSchema>;

/** DAG input schema: `category -> (hash_id -> BriefNews)` ordered map to select from. */
const SelectNewsInputSchema = z.object({
    select_input_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type SelectNewsInput = z.infer<typeof SelectNewsInputSchema>;

/** DAG output schema: `category -> (hash_id -> BriefNews)` containing only configured categories and up to `n` items each. */
const SelectNewsOutputSchema = z.object({
    selected_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type SelectNewsOutput = z.infer<typeof SelectNewsOutputSchema>;

/**
 * Selects in place up to `n` items for each category explicitly configured in
 * `select_count_by_category`. Categories without a configured count are deleted
 * from the map rather than retained with a fallback limit.
 *
 * Errors propagate directly to LightDag's unified error handler.
 */
export default async function selectNews({ inputs, options }: OperatorArgs): Promise<OperatorOutput> {
    const { select_input_items } = inputs as SelectNewsInput;
    const { select_count_by_category, debug } = options as SelectNewsOptions;

    let inputCounts = "";
    if (debug) {
        inputCounts = Array.from(
            select_input_items.entries(),
            ([category, items]) => `${category}: ${items.size}`,
        ).join(", ");
    }

    for (const [category, items] of select_input_items.entries()) {
        const count = select_count_by_category[category];
        if (count === undefined || items.size === 0) {
            select_input_items.delete(category);
            continue;
        }
        if (items.size > count) {
            let index = 0;
            for (const hash_id of items.keys()) {
                if (index++ >= count) {
                    items.delete(hash_id);
                }
            }
        }
    }

    if (select_input_items.size === 0) {
        throw new Error("No news items selected across any category.");
    }

    if (debug) {
        const selectedCounts = Array.from(
            select_input_items.entries(),
            ([category, items]) => `${category}: ${items.size}`,
        ).join(", ");
        const totalSelected = Array.from(select_input_items.values()).reduce((sum, map) => sum + map.size, 0);
        console.log(`[SELECT] Input items per category: ${inputCounts}`);
        console.log(`[SELECT] Selected items per category: ${selectedCounts} (total: ${totalSelected})`);
    }

    const op_output: SelectNewsOutput = { selected_items: select_input_items };
    return { branch: "default", output: op_output };
}

/** LightDag operator that selects configured top-`n` news items per category. */
export class SelectNewsOperator extends Operator {
    /** Unique operator identifier within the DAG. */
    name: string = "select_news";
    /** Expected DAG input schema (`select_input_items`). */
    input_schema = SelectNewsInputSchema;
    /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
    output_schemas = { default: SelectNewsOutputSchema };
    /** Optional per-run configuration (`SelectNewsOptions`). */
    options_schema = SelectNewsOptionsSchema;
    /** Operator execution entrypoint. */
    exec = selectNews;
}
