import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { Piscina } from "piscina";
import { type BriefNews, NewsCategorySchema, type NewsCategory } from "./common/BriefNews.schema.js";

/** Runtime configuration options accepted by the fetch operator and worker. */
export const FetchOptionsSchema = z.object({
    /** Non-empty list of news categories to fetch. */
    categories: z.array(NewsCategorySchema).nonempty(),
    /** Per-request HTTP timeout in milliseconds (overrides worker default). */
    fetch_timeout: z.coerce.number().int().nonnegative().optional(),
    /** Max Google News redirect URLs to decode per RSS feed. */
    fetch_max_decode_items: z.coerce.number().int().nonnegative().optional(),
    /** Custom HTTP User-Agent string sent with fetch requests. */
    fetch_user_agent: z.string().nonempty().optional(),
    /** Whether to log per-category fetch counts after completion. */
    debug: z.boolean().default(false),
});
export type FetchOptions = z.infer<typeof FetchOptionsSchema>;

/** DAG input schema: dummy start signal triggering the root fetch operator. */
const FetchNewsInputSchema = z.object({
    start: z.unknown(),
});

/** DAG output schema: `category -> (hash_id -> BriefNews)` nested map. */
const FetchNewsOutputSchema = z.object({
    fetched_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type FetchNewsOutput = z.infer<typeof FetchNewsOutputSchema>;

/** DAG context requirements: shared Piscina worker pool for off-thread scraping. */
const FetchNewsRequiresSchema = z.object({
    thread_pool: z.instanceof(Piscina),
});
type FetchNewsRequires = z.infer<typeof FetchNewsRequiresSchema>;

/**
 * Concurrently fetches news headlines across all categories configured in
 * `options.categories` using the Piscina worker pool (`./worker/_fetch.js`).
 *
 * Expects a dummy `start` input signal as a DAG root trigger.
 * Supports cooperative cancellation via LightDag's injected `signal`: forwards
 * `signal` to Piscina so queued or running worker tasks terminate on abort, and
 * stops before result aggregation.
 *
 * Per-category rejections are logged so other categories can still succeed;
 * throws directly when `categories` is empty or every category fails, allowing
 * LightDag's unified error handler to catch and route the failure.
 */
export default async function fetchNews({ requires, options, signal }: OperatorArgs): Promise<OperatorOutput> {
    // Unpack injected worker pool and runtime options
    const { thread_pool } = requires as FetchNewsRequires;
    const fetch_options = options as FetchOptions;
    const uniqueCategories = Array.from(new Set(fetch_options.categories));

    // Dispatch one worker task per category; forward `signal` so Piscina cancels queued/running workers on abort
    const workerFilename = new URL("./worker/_fetch.js", import.meta.url).href;
    const tasks = uniqueCategories.map((category: NewsCategory) =>
        thread_pool.run(
            { category, options: fetch_options },
            { name: "fetchNewsByCategory", filename: workerFilename, signal: signal ?? null },
        )
    );

    // Wait for all categories to settle so one failing category doesn't abort the rest
    const results = await Promise.allSettled(tasks);
    // Propagate cooperative cancellation directly instead of logging worker AbortErrors as category failures
    signal?.throwIfAborted();

    const all_categories = new Map<NewsCategory, Map<string, BriefNews>>();

    for (let i = 0; i < uniqueCategories.length; i++) {
        const result = results[i]!;
        const category: NewsCategory = uniqueCategories[i]!;

        if (result.status === "rejected") {
            // Isolate partial failures: log the failing category and continue aggregating
            console.error(`[FETCH] Category "${category}" failed:`, result.reason);
            continue;
        }

        const category_items = result.value as Map<string, BriefNews>;
        if (category_items.size > 0) {
            all_categories.set(category, category_items);
        }
    }

    // Fail the entire operator only when no category produced results (handled by LightDag)
    if (all_categories.size === 0) {
        throw new Error("All categories failed to fetch.");
    }

    if (fetch_options?.debug) {
        const categoryCounts = Array.from(
            all_categories.entries(),
            ([category, items]) => `${category}: ${items.size}`,
        ).join(", ");
        const total = Array.from(all_categories.values()).reduce((sum, map) => sum + map.size, 0);
        console.log(`[FETCH] Items fetched per category: ${categoryCounts} (total: ${total})`);
    }

    const op_output: FetchNewsOutput = { fetched_items: all_categories };
    return { branch: "default", output: op_output };
}

/** LightDag operator for stage 1: fetching news items per category. */
export class FetchNewsOperator extends Operator {
    /** Unique operator identifier within the DAG. */
    name: string = "fetch_news";
    /** Expected DAG input schema (dummy `start` signal). */
    input_schema = FetchNewsInputSchema;
    /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
    output_schemas = { default: FetchNewsOutputSchema };
    /** Required shared runtime resources (`thread_pool`). */
    requires_schema = FetchNewsRequiresSchema;
    /** Runtime configuration (`FetchOptions`, including `categories`). */
    options_schema = FetchOptionsSchema;
    /** Operator execution entrypoint. */
    exec = fetchNews;
}
