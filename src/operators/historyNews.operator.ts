import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { BriefNewsRepository } from "../utils/db.js";
import { type BriefNews, type NewsCategory, NewsCategorySchema } from "./common/BriefNews.schema.js";

/** Runtime configuration options accepted by the history news operator. */
export const HistoryNewsOptionsSchema = z.object({
    /** Lookback time window in hours for loading historical news items. */
    history_time_window_hours: z.coerce.number().positive().default(72),
    /** Whether to log per-category history item counts after querying. */
    debug: z.boolean().default(false),
});
export type HistoryNewsOptions = z.infer<typeof HistoryNewsOptionsSchema>;

/** DAG input schema: non-empty list of news categories to query from history. */
const HistoryNewsInputSchema = z.object({
    categories: z.array(NewsCategorySchema).nonempty(),
});
type HistoryNewsInput = z.infer<typeof HistoryNewsInputSchema>;

/** DAG output schema: `category -> (hash_id -> BriefNews)` nested map of recent historical items. */
const HistoryNewsOutputSchema = z.object({
    history_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type HistoryNewsOutput = z.infer<typeof HistoryNewsOutputSchema>;

/** DAG context requirements: repository backed by Kysely/PostgreSQL (`BriefNewsRepository`). */
const HistoryNewsRequiresSchema = z.object({
    repository: z.instanceof(BriefNewsRepository),
});
type HistoryNewsRequires = z.infer<typeof HistoryNewsRequiresSchema>;

/**
 * Loads previously stored news items within the configured lookback window
 * (`history_time_window_hours`) for each requested category using `BriefNewsRepository`.
 *
 * Supports cooperative cancellation via LightDag's injected `signal`: checks
 * abort state up front and forwards `signal` to each Kysely query so in-flight
 * PostgreSQL queries are cancelled cleanly on abort.
 *
 * Errors propagate directly to LightDag's unified error handler instead of
 * routing through a dedicated `error` branch.
 */
export default async function historyNews({ inputs, requires, options, signal }: OperatorArgs): Promise<OperatorOutput> {
    signal?.throwIfAborted();

    const { categories } = inputs as HistoryNewsInput;
    const { repository } = requires as HistoryNewsRequires;
    const history_options = options as HistoryNewsOptions;

    if (categories.length === 0) {
        throw new Error("Categories array cannot be empty.");
    }

    const uniqueCategories = Array.from(new Set(categories));

    const categoryResults = await Promise.all(
        uniqueCategories.map(async (category: NewsCategory): Promise<Map<string, BriefNews>> => {
            const items = await repository.findRecentByHours(
                history_options.history_time_window_hours,
                category,
                signal,
            );
            return new Map<string, BriefNews>(items.map((item) => [item.hash_id, item]));
        }),
    );

    signal?.throwIfAborted();

    const history_items = new Map<NewsCategory, Map<string, BriefNews>>();
    for (let i = 0; i < uniqueCategories.length; i++) {
        history_items.set(uniqueCategories[i]!, categoryResults[i]!);
    }

    if (history_options?.debug) {
        const categoryCounts = Array.from(
            history_items.entries(),
            ([category, items]) => `${category}: ${items.size}`,
        ).join(", ");
        const total = Array.from(history_items.values()).reduce((sum, map) => sum + map.size, 0);
        console.log(`[HISTORY] Items loaded per category: ${categoryCounts} (total: ${total})`);
    }

    const op_output: HistoryNewsOutput = { history_items };
    return { branch: "default", output: op_output };
}

/** LightDag operator for loading recent historical news items for deduplication. */
export class HistoryNewsOperator extends Operator {
    /** Unique operator identifier within the DAG. */
    name: string = "history_news";
    /** Expected DAG input schema (`categories`). */
    input_schema = HistoryNewsInputSchema;
    /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
    output_schemas = { default: HistoryNewsOutputSchema };
    /** Required shared runtime resources (`repository`). */
    requires_schema = HistoryNewsRequiresSchema;
    /** Optional per-run configuration (`HistoryNewsOptions`). */
    options_schema = HistoryNewsOptionsSchema;
    /** Operator execution entrypoint. */
    exec = historyNews;
}
