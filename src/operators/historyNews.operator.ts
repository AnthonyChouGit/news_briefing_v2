import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { BriefNewsRepository } from "../utils/db.js";
import { type BriefNews, type NewsCategory, NewsCategorySchema } from "./common/BriefNews.schema.js";

/** Runtime configuration options accepted by the history news operator. */
export const HistoryNewsOptionsSchema = z.object({
    /** Non-empty list of news categories to query from history. */
    categories: z.array(NewsCategorySchema).nonempty(),
    /** Lookback time window in hours for loading historical news items. */
    history_time_window_hours: z.coerce.number().positive().default(72),
    /** Whether to log per-category history item counts after querying. */
    debug: z.boolean().default(false),
});
export type HistoryNewsOptions = z.infer<typeof HistoryNewsOptionsSchema>;

/** DAG input schema: dummy start signal triggering the root history operator. */
const HistoryNewsInputSchema = z.object({
    start: z.unknown(),
});

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
 * Loads previously stored news items within `history_time_window_hours` for each
 * category configured in `options.categories` using `BriefNewsRepository`.
 *
 * Expects a dummy `start` input signal as a DAG root trigger.
 * Supports cooperative cancellation via LightDag's injected `signal`: forwards
 * `signal` to each Kysely query so in-flight PostgreSQL queries are cancelled
 * cleanly on abort.
 *
 * Errors propagate directly to LightDag's unified error handler instead of
 * routing through a dedicated `error` branch.
 */
export default async function historyNews({ requires, options, signal }: OperatorArgs): Promise<OperatorOutput> {
    const { repository } = requires as HistoryNewsRequires;
    const history_options = options as HistoryNewsOptions;
    const uniqueCategories = Array.from(new Set(history_options.categories));

    const entries = await Promise.all(
        uniqueCategories.map(async (category: NewsCategory): Promise<[NewsCategory, Map<string, BriefNews>]> => {
            const items = await repository.findRecentByHours(
                history_options.history_time_window_hours,
                category,
                signal,
            );
            const map = new Map<string, BriefNews>();
            for (const item of items) {
                map.set(item.hash_id, item);
            }
            return [category, map];
        }),
    );

    const history_items = new Map<NewsCategory, Map<string, BriefNews>>(entries);

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
    /** Expected DAG input schema (dummy `start` signal). */
    input_schema = HistoryNewsInputSchema;
    /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
    output_schemas = { default: HistoryNewsOutputSchema };
    /** Required shared runtime resources (`repository`). */
    requires_schema = HistoryNewsRequiresSchema;
    /** Runtime configuration (`HistoryNewsOptions`, including `categories`). */
    options_schema = HistoryNewsOptionsSchema;
    /** Operator execution entrypoint. */
    exec = historyNews;
}
