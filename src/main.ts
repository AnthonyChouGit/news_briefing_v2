import { loadConfig } from "./config.js";
import { news_briefing_dag } from "./dag.js";
import { runBriefing } from "./run.js";

const config = loadConfig(process.env.CONFIG_PATH);

news_briefing_dag.setDebug(config.debug);
if (config.dag_timeout) {
    news_briefing_dag.setTimeout(config.dag_timeout);
}

const ok = await runBriefing(config, news_briefing_dag);
if (!ok) {
    process.exitCode = 1;
}
