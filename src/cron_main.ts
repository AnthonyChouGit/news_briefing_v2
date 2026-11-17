import { CronJob } from "cron";
import { loadConfig } from "./config.js";
import { news_briefing_dag } from "./dag.js";
import { runBriefing } from "./run.js";

const config = loadConfig(process.env.CONFIG_PATH);
if (!config.cron_expr) {
    throw new Error("cron_expr is not set in configuration");
}

// Configure the singleton DAG once at startup and reuse it across all scheduled ticks
news_briefing_dag.setDebug(config.debug);
if (config.dag_timeout) {
    news_briefing_dag.setTimeout(config.dag_timeout);
}

let isRunning = false;

const cron_job = CronJob.from({
    cronTime: config.cron_expr,
    onTick: async () => {
        if (isRunning) {
            console.warn("[Cron] Previous run still active, skipping overlapping tick");
            return;
        }
        isRunning = true;
        try {
            await runBriefing(config, news_briefing_dag);
        } catch (err) {
            console.error("[Cron] News briefing execution failed:", err);
        } finally {
            isRunning = false;
        }
    },
    ...(config.time_zone ? { timeZone: config.time_zone } : {}),
});

const shutdown = () => {
    void cron_job.stop();
    if (!isRunning) {
        process.exit(0);
    }
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

cron_job.start();
console.log(
    `[Cron] Scheduler started (cron="${config.cron_expr}", timeZone="${config.time_zone ?? "system default"}")`,
);
