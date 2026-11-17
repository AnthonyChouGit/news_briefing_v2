import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { BriefNewsRepository } from "../utils/db.js";

/** Runtime configuration options accepted by the prune news operator. */
export const PruneNewsOptionsSchema = z.object({
    /** Retention threshold in hours; items with `source_date` older than this are deleted. */
    prune_older_than_hours: z.coerce.number().positive(),
    /** Whether to log the deleted row count after pruning. */
    debug: z.boolean().default(false),
});
export type PruneNewsOptions = z.infer<typeof PruneNewsOptionsSchema>;

/** DAG input schema: dummy start signal triggering maintenance pruning. */
const PruneNewsInputSchema = z.object({
    start: z.unknown(),
});

/** DAG output schema: boolean completion flag (`pruned`). */
const PruneNewsOutputSchema = z.object({
    pruned: z.boolean().default(true),
});
type PruneNewsOutput = z.infer<typeof PruneNewsOutputSchema>;

/** DAG context requirements: repository backed by Kysely/PostgreSQL (`BriefNewsRepository`). */
const PruneNewsRequiresSchema = z.object({
    repository: z.instanceof(BriefNewsRepository),
});
type PruneNewsRequires = z.infer<typeof PruneNewsRequiresSchema>;

/**
 * Deletes news records from PostgreSQL whose `source_date` is older than
 * `prune_older_than_hours` hours using `BriefNewsRepository.deleteOlderThanHours`.
 *
 * Supports cooperative cancellation via LightDag's injected `signal` by
 * forwarding it to Kysely so in-flight PostgreSQL deletes cancel on abort.
 * Errors propagate directly to LightDag's unified error handler.
 */
export default async function pruneNews({ requires, options, signal }: OperatorArgs): Promise<OperatorOutput> {
    const { repository } = requires as PruneNewsRequires;
    const { prune_older_than_hours, debug } = options as PruneNewsOptions;

    const deletedCount = await repository.deleteOlderThanHours(prune_older_than_hours, undefined, signal);

    if (debug) {
        console.log(`[PRUNE] Deleted ${deletedCount} items older than ${prune_older_than_hours} hours`);
    }

    const op_output: PruneNewsOutput = { pruned: true };
    return { branch: "default", output: op_output };
}

/** LightDag operator that prunes expired news records from PostgreSQL. */
export class PruneNewsOperator extends Operator {
    /** Unique operator identifier within the DAG. */
    name: string = "prune_news";
    /** Expected DAG input schema (dummy `start` signal). */
    input_schema = PruneNewsInputSchema;
    /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
    output_schemas = { default: PruneNewsOutputSchema };
    /** Required shared runtime resources (`repository`). */
    requires_schema = PruneNewsRequiresSchema;
    /** Optional per-run configuration (`PruneNewsOptions`). */
    options_schema = PruneNewsOptionsSchema;
    /** Operator execution entrypoint. */
    exec = pruneNews;
}
