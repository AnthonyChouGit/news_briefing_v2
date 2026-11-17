import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { BriefNewsRepository } from "../utils/db.js";
import { type BriefNews, type NewsCategory } from "./common/BriefNews.schema.js";

/** Runtime configuration options accepted by the save news operator. */
export const SaveNewsOptionsSchema = z.object({
    /** Whether to log per-category saved item counts. */
    debug: z.boolean().default(false),
});
export type SaveNewsOptions = z.infer<typeof SaveNewsOptionsSchema>;

/** DAG input schema: `category -> (hash_id -> BriefNews)` map to persist. */
const SaveNewsInputSchema = z.object({
    save_input_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type SaveNewsInput = z.infer<typeof SaveNewsInputSchema>;

/** DAG output schema: boolean completion flag (`saved`). */
const SaveNewsOutputSchema = z.object({
    saved: z.boolean().default(true),
});
type SaveNewsOutput = z.infer<typeof SaveNewsOutputSchema>;

/** DAG context requirements: repository backed by Kysely/PostgreSQL (`BriefNewsRepository`). */
const SaveNewsRequiresSchema = z.object({
    repository: z.instanceof(BriefNewsRepository),
});
type SaveNewsRequires = z.infer<typeof SaveNewsRequiresSchema>;

/**
 * Persists all news items across categories in a single batch insert using
 * `BriefNewsRepository.saveNew`, ignoring conflicts on existing records.
 *
 * Supports cooperative cancellation via LightDag's injected `signal` by
 * forwarding it to Kysely so in-flight PostgreSQL inserts cancel on abort.
 * Errors propagate directly to LightDag's unified error handler.
 */
export default async function saveNews({ inputs, requires, options, signal }: OperatorArgs): Promise<OperatorOutput> {
    const { save_input_items } = inputs as SaveNewsInput;
    const { repository } = requires as SaveNewsRequires;
    const { debug } = options as SaveNewsOptions;

    const allItems: BriefNews[] = [];
    const debugParts: string[] = [];

    for (const [category, items] of save_input_items.entries()) {
        if (debug) {
            debugParts.push(`${category}: ${items.size}`);
        }
        for (const item of items.values()) {
            allItems.push(item);
        }
    }

    await repository.saveNew(allItems, signal);

    if (debug) {
        console.log(`[SAVE] Items saved per category: ${debugParts.join(", ")} (total: ${allItems.length})`);
    }

    const op_output: SaveNewsOutput = { saved: true };
    return { branch: "default", output: op_output };
}

/** LightDag operator that persists briefed news items to PostgreSQL. */
export class SaveNewsOperator extends Operator {
    /** Unique operator identifier within the DAG. */
    name: string = "save_news";
    /** Expected DAG input schema (`save_input_items`). */
    input_schema = SaveNewsInputSchema;
    /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
    output_schemas = { default: SaveNewsOutputSchema };
    /** Required shared runtime resources (`repository`). */
    requires_schema = SaveNewsRequiresSchema;
    /** Optional per-run configuration (`SaveNewsOptions`). */
    options_schema = SaveNewsOptionsSchema;
    /** Operator execution entrypoint. */
    exec = saveNews;
}
