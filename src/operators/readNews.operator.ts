import { type OperatorArgs, type OperatorOutput, Operator } from "light-dag";
import * as z from "zod";
import { Piscina } from "piscina";
import { type BriefNews, type NewsCategory } from "./common/BriefNews.schema.js";

/** Runtime configuration options accepted by the read operator and worker. */
export const ReadOptionsSchema = z.object({
    /** Per-request HTTP timeout in milliseconds when fetching article pages. */
    read_timeout: z.coerce.number().int().nonnegative().optional(),
    /** Custom HTTP User-Agent string sent when reading article pages. */
    read_user_agent: z.string().nonempty().optional(),
    /** Maximum character count retained for each article's extracted `raw` body. */
    read_max_body_chars: z.coerce.number().int().nonnegative().optional(),
    /** Whether to log pre/post-read item counts per category. */
    debug: z.boolean().default(false),
});
export type ReadOptions = z.infer<typeof ReadOptionsSchema>;

/** DAG input schema: `category -> (hash_id -> BriefNews)` map produced upstream. */
const ReadNewsInputSchema = z.object({
    read_input_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type ReadNewsInput = z.infer<typeof ReadNewsInputSchema>;

/** DAG output schema: `category -> (hash_id -> BriefNews)` map with populated `raw` content. */
const ReadNewsOutputSchema = z.object({
    read_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type ReadNewsOutput = z.infer<typeof ReadNewsOutputSchema>;

/** DAG context requirements: shared Piscina worker pool for article reading. */
const ReadNewsRequiresSchema = z.object({
    thread_pool: z.instanceof(Piscina),
});
type ReadNewsRequires = z.infer<typeof ReadNewsRequiresSchema>;

/**
 * Concurrently fetches full article bodies and refines publication timestamps
 * for each category via the Piscina worker pool (`./worker/_read.js`).
 *
 * Supports cooperative cancellation via LightDag's injected `signal`: forwards
 * `signal` to Piscina so queued or running worker tasks terminate on abort, and
 * skips mutating `read_input_items` when aborted mid-flight.
 *
 * Items without extracted `raw` content are pruned from the map. Throws directly
 * when the input map is empty or every category yields zero readable items,
 * letting LightDag's unified error handler process the failure.
 */
    export default async function readNews({ inputs, requires, options, signal }: OperatorArgs): Promise<OperatorOutput> {
        // Unpack DAG inputs, shared Piscina pool, and runtime options
        const { read_input_items } = inputs as ReadNewsInput;
        const { thread_pool } = requires as ReadNewsRequires;
        const read_options = options as ReadOptions;
        const isDebug = read_options?.debug;

        if (read_input_items.size === 0) {
            throw new Error("Categories map cannot be empty.");
        }

        // Snapshot input counts before worker execution / pruning for debug comparison
        let inputCounts = "";
        if (isDebug) {
            inputCounts = Array.from(
                read_input_items.entries(),
                ([category, items]) => `${category}: ${items.size}`,
            ).join(", ");
        }

        // Dispatch one worker task per category (skip empty maps); forward `signal` for Piscina cancellation
        const workerFilename = new URL("./worker/_read.js", import.meta.url).href;
        const tasks = Array.from(read_input_items.values(), (items) => {
            if (items.size === 0) {
                return Promise.resolve(items);
            }
            return thread_pool.run(
                { items, options: read_options },
                { name: "readNewsDetails", filename: workerFilename, signal: signal ?? null },
            );
        });

        // Wait for all category workers to settle so single-category errors don't abort the batch
        const results = await Promise.allSettled(tasks);
        // Propagate cooperative cancellation before logging AbortErrors or mutating `read_input_items`
        signal?.throwIfAborted();

        // Capture category order upfront because failed/empty categories are deleted from `read_input_items`
        const categories: NewsCategory[] = [...read_input_items.keys()];

        for (let i = 0; i < categories.length; i++) {
            const result = results[i]!;
            const category = categories[i]!;

            if (result.status === "rejected") {
                console.error(`[READ] Category "${category}" failed:`, result.reason);
                read_input_items.delete(category);
                continue;
            }

            // Replace with the worker-returned map (cloned across thread boundary by Piscina)
            const items = result.value as Map<string, BriefNews>;
            // Drop items that yielded no readable body text
            items.forEach((item, hash_id) => {
                if (!item.raw || item.raw.length === 0) {
                    items.delete(hash_id);
                }
            });

            if (items.size === 0) {
                read_input_items.delete(category);
            } else {
                read_input_items.set(category, items);
            }
        }

        // Fail the operator only when every category is empty after pruning (handled by LightDag)
        if (read_input_items.size === 0) {
            throw new Error("All categories failed to read.");
        }

        if (isDebug) {
            const outputCounts = Array.from(
                read_input_items.entries(),
                ([category, items]) => `${category}: ${items.size}`,
            ).join(", ");
            console.log(`[READ] Input items per category: ${inputCounts}`);
            console.log(`[READ] Output items per category: ${outputCounts}`);
        }

        const op_output: ReadNewsOutput = { read_items: read_input_items };
        return { branch: "default", output: op_output };
    }

    /** LightDag operator for stage 2: reading full article contents per category. */
    export class ReadNewsOperator extends Operator {
        /** Unique operator identifier within the DAG. */
        name: string = "read_news";
        /** Expected DAG input schema (`read_input_items`). */
        input_schema = ReadNewsInputSchema;
        /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
        output_schemas = { default: ReadNewsOutputSchema };
        /** Required shared runtime resources (`thread_pool`). */
        requires_schema = ReadNewsRequiresSchema;
        /** Optional per-run configuration (`ReadOptions`). */
        options_schema = ReadOptionsSchema;
        /** Operator execution entrypoint. */
        exec = readNews;
    }
