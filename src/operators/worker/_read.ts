/**
 * @module NewsDeepReader
 * @description Worker module that fetches and extracts full article text and
 * publication dates for `BriefNews` items produced by `_fetch`. Each item's
 * `raw` (and refined `source_date`) is populated in-place.
 *
 * ### Source Routing
 * The extractor is selected by `source_name` first, then by URL hostname,
 * falling back to a generic `<p>` extractor. Sources whose article pages block
 * automated requests (e.g. Motorsport.com, RaceFans) are skipped and rely on
 * RSS-populated summaries.
 */

import { type BriefNews } from "../common/BriefNews.schema.js";
import { type ReadOptions } from "../readNews.operator.js";

// ─── Constants ───────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const MAX_BODY_CHARS = Infinity; // No length limit on article body
const MAX_PARAGRAPHS = 100;
const WTT_API_BASE =
    "https://wtt-website-api-vm-frontdoor-hhaec5epbhdyfugz.a01.azurefd.net/primary/api/cms/getarticle";

// ─── Types ───────────────────────────────────────────────────

type HtmlExtractor = (html: string) => string;

// ─── Logging Utilities ───────────────────────────────────────

function logExpectedError(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const d = new Date(Date.now() + 8 * 3600000);
    const dateStr = d.toISOString().replace("Z", "+08:00");
    console.error(`[${dateStr}] Expected Error: ${reason}`);
}

// ─── HTML Utilities ──────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    nbsp: " ", mdash: "—", ndash: "–", lsquo: "\u2018", rsquo: "\u2019",
    ldquo: "\u201C", rdquo: "\u201D", hellip: "\u2026", bull: "\u2022",
    copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
    times: "\u00D7", divide: "\u00F7", middot: "\u00B7",
};

function htmlUnescape(s: string): string {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
        if (entity.startsWith("#x") || entity.startsWith("#X")) {
            const code = parseInt(entity.slice(2), 16);
            return isNaN(code) ? match : String.fromCodePoint(code);
        }
        if (entity.startsWith("#")) {
            const code = parseInt(entity.slice(1), 10);
            return isNaN(code) ? match : String.fromCodePoint(code);
        }
        return HTML_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

function escapeHtmlAttr(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function stripTags(s: string): string {
    return htmlUnescape(s.replace(/<[^>]+>/g, " ").trim());
}

function collapseWhitespace(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

// ─── HTML Extractors ─────────────────────────────────────────

/**
 * BBC articles use `data-component="text-block"` wrappers around `<p>` tags.
 * Fallback: all `<p>` tags with content longer than 40 chars.
 */
function extractBbc(html: string): string {
    let blocks = [...html.matchAll(/data-component="text-block".*?<p[^>]*>(.*?)<\/p>/gs)]
        .map(m => m[1] ?? "");
    if (blocks.length === 0) {
        blocks = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
            .map(m => m[1] ?? "")
            .filter(p => {
                const len = stripTags(p).length;
                return len > 40 && len < 5000;
            });
    }
    const paragraphs = blocks
        .map(b => collapseWhitespace(stripTags(b)))
        .filter(Boolean);
    return paragraphs.slice(0, MAX_PARAGRAPHS).join("\n\n");
}

/**
 * CNN articles use `data-component-name="paragraph"` blocks.
 * Filter range: 50–5000 chars (upper bound filters inline CSS blocks).
 * Fallback: generic extractor.
 */
function extractCnn(html: string): string {
    const blocks = [...html.matchAll(/data-component-name="paragraph"[^>]*>(.*?)<\/div>/gs)]
        .map(m => collapseWhitespace(stripTags(m[1] ?? "")))
        .filter(p => p.length > 50 && p.length < 5000);
    if (blocks.length > 0) {
        return blocks.slice(0, MAX_PARAGRAPHS).join("\n\n");
    }
    return extractGeneric(html);
}

/**
 * TechCrunch articles use an `article-content` class wrapper.
 * Fallback: all `<p>` tags > 40 chars, then split by `</p><p>` boundaries.
 */
function extractTechcrunch(html: string): string {
    const body = html.match(/<div[^>]*class="[^"]*article-content[^"]*"[^>]*>(.*?)<\/article>/s);
    let text: string;
    if (body?.[1]) {
        text = body[1];
    } else {
        const ps = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
            .map(m => m[1] ?? "")
            .filter(p => stripTags(p).length > 40)
            .slice(0, 20);
        text = ps.map(p => collapseWhitespace(stripTags(p))).join(" ");
    }
    const paragraphs = text.split(/<\/p>\s*<p[^>]*>/);
    const clean = paragraphs
        .map(p => collapseWhitespace(stripTags(p)))
        .filter(c => c.length > 20);
    return clean.slice(0, MAX_PARAGRAPHS).join("\n\n");
}

/**
 * F1 official articles: all `<p>` tags with content > 50 chars,
 * filtering out account sign-in/subscribe banners.
 */
function extractF1(html: string): string {
    const ps = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
        .map(m => m[1] ?? "")
        .filter(p => {
            const len = stripTags(p).length;
            const text = stripTags(p).toLowerCase();
            if (text.includes("sign in") && text.includes("subscribe")) return false;
            return len > 50 && len < 5000;
        });
    const clean = ps.map(p => collapseWhitespace(stripTags(p)));
    return clean.slice(0, MAX_PARAGRAPHS).join("\n\n");
}

/**
 * Marca articles: all `<p>` tags with content > 40 chars.
 */
function extractMarca(html: string): string {
    const ps = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
        .map(m => m[1] ?? "")
        .filter(p => {
            const len = stripTags(p).length;
            return len > 40 && len < 5000;
        });
    const clean = ps.map(p => collapseWhitespace(stripTags(p)));
    return clean.slice(0, MAX_PARAGRAPHS).join("\n\n");
}

/**
 * Motorsport.com articles: `.ms-article__body` container, fallback generic.
 */
function extractMotorsport(html: string): string {
    const body = html.match(/<div[^>]*class="[^"]*ms-article__body[^"]*"[^>]*>(.*?)<\/div>/s);
    if (body?.[1]) {
        const ps = [...body[1].matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
            .map(m => m[1] ?? "")
            .filter(p => stripTags(p).length > 40);
        if (ps.length > 0) {
            const clean = ps.map(p => collapseWhitespace(stripTags(p)));
            return clean.slice(0, MAX_PARAGRAPHS).join("\n\n");
        }
    }
    return extractGeneric(html);
}

/**
 * Global Times articles: `<div class="article_right">` container with `<br />` separators.
 * The article body is plain text separated by `<br />` tags rather than `<p>` tags.
 */
function extractGlobalTimes(html: string): string {
    const body = html.match(/<div[^>]*class="article_right"[^>]*>(.*?)<\/div>/s);
    if (body?.[1]) {
        const paragraphs = body[1]
            .split(/<br\s*\/?>/gi)
            .map(p => collapseWhitespace(stripTags(p)))
            .filter(p => p.length > 20);
        if (paragraphs.length > 0) {
            return paragraphs.slice(0, MAX_PARAGRAPHS).join("\n\n");
        }
    }
    return extractGeneric(html);
}

/**
 * Shared helper for extracting clean `<p>` paragraphs from a matched article container,
 * stripping inline scripts/styles and falling back to `extractGeneric`.
 */
function extractParagraphsFromContainer(
    containerHtml: string | undefined,
    fullHtml: string,
    minLength: number,
    exclude?: (text: string) => boolean,
): string {
    if (containerHtml) {
        const cleaned = containerHtml
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "");
        const paragraphs = [...cleaned.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
            .map(m => collapseWhitespace(stripTags(m[1] ?? "")))
            .filter(p => p.length > minLength && p.length < 5000 && (!exclude || !exclude(p)));
        if (paragraphs.length > 0) {
            return paragraphs.slice(0, MAX_PARAGRAPHS).join("\n\n");
        }
    }
    return extractGeneric(fullHtml);
}

/** 中新网 articles wrap body text between `<!--正文start-->` and `<!--正文end-->` (or `.left_zw`). */
function extractChinanews(html: string): string {
    const body =
        html.match(/<!--正文start-->([\s\S]*?)<!--正文end-->/) ??
        html.match(/<div[^>]*class="[^"]*left_zw[^"]*"[^>]*>([\s\S]*?)<div[^>]*class="adEditor"/);
    return extractParagraphsFromContainer(body?.[1], html, 4);
}

/** 界面新闻 articles place body copy inside `.article-content` / `.article-main`. */
function extractJiemian(html: string): string {
    const body =
        html.match(/<div[^>]*class="[^"]*article-content[^"]*"[^>]*>([\s\S]*?)<\/div>/) ??
        html.match(/<div[^>]*class="[^"]*article-main[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    return extractParagraphsFromContainer(
        body?.[1],
        html,
        10,
        (p) => p.includes("document.getElementsByTagName"),
    );
}

/** 量子位 articles place body copy inside `<div class="article">` before `.line_font`/`.tags`. */
function extractQbitai(html: string): string {
    const body = html.match(
        /<div[^>]*class="article"[^>]*>([\s\S]*?)(?:<div[^>]*class="line_font"|<div[^>]*class="tags")/,
    );
    return extractParagraphsFromContainer(
        body?.[1],
        html,
        8,
        (p) => p.includes("量子位 | 公众号"),
    );
}

/** 钛媒体 articles place body copy inside `<article>`. */
function extractTmtpost(html: string): string {
    const body = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
    return extractParagraphsFromContainer(body?.[1], html, 10);
}

/** InfoQ 中文 articles place body copy inside `_content-main_` before `_content-side_`. */
function extractInfoq(html: string): string {
    const body = html.match(
        /<div[^>]*class="[^"]*_content-main_[^"]*"[^>]*>([\s\S]*?)<div[^>]*class="[^"]*_content-side_/,
    );
    return extractParagraphsFromContainer(
        body?.[1],
        html,
        10,
        (p) => p.startsWith("本文字数：") || p.startsWith("阅读完需："),
    );
}

/**
 * Generic fallback extractor for standard article pages.
 * Filters `<p>` tags between 40 and 5000 chars to skip nav links and inline CSS/JS blocks.
 */
function extractGeneric(html: string): string {
    const ps = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
        .map(m => m[1] ?? "")
        .filter(p => {
            const len = stripTags(p).length;
            return len > 40 && len < 5000;
        });
    const clean = ps.map(p => collapseWhitespace(stripTags(p)));
    return clean.slice(0, MAX_PARAGRAPHS).join("\n\n");
}

// ─── Extractor Routing ───────────────────────────────────────

/** Maps `source_name` (as set by `_fetch.ts`) to its HTML body extractor. */
const SOURCE_NAME_EXTRACTORS: Record<string, HtmlExtractor> = {
    "BBC": extractBbc,
    "BBC Sport": extractBbc,
    "The Guardian": extractGeneric,
    "CNN": extractCnn,
    "TechCrunch": extractTechcrunch,
    "Marca": extractMarca,
    "Managing Madrid": extractGeneric,
    "Football España": extractGeneric,
    "AS": extractGeneric,
    "Formula 1": extractF1,
    "Motorsport.com": extractMotorsport,
    "RaceFans": extractGeneric,
    "Global Times": extractGlobalTimes,
    "CGTN": extractGeneric,
    "Al Jazeera": extractGeneric,
    "France 24": extractGeneric,
    "中新网": extractChinanews,
    "界面新闻": extractJiemian,
    "量子位": extractQbitai,
    "钛媒体": extractTmtpost,
    "InfoQ 中文": extractInfoq,
};

/**
 * Maps URL hostname to extractor. Used as a fallback when `source_name` doesn't
 * match (e.g. Google News items resolved to publisher domains).
 */
const HOST_EXTRACTORS: Record<string, HtmlExtractor> = {
    "www.bbc.com": extractBbc,
    "bbc.com": extractBbc,
    "www.bbc.co.uk": extractBbc,
    "bbc.co.uk": extractBbc,
    "www.theguardian.com": extractGeneric,
    "theguardian.com": extractGeneric,
    "edition.cnn.com": extractCnn,
    "www.cnn.com": extractCnn,
    "cnn.com": extractCnn,
    "techcrunch.com": extractTechcrunch,
    "www.techcrunch.com": extractTechcrunch,
    "www.marca.com": extractMarca,
    "marca.com": extractMarca,
    "www.managingmadrid.com": extractGeneric,
    "managingmadrid.com": extractGeneric,
    "football-espana.net": extractGeneric,
    "www.football-espana.net": extractGeneric,
    "en.as.com": extractGeneric,
    "as.com": extractGeneric,
    "www.formula1.com": extractF1,
    "formula1.com": extractF1,
    "www.motorsport.com": extractMotorsport,
    "motorsport.com": extractMotorsport,
    "www.racefans.net": extractGeneric,
    "racefans.net": extractGeneric,
    "www.globaltimes.cn": extractGlobalTimes,
    "globaltimes.cn": extractGlobalTimes,
    "news.cgtn.com": extractGeneric,
    "www.cgtn.com": extractGeneric,
    "www.aljazeera.com": extractGeneric,
    "aljazeera.com": extractGeneric,
    "www.france24.com": extractGeneric,
    "france24.com": extractGeneric,
    "www.chinanews.com.cn": extractChinanews,
    "chinanews.com.cn": extractChinanews,
    "www.jiemian.com": extractJiemian,
    "jiemian.com": extractJiemian,
    "www.qbitai.com": extractQbitai,
    "qbitai.com": extractQbitai,
    "www.tmtpost.com": extractTmtpost,
    "tmtpost.com": extractTmtpost,
    "www.infoq.cn": extractInfoq,
    "infoq.cn": extractInfoq,
};

/**
 * Sources whose article pages either block scraping (Motorsport.com, RaceFans: 403)
 * or already deliver full article text and publication timestamps via RSS (钛媒体).
 */
const SKIP_SOURCE_NAMES = new Set(["Motorsport.com", "RaceFans", "钛媒体"]);

/** Hosts requiring browser automation, paywall subscriptions, or blocking automated HTTP scraping with bot challenges. */
const SKIP_HOSTS = new Set([
    "news.qq.com",
    "cepr.org",
    "dazn.com",
    "reuters.com",
    "wsj.com",
    "bloomberg.com",
    "ft.com",
    "nytimes.com",
]);

function isSkippedItem(item: BriefNews): boolean {
    if (SKIP_SOURCE_NAMES.has(item.source_name)) return true;
    try {
        let host = new URL(item.url).hostname.toLowerCase();
        if (host.startsWith("www.")) host = host.slice(4);
        if (SKIP_HOSTS.has(host)) return true;
    } catch {
        // Invalid URL handled downstream
    }
    return false;
}

/**
 * Select the right extractor for a `BriefNews` item, or `null` to skip.
 * Priority: skip-list → `source_name` map → URL hostname map → generic fallback.
 */
function getExtractorForItem(item: BriefNews): HtmlExtractor | null {
    if (isSkippedItem(item)) return null;

    const byName = SOURCE_NAME_EXTRACTORS[item.source_name];
    if (byName) return byName;

    try {
        const host = new URL(item.url).hostname.toLowerCase();
        const byHost = HOST_EXTRACTORS[host];
        if (byHost) return byHost;
    } catch {
        // Invalid URL — fall through to generic
    }

    return extractGeneric;
}

// ─── Time Extraction ─────────────────────────────────────────

/**
 * Extract the article's publication timestamp from common JSON-LD, OpenGraph,
 * `<time datetime>`, and publisher-specific HTML elements (e.g. Global Times `pub_time`).
 */
function extractTime(rawHtml: string): Date | undefined {
    const patterns = [
        /"datePublished"\s*:\s*"([^"]+)"/,
        /datePublished&quot;\s*:\s*&quot;([^&]+)&quot;/,
        /<meta[^>]*name=["']datePublished["'][^>]*content=["']([^"']+)["']/i,
        /<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
        /<meta[^>]*name=["']pubdate["'][^>]*content=["']([^"']+)["']/i,
        /<time[^>]*datetime="([^"]+)"/,
        /"pubTime"\s*:\s*"([^"]+)"/,
        /class="source-time">([^<]+)/,
        /class=["']pub_time["'][^>]*>\s*(?:Published:\s*)?([^<]+)/i,
    ];

    for (const pat of patterns) {
        const m = rawHtml.match(pat);
        if (m && m[1]) {
            let s = htmlUnescape(m[1].trim());
            if (/^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
                s = s.replace(/\//g, "-").replace(" ", "T") + "+08:00";
            } else if (/^[A-Za-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}(?:\s*[AP]M)?$/i.test(s)) {
                // Global Times `pub_time` omits timezone offset and uses Beijing time (UTC+8)
                s = `${s} GMT+0800`;
            }
            const parsed = new Date(s);
            if (!isNaN(parsed.getTime())) {
                return parsed;
            }
        }
    }
    return undefined;
}

// ─── HTTP Fetch ──────────────────────────────────────────────

/**
 * World Table Tennis (`worldtabletennis.com`) serves an Angular SPA shell with no
 * server-rendered article text. Fetch the underlying CMS article JSON and wrap it
 * in minimal HTML so `extractGeneric` and `extractTime` work uniformly.
 */
async function fetchWttArticleHtml(artId: string, options?: ReadOptions): Promise<string> {
    const response = await fetch(`${WTT_API_BASE}/${artId}`, {
        signal: AbortSignal.timeout(options?.read_timeout ?? DEFAULT_TIMEOUT_MS),
        headers: {
            "User-Agent": options?.read_user_agent ?? USER_AGENT,
            "Accept": "application/json, text/plain, */*",
        },
    });
    if (!response.ok) {
        throw new Error(`WTT API request failed with status code ${response.status}`);
    }
    const data = (await response.json()) as {
        published_at?: string;
        shortDescription?: string;
        descriptionData?: string | { content?: Array<{ title?: string; description?: string }> };
    };

    const meta = data.published_at
        ? `<meta property="article:published_time" content="${escapeHtmlAttr(data.published_at)}">`
        : "";

    let descObj = data.descriptionData;
    if (typeof descObj === "string") {
        try {
            descObj = JSON.parse(descObj) as { content?: Array<{ title?: string; description?: string }> };
        } catch {
            descObj = undefined;
        }
    }

    const sections: string[] = [];
    if (descObj && Array.isArray(descObj.content)) {
        for (const block of descObj.content) {
            if (block.title) sections.push(`<p>${block.title}</p>`);
            if (block.description) sections.push(block.description);
        }
    }
    if (sections.length === 0 && data.shortDescription) {
        sections.push(`<p>${data.shortDescription}</p>`);
    }

    return `<!doctype html><html><head>${meta}</head><body>${sections.join("\n")}</body></html>`;
}

async function fetchHtml(url: string, options?: ReadOptions): Promise<string> {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (host === "worldtabletennis.com" || host === "www.worldtabletennis.com") {
            const artId = parsed.searchParams.get("artId");
            if (artId && /^\d+$/.test(artId)) {
                return await fetchWttArticleHtml(artId, options);
            }
        }

        const response = await fetch(url, {
            signal: AbortSignal.timeout(options?.read_timeout ?? DEFAULT_TIMEOUT_MS),
            headers: {
                "User-Agent": options?.read_user_agent ?? USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
                "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
                "sec-fetch-user": "?1",
                "upgrade-insecure-requests": "1",
            },
            redirect: "follow",
        });
        if (!response.ok) {
            throw new Error(`Request failed with status code ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to fetch ${url}: ${error.message}`, { cause: error });
        }
        throw error;
    }
}

// ─── Public API ──────────────────────────────────────────────

interface ReadArguments {
    items: Map<string, BriefNews>;
    options?: ReadOptions;
}

/**
 * Fetches and extracts full article text for a collection of `BriefNews` items.
 * Each item's `raw` (and refined `source_date`) is populated in-place.
 *
 * @param items - Map of `BriefNews` items produced by `fetchNewsByCategory`.
 * @param options - Optional overrides for timeout and body cap.
 * @returns The same `items` Map, with `raw` populated where extraction succeeded.
 *
 * @throws {TypeError} If `items` is not a Map.
 */
export async function readNewsDetails({ items, options }: ReadArguments): Promise<Map<string, BriefNews>> {
    if (!(items instanceof Map)) {
        throw new TypeError("readNewsDetails: expected a Map of BriefNews items");
    }
    if (items.size === 0) {
        return items;
    }

    const maxBody = options?.read_max_body_chars ?? MAX_BODY_CHARS;

    const tasks = Array.from(items.values()).map(async (item) => {
        if (isSkippedItem(item)) {
            if (item.source_date.getTime() === 0) {
                item.source_date = new Date();
            }
            return;
        }
        const extractor = getExtractorForItem(item);
        if (!extractor) {
            logExpectedError(new Error(`No extractor found for item: ${item.title}`));
            return;
        }
        if (!item.url?.trim()) {
            logExpectedError(new Error(`Missing or empty URL for item: ${item.title}`));
            return;
        }

        try {
            const parsed = new URL(item.url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                logExpectedError(new Error(`Unsupported protocol (${parsed.protocol}) for URL: ${item.url}`));
                return;
            }
        } catch {
            logExpectedError(new Error(`Invalid URL: ${item.url}`));
            return;
        }

        try {
            const html = await fetchHtml(item.url, options);
            const body = extractor(html);
            const parsedDate = extractTime(html);

            if (body) {
                item.raw = body.slice(0, maxBody);
            }
            if (parsedDate) {
                if (item.source_date.getTime() === 0 || item.source_date.getTime() < parsedDate.getTime()) {
                    item.source_date = parsedDate;
                }
            }

            // Fallback if still no valid date is available
            if (item.source_date.getTime() === 0) {
                item.source_date = new Date();
            }
        } catch (error) {
            if (error instanceof Error) {
                logExpectedError(error);
                return;
            }
            throw error;
        }
    });

    const settled = await Promise.allSettled(tasks);
    for (const result of settled) {
        if (result.status === "rejected") {
            throw result.reason;
        }
    }

    return items;
}
