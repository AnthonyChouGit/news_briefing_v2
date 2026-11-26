import { Operator, type OperatorArgs, type OperatorOutput } from "light-dag";
import * as z from "zod";
import { AIClient } from "../utils/ai.js";
import { type BriefNews, type NewsCategory } from "./common/BriefNews.schema.js";

/** Structured JSON schema expected from the AI ranking & filtering call. */
const RankResponseSchema = z.object({
    ranked_ids: z.array(z.string()),
});

/**
 * Creates a Zod schema that normalizes optional list configuration values (`rank_keywords`, `rank_sports`)
 * into trimmed, deduplicated non-empty string arrays (defaulting to `[]`).
 * Accepts empty strings, JSON array strings (`[...]`), comma-separated strings (`,` or `，`),
 * as well as already-parsed `string[]` arrays when re-validated downstream by LightDag.
 */
function createStringListSchema(fieldName: string) {
    return z
        .union([
            z.string().transform((val, ctx) => {
                const trimmed = val.trim();
                if (!trimmed) {
                    return [];
                }
                // Support JSON array notation (e.g. '["China", "AI"]') in `.env` files
                if (trimmed.startsWith("[")) {
                    try {
                        const parsed: unknown = JSON.parse(trimmed);
                        if (Array.isArray(parsed)) {
                            return parsed;
                        }
                    } catch {
                        ctx.addIssue({
                            code: "custom",
                            message: `Invalid JSON array for ${fieldName}: ${val}`,
                        });
                        return z.NEVER;
                    }
                }
                // Otherwise split on ASCII or full-width Chinese commas
                return trimmed.split(/[,，]/);
            }),
            // Allow array inputs directly so LightDag re-validation accepts parsed Config arrays
            z.array(z.string()),
        ])
        .pipe(
            z.array(z.string().transform((s) => s.trim())).transform((items) =>
                Array.from(new Set(items.filter(Boolean))),
            ),
        )
        .default([]);
}

/** Comma-separated, JSON-array, or array schema for optional ranking keywords. */
export const RankKeywordsSchema = createStringListSchema("rank_keywords");

/** Comma-separated, JSON-array, or array schema for optional target sports within the `sports` category. */
export const RankSportsSchema = createStringListSchema("rank_sports");

/** Runtime configuration options accepted by the rank news operator. */
export const RankNewsOptionsSchema = z.object({
    /** Optional list of preferred interest keywords given a mild importance boost during ranking. */
    rank_keywords: RankKeywordsSchema,
    /** Optional list of target sports to retain and balance when ranking the `sports` category. */
    rank_sports: RankSportsSchema,
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

/**
 * Builds the system instruction for quality filtering, deduplication, and multi-criteria ranking.
 *
 * @param hasHistory Whether historical `covered` items are supplied for cross-history deduplication and novelty scoring
 * @param category Target news category being ranked
 * @param rankKeywords Optional user interest keywords applied as a mild secondary relevance boost
 * @param rankSports Optional list of target sports used to scope and balance the `sports` category
 */
function buildRankInstruction(
    hasHistory: boolean,
    category: NewsCategory,
    rankKeywords: string[] = [],
    rankSports: string[] = [],
): string {
    // Only apply sport-scoping and cross-sport balancing when ranking `sports` with explicit `rank_sports`
    const hasTargetSports = category === "sports" && rankSports.length > 0;
    const hasKeywords = rankKeywords.length > 0;
    const sportsList = rankSports.join(", ");
    // Hard filter in Step 1 drops non-target sports when `rank_sports` is configured
    const sportsScopeRule = hasTargetSports
        ? `\n- **Sports Scope Rule**: Keep ONLY articles covering the configured \`target_sports\` (**${sportsList}**; matching literal terms, leagues, or cross-language equivalents). Immediately OMIT any article primarily covering other sports outside \`target_sports\`.`
        : "";
    // Diversity nudge in Step 3 prevents one popular sport or club from crowding out others
    const sportsDiversityNote = hasTargetSports
        ? ` For the \`sports\` category, balance and interleave top-ranked items across the configured \`target_sports\` (${sportsList}) whenever substantive stories exist across them, rather than letting a single sport or club monopolize the top positions.`
        : "";

    // Enforce strict event-level history exclusion so parallel outlet coverage or verbal reactions
    // do not repeat across consecutive briefings unless a concrete outcome-changing milestone occurred.
    const historyDedupeSection = hasHistory
        ? `2. **Cross-History Deduplication against \`covered\` (Strict Default-Exclude)**:
   - By default, **EXCLUDE** any candidate reporting the **same underlying news event, incident, or ongoing storyline** as any article in \`covered\` — even if published by a different media outlet, written in a different language (e.g., matching English candidate headlines against \`covered\` items in Chinese or another language), framed from a different angle, or citing slightly different figures/estimates.
   - When a candidate includes \`bullets\` (post-summarization stage), compare its \`title\` AND \`bullets\` closely against \`covered\` \`title\` + \`bullets\`; if most of the core facts recap an already-covered event, **EXCLUDE** it.
   - **Strict Milestone-Only Exception**: Keep a follow-up candidate covering a previously reported event ONLY when a **distinct, concrete, outcome-changing milestone** has actually occurred AFTER the \`covered\` report (such as an official court verdict/ruling, a binding agreement/treaty signed or broken, a major new physical escalation/incident, or an official policy reversal/resignation) AND the candidate's primary focus is that new milestone rather than summarizing prior background.
   - **NEVER Keep Mere Reactions or Parallel Recaps**: EXCLUDE follow-ups whose primary "new" content consists only of verbal reactions, vows, threats, condemnations, spokesperson/official statements, analyst commentary, background explainers, or another outlet's parallel report on the same event.`
        : `2. **No Historical Context**:
   - \`has_history\` is \`false\` and no historical articles are provided. Do NOT perform cross-history deduplication or speculate about previously covered briefings.`;

    // Collect optional Step 3 criteria so indices (`5.`, `6.`) stay contiguous when either or both are active
    const step3ExtraCriteria: string[] = [];
    if (hasHistory) {
        step3ExtraCriteria.push(
            `**Historical Novelty & Differentiation**: Among distinct non-duplicate events, rank genuinely fresh stories, new subjects, and unrepresented developments higher than repetitive follow-ups or themes heavily saturated in \`covered\`, so consecutive briefings deliver fresh variety rather than similar stories every issue.`,
        );
    }
    if (hasKeywords) {
        step3ExtraCriteria.push(
            `**Preferred Keyword Boost (Mild Nudge Only — Do NOT Over-Prioritize)**: Treat \`preferred_keywords\` as a **mild secondary relevance boost** (matching literal terms or clear cross-language equivalents, e.g. \`"China"\` ↔ \`"中国"\`). When candidates have comparable importance, authority, and timeliness, place keyword-matching articles modestly higher. Strict guardrails:\n   - Never elevate minor or routine keyword-matching items above major, high-impact non-keyword breaking news.\n   - Keyword matches must still pass Step 1 quality filtering and Step 2 deduplication.\n   - Preserve topic diversity by interleaving non-keyword stories rather than letting keyword matches monopolize the top positions.`,
        );
    }
    const extraCriteriaText = step3ExtraCriteria
        .map((criterion, idx) => `${5 + idx}. ${criterion}`)
        .join("\n");

    return `You are a world-class senior news editor, quality filter, deduplication engine, and ranking engine for an executive news briefing.

You will receive a JSON object containing:
- \`category\`: News category name.
- \`current_time\`: Current UTC ISO-8601 timestamp for evaluating timeliness.
- \`has_history\`: Boolean indicating whether historical briefing articles (\`covered\`) are present.
${hasTargetSports ? "- `target_sports`: Configured list of target sports to retain and balance within the `sports` category.\n" : ""}${hasKeywords ? "- `preferred_keywords`: Optional list of user interest keywords to apply a mild importance boost without over-prioritizing.\n" : ""}- \`candidates\`: Candidate \`BriefNews\` articles to filter, deduplicate, and rank. Each item includes \`hash_id\`, \`title\`, \`url\`, \`source_name\`, \`source_date\` (may be a default fallback such as \`1970-01-01\` / epoch 0 at the fetch stage), \`category\`, and optionally \`bullets\` (post-summarization points; absent at the fetch stage).
${hasHistory ? "- `covered`: Historical `BriefNews` articles already published in previous briefings (for historical deduplication and topic differentiation).\n" : ""}
Execute the following pipeline strictly in order:

### Step 1: Quality & Substance Filtering (Drop Immediately)
OMIT from your output any candidate that falls into these categories:
- Advertisements, sponsored content, advertorials, product promos, shopping deals/coupons, betting promos, or commercial PR fluff.
- Non-substantive items: clickbait teasers with no factual information, vague placeholders, navigation/cookie/login boilerplate, error pages, garbled scrapes, or media-only pages lacking reportable news.
- Trivial filler, pure rumors, or extremely low-value content unfit for a serious news briefing.
- **Stage Compatibility Rule**: Candidates from the fetch stage carry only metadata (\`title\`, \`url\`, \`source_name\`, \`source_date\`, \`category\`) without \`bullets\`. Do NOT reject a legitimate news headline merely because \`bullets\` is missing — judge its substance, newsworthiness, and ad likelihood from headline specificity, URL cues, and \`source_name\`. When \`bullets\` IS present and non-empty, inspect it carefully to catch thin clickbait or shallow filler.${sportsScopeRule}

### Step 2: Deduplication
1. **Intra-Batch Deduplication (Always Apply)**:
   - When multiple \`candidates\` report on the **same underlying news event** (even from different sources or phrased differently), keep **ONLY ONE** representative item and drop all others. When \`bullets\` are present, compare core facts across \`bullets\` (not just headlines) to detect same-event overlaps across outlets.
   - Choose the single best representative prioritizing: most advanced/latest development stage > richest factual detail > higher media authority (\`source_name\`) > fresher valid \`source_date\`.
${historyDedupeSection}

### Step 3: Multi-Criteria Ranking (Order Remaining Items Best-First)
Sort ALL remaining kept candidates from highest priority (index 0) to lowest priority by balancing these criteria:
1. **News Importance**: Real-world impact, significance, policy/market/industry/competitive stakes, or major breakthroughs within the category.
2. **Media Authority**: Credibility, primary-source standing, and editorial rigor of \`source_name\` (e.g., tier-1 wire services, flagship newspapers, official league/institutional outlets, and leading domain publications outrank aggregators, repost blogs, and tabloids).
3. **Timeliness**: Compare valid \`source_date\` against \`current_time\`. Breaking and recent news outranks older reports. If \`source_date\` is a fallback timestamp (such as \`1970-01-01\` / epoch 0), ignore it for time comparison — infer recency cues from the text if any, otherwise weight the other criteria normally.
4. **Topic Diversity**: Avoid clustering near-identical sub-topics, the same team/company/person/country, or tightly related narratives consecutively at the top of the list. Interleave distinct themes and angles so top-ranked items provide broad, balanced coverage across the category.${sportsDiversityNote}
${extraCriteriaText ? `${extraCriteriaText}\n` : ""}
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
    rankKeywords: string[],
    rankSports: string[],
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

    // Omit `raw` when serializing to AI so long article bodies are sent only during summarization,
    // while keeping the full BriefNews objects intact in `items` for downstream `read_news` / `save_news`.
    const withoutRaw = ({ raw: _raw, ...rest }: BriefNews): Omit<BriefNews, "raw"> => rest;
    // Inject `target_sports` only when ranking `sports` and `preferred_keywords` only when configured
    // so non-matching stages and unconfigured runs incur zero extra prompt/payload tokens.
    const hasTargetSports = category === "sports" && rankSports.length > 0;

    const payload = {
        category,
        current_time: new Date().toISOString(),
        has_history: hasHistory,
        ...(hasTargetSports ? { target_sports: rankSports } : {}),
        ...(rankKeywords.length > 0 ? { preferred_keywords: rankKeywords } : {}),
        candidates: Array.from(items.values(), withoutRaw),
        ...(hasHistory ? { covered: Array.from(historyItems!.values(), withoutRaw) } : {}),
    };

    const response = await aiClient.ask(
        JSON.stringify(payload),
        buildRankInstruction(hasHistory, category, rankKeywords, rankSports),
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
 * Compatible with inputs from any pipeline stage: fetch-only (`title` + `source_name`) or
 * post-summarize (`bullets`); `raw` bodies are omitted from AI payloads so full article text
 * is reserved for summarization. `history_items` is optional/nullable;
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
    // Forward configured `rank_keywords` and `rank_sports` preferences to every category task
    const results = await Promise.allSettled(
        categories.map((category) =>
            rankCategoryItems(
                category,
                rank_input_items.get(category)!,
                history_items?.get(category),
                rank_options.rank_keywords,
                rank_options.rank_sports,
                ai_client,
                signal,
            ),
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
