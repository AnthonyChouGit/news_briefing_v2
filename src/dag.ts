import { LightDag } from "light-dag";
import { ExportNewsOperator } from "./operators/exportNews.operator.js";
import { FetchNewsOperator } from "./operators/fetchNews.operator.js";
import { FilterRecencyOperator } from "./operators/filterRecency.operator.js";
import { HistoryNewsOperator } from "./operators/historyNews.operator.js";
import { PruneNewsOperator } from "./operators/pruneNews.operator.js";
import { RankNewsOperator } from "./operators/rankNews.operator.js";
import { ReadNewsOperator } from "./operators/readNews.operator.js";
import { SaveNewsOperator } from "./operators/saveNews.operator.js";
import { SelectNewsOperator } from "./operators/selectNews.operator.js";
import { SummarizeNewsOperator } from "./operators/summarizeNews.operator.js";

/**
 * Instantiates and wires the full news briefing LightDag pipeline.
 * Explicitly specifies `setName`, `mapInput`, `mapOutput`, and `mapOptions`
 * on every operator so graph connections remain self-documenting.
 */
export function createNewsBriefingDag(): LightDag {
    // ── Root / Maintenance Stage ────────────────────────────────────────────────

    /** Fetch candidate headlines & feed summaries concurrently across configured categories. */
    const fetch_news_op = new FetchNewsOperator()
        .setName("fetch_news")
        .mapInput("start", "start")
        .mapOutput("fetched_items", "fetched_items");

    /** Query recently covered briefing items from PostgreSQL for history dedupe and differentiation. */
    const history_news_op = new HistoryNewsOperator()
        .setName("history_news")
        .mapInput("start", "start")
        .mapOutput("history_items", "history_items");

    /** Prune expired records older than `prune_older_than_hours` from PostgreSQL. */
    const prune_news_op = new PruneNewsOperator()
        .setName("prune_news")
        .mapInput("start", "start")
        .mapOutput("pruned", "pruned");

    // ── Pre-Read Filtering & Candidate Buffer ───────────────────────────────────

    /** Rank #1: filter ads/junk, dedupe intra-batch & against history, and rank by headline/source. */
    const pre_read_rank_news_op = new RankNewsOperator()
        .setName("pre_read_rank_news")
        .mapInput("rank_input_items", "fetched_items")
        .mapInput("history_items", "history_items")
        .mapOutput("ranked_items", "pre_read_ranked_items");

    /** Select #1: keep a bounded buffer of top-ranked headlines before scraping full article bodies. */
    const pre_read_select_news_op = new SelectNewsOperator()
        .setName("pre_read_select_news")
        .mapInput("select_input_items", "pre_read_ranked_items")
        .mapOutput("selected_items", "pre_read_selected_items")
        .mapOptions("select_count_by_category", "pre_read_select_count_by_category");

    // ── Full-Article Scraping & Recency Filtering ───────────────────────────────

    /** Scrape full article text and refine publication timestamps via Piscina worker pool. */
    const read_news_op = new ReadNewsOperator()
        .setName("read_news")
        .mapInput("read_input_items", "pre_read_selected_items")
        .mapOutput("read_items", "read_items");

    /** Drop articles whose refined `source_date` falls outside `filter_recency_td_hours`. */
    const filter_recency_op = new FilterRecencyOperator()
        .setName("filter_recency")
        .mapInput("filter_recency_input_items", "read_items")
        .mapOutput("filtered_recency_items", "filtered_recency_items");

    // ── Pre-Summarize Selection, Summarization & Final Rank/Select ──────────────

    /** Select #2: cap candidates sent to full-text summarization while keeping backups for final ranking. */
    const pre_summarize_select_news_op = new SelectNewsOperator()
        .setName("pre_summarize_select_news")
        .mapInput("select_input_items", "filtered_recency_items")
        .mapOutput("selected_items", "pre_summarize_selected_items")
        .mapOptions("select_count_by_category", "pre_summarize_select_count_by_category");

    /** Filter low-substance bodies and generate localized titles and bullet summaries. */
    const summarize_news_op = new SummarizeNewsOperator()
        .setName("summarize_news")
        .mapInput("summarize_input_items", "pre_summarize_selected_items")
        .mapOutput("summarized_items", "summarized_items");

    /** Rank #2: re-rank & perform second-pass history deduplication using full summarized titles and bullets. */
    const post_summarize_rank_news_op = new RankNewsOperator()
        .setName("post_summarize_rank_news")
        .mapInput("rank_input_items", "summarized_items")
        .mapInput("history_items", "history_items")
        .mapOutput("ranked_items", "post_summarize_ranked_items");

    /** Select #3: lock in the exact target number of final news items per category. */
    const post_summarize_select_news_op = new SelectNewsOperator()
        .setName("post_summarize_select_news")
        .mapInput("select_input_items", "post_summarize_ranked_items")
        .mapOutput("selected_items", "post_summarize_selected_items")
        .mapOptions("select_count_by_category", "post_summarize_select_count_by_category");

    // ── Output Stage ────────────────────────────────────────────────────────────

    /** Persist final selected items to PostgreSQL (`ON CONFLICT DO NOTHING`). */
    const save_news_op = new SaveNewsOperator()
        .setName("save_news")
        .mapInput("save_input_items", "post_summarize_selected_items")
        .mapOutput("saved", "saved");

    /** Export final selected items to `<export_dir>/latest_<language>.json` with `previous_<language>.json` rotation. */
    const export_news_op = new ExportNewsOperator()
        .setName("export_news")
        .mapInput("export_input_items", "post_summarize_selected_items")
        .mapOutput("exported", "exported");

    return new LightDag([
        fetch_news_op,
        history_news_op,
        prune_news_op,
        pre_read_rank_news_op,
        pre_read_select_news_op,
        read_news_op,
        filter_recency_op,
        pre_summarize_select_news_op,
        summarize_news_op,
        post_summarize_rank_news_op,
        post_summarize_select_news_op,
        save_news_op,
        export_news_op,
    ]);
}

/** Singleton LightDag instance reused across one-shot and scheduled cron executions. */
export const news_briefing_dag = createNewsBriefingDag();
