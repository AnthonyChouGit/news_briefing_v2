import { type LightDag } from "light-dag";
import { Piscina } from "piscina";
import { type Config } from "./config.js";
import { news_briefing_dag } from "./dag.js";
import { AIClient } from "./utils/ai.js";
import { BriefNewsRepository } from "./utils/db.js";

/**
 * Executes a single run of the provided `LightDag` with per-run database,
 * AI client, and Piscina worker pool resources, ensuring clean teardown on completion or signal.
 */
export async function runBriefing(config: Config, dag: LightDag = news_briefing_dag): Promise<boolean> {
    const repository = new BriefNewsRepository(config);
    const ai_client = new AIClient(config);
    const thread_pool = new Piscina();

    const cleanup = async () => {
        await thread_pool.destroy();
        await repository.release();
    };

    const onTermination = async () => {
        console.warn("[Main] Termination signal received");
        await cleanup();
        process.exit(1);
    };

    process.once("SIGTERM", onTermination);
    process.once("SIGINT", onTermination);

    try {
        const output_values = await dag.run(
            { start: true },
            ["saved", "exported", "pruned"],
            { repository, ai_client, thread_pool },
            config,
            thread_pool,
        );

        const ok = Boolean(output_values?.saved && output_values?.exported && output_values?.pruned);
        if (ok) {
            console.log("[Main] News briefing completed successfully");
        } else {
            console.error("[Main] News briefing failed");
        }
        return ok;
    } catch (err) {
        console.error("[Main] News briefing failed", err);
        return false;
    } finally {
        process.off("SIGTERM", onTermination);
        process.off("SIGINT", onTermination);
        await cleanup();
    }
}
