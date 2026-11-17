import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { AIClient } from "../utils/ai.js";
import { type BriefNews, type NewsCategory } from "./common/BriefNews.schema.js";

/** Structured JSON schema expected from the AI ranking & filtering call. */
const RankResponseSchema = z.object({
    ranked_ids: z.array(z.string()),
});

/** Runtime configuration options accepted by the rank news operator. */
export const RankNewsOptionsSchema = z.object({
    /** Whether to log per-category filtering and remaining item counts after ranking. */
    debug: z.boolean().default(false),
});
export type RankNewsOptions = z.infer<typeof RankNewsOptionsSchema>;

/** DAG input schema when historical context (`history_items`) is wired into this stage. */
const RankNewsWithHistoryInputSchema = z.object({
    rank_input_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
    // Nullish allows DAG callers to pass `history_items: null | undefined` when bypassing HistoryNewsOperator.
    history_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>).nullish(),
});

/** DAG input schema when ranking runs without historical context (e.g. post-summarize re-ranking). */
const RankNewsWithoutHistoryInputSchema = z.object({
    rank_input_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});

type RankNewsInput = z.infer<typeof RankNewsWithHistoryInputSchema>;

/** DAG output schema: `category -> (hash_id -> BriefNews)` ordered best-first by AI ranking. */
const RankNewsOutputSchema = z.object({
    ranked_items: z.instanceof(Map<NewsCategory, Map<string, BriefNews>>),
});
type RankNewsOutput = z.infer<typeof RankNewsOutputSchema>;

/** DAG context requirements: unified `AIClient` for structured JSON generation. */
const RankNewsRequiresSchema = z.object({
    ai_client: z.instanceof(AIClient),
});
type RankNewsRequires = z.infer<typeof RankNewsRequiresSchema>;

function buildRankInstruction(hasHistory: boolean): string {
    const historyDedupeSection = hasHistory
        ? `2. **Cross-History Deduplication against \`covered\`**:
   - Exclude any candidate reporting the **same underlying news event** as any article in \`covered\`.
   - **Strict New-Development Exception**: Keep a candidate covering a previously reported event ONLY if it introduces a genuinely substantive new development (e.g., an official verdict/outcome, major escalation, reversal, concrete new official response, or materially new key facts/figures). Reworded summaries, minor details, routine commentary, or another outlet repeating the same story MUST be excluded.`
        : `2. **No Historical Context**:
   - \`has_history\` is \`false\` and no historical articles are provided. Do NOT perform cross-history deduplication or speculate about previously covered briefings.`;

    const historyNoveltyCriterion = hasHistory
        ? `5. **Historical Novelty & Differentiation**: Among distinct non-duplicate events, rank genuinely fresh stories, new subjects, and unrepresented developments higher than repetitive follow-ups or themes heavily saturated in \`covered\`, so consecutive briefings deliver fresh variety rather than similar stories every issue.`
        : "";

    return `You are a world-class senior news editor, quality filter, deduplication engine, and ranking engine for an executive news briefing.

You will receive a JSON object containing:
- \`category\`: News category name.
- \`current_time\`: Current UTC ISO-8601 timestamp for evaluating timeliness.
- \`has_history\`: Boolean indicating whether historical briefing articles (\`covered\`) are present.
- \`candidates\`: Candidate \`BriefNews\` articles to filter, deduplicate, and rank. Each item includes \`hash_id\`, \`title\`, \`url\`, \`source_name\`, \`source_date\` (may be a default fallback such as \`1970-01-01\` / epoch 0 at the fetch stage), \`category\`, and optionally \`bullets\` (post-summarization points) and/or \`raw\` (post-read article text or feed summary). Fetch-stage items may have only \`title\`, \`url\`, and \`source_name\` without \`bullets\` or \`raw\`.
${hasHistory ? "- `covered`: Historical `BriefNews` articles already published in previous briefings (for historical deduplication and topic differentiation).\n" : ""}
Execute the following pipeline strictly in order:

### Step 1: Quality & Substance Filtering (Drop Immediately)
OMIT from your output any candidate that falls into these categories:
- Advertisements, sponsored content, advertorials, product promos, shopping deals/coupons, betting promos, or commercial PR fluff.
- Non-substantive items: clickbait teasers with no factual information, vague placeholders, navigation/cookie/login boilerplate, error pages, garbled scrapes, or media-only pages lacking reportable news.
- Trivial filler, pure rumors, or extremely low-value content unfit for a serious news briefing.
- **Stage Compatibility Rule**: Candidates from the fetch stage carry only \`title\`, \`url\`, and \`source_name\` (no \`bullets\` or \`raw\`). Do NOT reject a legitimate news headline merely because \`raw\` or \`bullets\` is missing — judge its substance, newsworthiness, and ad likelihood from headline specificity, URL cues, and \`source_name\`. When \`bullets\` or \`raw\` IS present and non-empty, inspect it carefully to catch thin clickbait, hidden promos, or broken scrapes.

### Step 2: Deduplication
1. **Intra-Batch Deduplication (Always Apply)**:
   - When multiple \`candidates\` report on the **same underlying news event** (even from different sources or phrased differently), keep **ONLY ONE** representative item and drop all others.
   - Choose the single best representative prioritizing: most advanced/latest development stage > richest factual detail > higher media authority (\`source_name\`) > fresher valid \`source_date\`.
${historyDedupeSection}

### Step 3: Multi-Criteria Ranking (Order Remaining Items Best-First)
Sort ALL remaining kept candidates from highest priority (index 0) to lowest priority by balancing these criteria:
1. **News Importance**: Real-world impact, significance, policy/market/industry/competitive stakes, or major breakthroughs within the category.
2. **Media Authority**: Credibility, primary-source standing, and editorial rigor of \`source_name\` (e.g., tier-1 wire services, flagship newspapers, official league/institutional outlets, and leading domain publications outrank aggregators, repost blogs, and tabloids).
3. **Timeliness**: Compare valid \`source_date\` against \`current_time\`. Breaking and recent news outranks older reports. If \`source_date\` is a fallback timestamp (such as \`1970-01-01\` / epoch 0), ignore it for time comparison — infer recency cues from the text if any, otherwise weight the other criteria normally.
4. **Topic Diversity**: Avoid clustering near-identical sub-topics, the same team/company/person/country, or tightly related narratives consecutively at the top of the list. Interleave distinct themes and angles so top-ranked items provide broad, balanced coverage across the category.
${historyNoveltyCriterion}

### Output Format
Return a JSON object matching \`{"ranked_ids": ["..."]}\`:
- Include ONLY exact \`hash_id\` strings copied verbatim from \`candidates\` for items that passed Step 1 and Step 2, ordered from highest rank to lowest rank.
- Do NOT include dropped/duplicate items, do NOT invent or alter \`hash_id\` values, and do NOT repeat any \`hash_id\`.
- If no candidates remain after filtering and deduplication, return \`{"ranked_ids": []}\`.
- Output raw JSON only, without markdown fences or commentary.`;
}

/**
 * Deduplicates, filters low-quality/ad items, and ranks remaining candidate articles
 * within a single category via `AIClient`.
 */
async function rankCategoryItems(
    category: NewsCategory,
    items: Map<string, BriefNews>,
    historyItems: Map<string, BriefNews> | undefined,
    aiClient: AIClient,
    signal?: AbortSignal,
): Promise<Map<string, BriefNews>> {
    if (items.size === 0) {
        return items;
    }

    const hasHistory = Boolean(historyItems && historyItems.size > 0);
    if (hasHistory) {
        // Fast exact-ID pre-filter in place before calling AI
        for (const hash_id of historyItems!.keys()) {
            items.delete(hash_id);
        }
        if (items.size === 0) {
            return items;
        }
    }

    const payload = {
        category,
        current_time: new Date().toISOString(),
        has_history: hasHistory,
        candidates: [...items.values()],
        ...(hasHistory ? { covered: [...historyItems!.values()] } : {}),
    };

    const response = await aiClient.ask(
        JSON.stringify(payload),
        buildRankInstruction(hasHistory),
        RankResponseSchema,
        signal,
    );

    // Single pass: build ranked Map directly without deleting/clearing/reinserting `items`
    const ranked = new Map<string, BriefNews>();
    for (const id of response.ranked_ids) {
        if (ranked.has(id)) {
            continue;
        }
        const item = items.get(id);
        if (item) {
            ranked.set(id, item);
        }
    }
    return ranked;
}

/**
 * Concurrently filters, deduplicates, and AI-ranks news items per category in place.
 *
 * Compatible with inputs from any pipeline stage: fetch-only (`title` + `source_name`),
 * post-read (`raw`), or post-summarize (`bullets`). `history_items` is optional/nullable;
 * cross-history deduplication and historical differentiation are enabled for a category
 * only when its historical map is present and non-empty.
 *
 * Supports cooperative cancellation via LightDag's `signal` and lets exceptions
 * propagate directly to LightDag's unified error handler.
 */
export default async function rankNews({ inputs, requires, options, signal }: OperatorArgs): Promise<OperatorOutput> {
    const { rank_input_items, history_items } = inputs as RankNewsInput;
    const { ai_client } = requires as RankNewsRequires;
    const rank_options = options as RankNewsOptions;

    const totalBefore = rank_options.debug
        ? Array.from(rank_input_items.values()).reduce((sum, map) => sum + map.size, 0)
        : 0;

    const categories: NewsCategory[] = [...rank_input_items.keys()];
    const results = await Promise.allSettled(
        categories.map((category) =>
            rankCategoryItems(category, rank_input_items.get(category)!, history_items?.get(category), ai_client, signal),
        ),
    );
    signal?.throwIfAborted();

    for (let i = 0; i < categories.length; i++) {
        const category = categories[i]!;
        const result = results[i]!;
        if (result.status === "rejected") {
            console.error(`[RANK] Category "${category}" failed:`, result.reason);
            rank_input_items.delete(category);
            continue;
        }
        if (result.value.size === 0) {
            rank_input_items.delete(category);
        } else if (result.value !== rank_input_items.get(category)) {
            rank_input_items.set(category, result.value);
        }
    }

    if (rank_input_items.size === 0) {
        throw new Error("All categories failed or became empty during ranking.");
    }

    if (rank_options.debug) {
        const totalAfter = Array.from(rank_input_items.values()).reduce((sum, map) => sum + map.size, 0);
        const remainingCounts = Array.from(
            rank_input_items.entries(),
            ([category, items]) => `${category}: ${items.size}`,
        ).join(", ");
        console.log(
            `[RANK] Dropped ${totalBefore - totalAfter} items (remaining: ${totalAfter}, per category: ${remainingCounts})`,
        );
    }

    const op_output: RankNewsOutput = { ranked_items: rank_input_items };
    return { branch: "default", output: op_output };
}

/** LightDag operator that filters low-quality items, deduplicates events, and ranks articles via AI. */
export class RankNewsOperator extends Operator {
    /** Unique operator identifier within the DAG. */
    name: string = "rank_news";
    /** Expected DAG input schemas (`rank_input_items` and optionally `history_items` when `use_history` is true). */
    input_schema: z.ZodObject = RankNewsWithHistoryInputSchema;
    /** Output branch schemas (`default` only; exceptions propagate to LightDag). */
    output_schemas = { default: RankNewsOutputSchema };
    /** Required shared runtime resources (`ai_client`). */
    requires_schema = RankNewsRequiresSchema;
    /** Optional per-run configuration (`RankNewsOptions`). */
    options_schema = RankNewsOptionsSchema;
    /** Operator execution entrypoint. */
    exec = rankNews;

    constructor(use_history: boolean = true) {
        super();
        this.input_schema = use_history
            ? RankNewsWithHistoryInputSchema
            : RankNewsWithoutHistoryInputSchema;
    }
}
