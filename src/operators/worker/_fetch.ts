/**
 * @module NewsFetchUtility
 * @description Worker module providing concurrent fetching and parsing of news
 * items across configured HTML pages and RSS/Atom feeds.
 */

import { createHash } from "node:crypto";
import { type BriefNews, type NewsCategory } from "../common/BriefNews.schema.js";
import { type FetchOptions } from "../fetchNews.operator.js";

// ─── Constants ───────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const MAX_DECODE_ITEMS = 5;
const DROP_PARAMS = new Set([
    "fbclid", "gclid", "cmpid", "ocid", "ref", "source",
]);

// ─── Types ───────────────────────────────────────────────────

interface RawNewsItem {
    title: string;
    url: string;
    time: string;
    category: NewsCategory;
    raw?: string | undefined;
}

interface DecodeResult {
    status: "ok" | "passthrough" | "error";
    url?: string;
    reason?: string;
}

interface RssFeedConfig {
    url: string;
    category: NewsCategory;
    sourceName: string;
}

// ─── Logging Utility ─────────────────────────────────────────

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

function stripTags(s: string): string {
    return htmlUnescape(s.replace(/<[^>]+>/g, "").trim());
}

function stripCdata(s: string): string {
    return s.trim().replace(/^<!\[CDATA\[(.*?)\]\]>$/s, "$1").trim();
}

// ─── URL & Identity Utilities ────────────────────────────────

/** Normalize a URL (strip tracking params, www prefix, trailing slash) for deduplication. */
function canonicalUrl(rawUrl: string): string {
    const url = (rawUrl ?? "").trim();
    if (!url) return "";
    try {
        const parsed = new URL(url.includes("://") ? url : `https://${url}`);
        let host = parsed.hostname.toLowerCase();
        if (host.startsWith("www.")) host = host.slice(4);
        const path = parsed.pathname.replace(/\/+$/, "") || "/";
        const filteredParams: Array<[string, string]> = [];
        parsed.searchParams.forEach((v, k) => {
            const kl = k.toLowerCase();
            if (!kl.startsWith("utm_") && !DROP_PARAMS.has(kl)) {
                filteredParams.push([k, v]);
            }
        });
        filteredParams.sort(([a], [b]) => a.localeCompare(b));
        const query = new URLSearchParams(filteredParams).toString();
        const scheme = parsed.protocol.replace(":", "");
        return `${scheme}://${host}${path}${query ? "?" + query : ""}`;
    } catch {
        return url;
    }
}

function generateHashId(url: string, sourceName: string, title: string): string {
    const input = url ? canonicalUrl(url) : `${sourceName}:${title}`;
    return createHash("sha256").update(input).digest("hex");
}

/** Hosts requiring browser automation, paywall subscriptions, or blocking automated HTTP scraping with bot challenges. */
const BLOCKED_HOSTS = new Set([
    "news.qq.com",
    "cepr.org",
    "dazn.com",
    "reuters.com",
    "wsj.com",
    "bloomberg.com",
    "ft.com",
    "nytimes.com",
]);

/** Validate that a URL is a plausible article URL (not a homepage, search, or Google News wrapper). */
function isArticleUrl(url: string): boolean {
    if (!url.trim()) return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        if (!parsed.hostname) return false;
        if (parsed.hostname.includes("news.google.com")) return false;
        let host = parsed.hostname.toLowerCase();
        if (host.startsWith("www.")) host = host.slice(4);
        if (BLOCKED_HOSTS.has(host)) return false;
        const path = parsed.pathname.replace(/\/+$/, "") || "/";
        const homePaths = new Set([
            "", "/", "/news", "/world", "/sport", "/latest",
            "/en/latest.html", "/category/artificial-intelligence/",
        ]);
        if (homePaths.has(path)) return false;
        const lowerPath = path.toLowerCase();
        if (["/search", "/tag/", "/category/", "/topics/", "/video/", "/tp/"].some(x => lowerPath.includes(x))) return false;
        return path.split("/").length >= 2;
    } catch {
        return false;
    }
}

// ─── Date Parsing ────────────────────────────────────────────

/** Sentinel date indicating the listing page did not expose a publication timestamp; `_read` will replace it. */
export const FALLBACK_DATE = new Date(0);

/** Extract a calendar date (`YYYY/MM/DD` or `YYYY-MM-DD`) from an article URL as a coarse UTC fallback. */
function extractDateFromUrl(url: string): Date | undefined {
    const match = url.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//) ?? url.match(/(20\d{2})-(\d{2})-(\d{2})/);
    if (!match) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
        isNaN(parsed.getTime()) ||
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
    ) {
        return undefined;
    }
    return parsed;
}

function parseSourceDate(dateStr: string, url?: string): Date {
    const trimmed = dateStr.trim();
    if (trimmed) {
        let s = trimmed;
        // InfoQ's RSS generator outputs Beijing local time (UTC+8) with a hardcoded " GMT" suffix
        if (url?.includes("infoq.cn") && s.endsWith(" GMT")) {
            s = s.slice(0, -4) + " +0800";
        }
        // Naive timestamps without timezone offset default to UTC+8
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
            s = s.replace(" ", "T") + "+08:00";
        }
        const parsed = new Date(s);
        if (!isNaN(parsed.getTime())) {
            return parsed;
        }
    }
    if (url) {
        const fromUrl = extractDateFromUrl(url);
        if (fromUrl) return fromUrl;
    }
    return FALLBACK_DATE;
}

// ─── BriefNews Factory ───────────────────────────────────────

function toBriefNews(item: RawNewsItem, sourceName: string): BriefNews {
    return {
        hash_id: generateHashId(item.url, sourceName, item.title),
        url: item.url,
        title: item.title,
        source_date: parseSourceDate(item.time, item.url),
        source_name: sourceName,
        category: item.category,
        raw: item.raw,
        created_at: new Date(),
    };
}

// ─── HTTP Utilities ──────────────────────────────────────────

async function fetchText(url: string, options?: FetchOptions): Promise<string> {
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(options?.fetch_timeout ?? DEFAULT_TIMEOUT_MS),
            headers: {
                "User-Agent": options?.fetch_user_agent ?? USER_AGENT,
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
            throw new Error(
                `Failed to fetch ${url}: ${error.message}`,
                { cause: error },
            );
        }
        throw error;
    }
}

// ─── Google News URL Decoder ─────────────────────────────────

function articleToken(url: string): string | null {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== "news.google.com") return null;
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (parts.length < 2) return null;
        const secondLast = parts[parts.length - 2];
        if (secondLast !== "articles" && secondLast !== "read") return null;
        const token = parts[parts.length - 1];
        return token && token.length <= 4096 ? token : null;
    } catch {
        return null;
    }
}

function isValidPublisherUrl(url: string): boolean {
    if (typeof url !== "string" || url.length > 8192 || /[\x00-\x1f]/.test(url)) return false;
    try {
        const parsed = new URL(url);
        return (
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            !!parsed.hostname &&
            parsed.hostname !== "news.google.com" &&
            !parsed.hostname.endsWith(".news.google.com") &&
            !parsed.username
        );
    } catch {
        return false;
    }
}

function* walkArrays(value: unknown): Generator<unknown[]> {
    if (Array.isArray(value)) {
        yield value;
        for (const child of value) {
            yield* walkArrays(child);
        }
    }
}

async function decodeGoogleNewsParams(
    token: string,
    options?: FetchOptions,
): Promise<{ timestamp: string; signature: string }> {
    const paths = ["rss/articles", "articles"];
    const errors: string[] = [];
    for (const path of paths) {
        try {
            const html = await fetchText(
                `https://news.google.com/${path}/${token}`,
                options,
            );
            const tsMatch = html.match(/data-n-a-ts="(\d+)"/);
            const sgMatch = html.match(/data-n-a-sg="([^"]+)"/);
            if (tsMatch?.[1] && sgMatch?.[1]) {
                return { timestamp: tsMatch[1], signature: sgMatch[1] };
            }
            errors.push("missing_params");
        } catch (error) {
            errors.push(error instanceof Error ? error.constructor.name : "UnknownError");
        }
    }
    throw new Error(`decode_params_failed: ${errors.join(",")}`);
}

async function decodeOneGoogleNewsUrl(
    token: string,
    timestamp: string,
    signature: string,
    options?: FetchOptions,
): Promise<string> {
    const inner = JSON.stringify([
        "garturlreq",
        [
            ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1,
                null, null, null, null, null, 0, 1],
            "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
        ],
        token, parseInt(timestamp, 10), signature,
    ]);
    const payload = JSON.stringify([[["Fbv4je", inner, null, "req0"]]]);
    const formData = `f.req=${encodeURIComponent(payload)}`;

    let body: string;
    try {
        const response = await fetch(
            "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je",
            {
                method: "POST",
                body: formData,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "User-Agent": options?.fetch_user_agent ?? USER_AGENT,
                    "Referer": "https://news.google.com/",
                },
                signal: AbortSignal.timeout(options?.fetch_timeout ?? DEFAULT_TIMEOUT_MS),
            },
        );
        if (!response.ok) {
            throw new Error(`Google News decode POST failed with status ${response.status}`);
        }
        body = await response.text();
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Google News decode POST failed: ${error.message}`, { cause: error });
        }
        throw error;
    }

    for (const line of body.split("\n")) {
        let frame: unknown;
        try {
            frame = JSON.parse(line);
        } catch {
            continue;
        }
        for (const node of walkArrays(frame)) {
            if (Array.isArray(node) && node.length >= 3 && node[0] === "wrb.fr" && node[1] === "Fbv4je") {
                let nested: unknown;
                try {
                    nested = JSON.parse(node[2] as string);
                } catch {
                    continue;
                }
                if (
                    Array.isArray(nested) &&
                    nested.length > 1 &&
                    nested[0] === "garturlres"
                ) {
                    const url = nested[1] as string;
                    if (isValidPublisherUrl(url)) {
                        return url;
                    }
                }
            }
        }
    }
    throw new Error("decode_response_invalid");
}

/** Resolve Google News redirect tokens into direct publisher URLs concurrently. */
async function resolveGoogleNewsUrls(
    urls: string[],
    options?: FetchOptions,
): Promise<DecodeResult[]> {
    const resolveOne = async (url: string): Promise<DecodeResult> => {
        const token = articleToken(url);
        if (token === null) {
            return { status: "passthrough", url };
        }
        try {
            const { timestamp, signature } = await decodeGoogleNewsParams(token, options);
            const resolved = await decodeOneGoogleNewsUrl(token, timestamp, signature, options);
            return { status: "ok", url: resolved };
        } catch {
            return { status: "error", reason: "decode_failed" };
        }
    };

    const settled = await Promise.allSettled(urls.map((u) => resolveOne(u)));
    return settled.map((result) =>
        result.status === "fulfilled"
            ? result.value
            : { status: "error" as const, reason: "unexpected_error" },
    );
}

// ─── Source Extractors ───────────────────────────────────────

function extractBbcSport(html: string): RawNewsItem[] {
    const results: RawNewsItem[] = [];
    const seen = new Set<string>();
    const pattern = /href="((?:https:\/\/www\.bbc\.com)?\/sport\/[^"]+\/articles\/[^"]+)"[^>]*>(.*?)<\/a>/gs;
    for (const m of html.matchAll(pattern)) {
        const rawUrlPath = m[1] ?? "";
        const title = stripTags(m[2] ?? "");
        if (!title || title.length < 10 || seen.has(rawUrlPath)) continue;
        seen.add(rawUrlPath);
        const url = rawUrlPath.startsWith("http") ? rawUrlPath : `https://www.bbc.com${rawUrlPath}`;
        if (!isArticleUrl(url)) continue;
        const cat = rawUrlPath.includes("football")
            ? "football"
            : rawUrlPath.includes("formula1")
                ? "f1"
                : "international";
        results.push({
            title,
            url,
            time: "",
            category: cat,
        });
    }
    return results;
}

function extractCnn(html: string): RawNewsItem[] {
    const results: RawNewsItem[] = [];
    const seenUrls = new Set<string>();
    const pattern = /class="[^"]*container__headline[^"]*"[^>]*>(.*?)<\/span>/gs;
    for (const m of html.matchAll(pattern)) {
        const title = stripTags(m[1] ?? "");
        if (!title || title.length < 20) continue;
        if (title.startsWith(".") || title.startsWith("{") || title.startsWith("@") ||
            title.startsWith("function") || title.startsWith("var ") || title.startsWith("const ")) continue;
        if (title.includes("{") || title.includes("padding") || title.includes("margin")) continue;
        const pos = m.index ?? 0;
        const before = html.slice(Math.max(0, pos - 3000), pos);
        const allLinks = [...before.matchAll(/<a[^>]*href="(\/20\d{2}\/\d{2}\/\d{2}\/[^"]+)"/g)];
        const filtered = allLinks.filter((g) => !g[1]?.includes("/live-news/"));
        const lastLink = filtered[filtered.length - 1];
        const path = lastLink?.[1] ?? "";
        const fullUrl = path ? `https://edition.cnn.com${path}` : "";
        if (!fullUrl || !isArticleUrl(fullUrl)) continue;
        if (seenUrls.has(fullUrl)) continue;
        seenUrls.add(fullUrl);
        results.push({ title, url: fullUrl, time: "", category: "international" });
    }
    return results.slice(0, 50);
}

function extractMarca(html: string): RawNewsItem[] {
    const results: RawNewsItem[] = [];
    const seen = new Set<string>();

    // Article cards: <h2> with backward <a href> search
    const h2Pattern = /<h2[^>]*>(.*?)<\/h2>/gs;
    for (const m of html.matchAll(h2Pattern)) {
        const title = stripTags(m[1] ?? "");
        if (!title || title.length < 15 || seen.has(title)) continue;
        const pos = m.index ?? 0;
        const before = html.slice(Math.max(0, pos - 2000), pos);
        const aLinks = [...before.matchAll(/href="(https:\/\/www\.marca\.com\/[^"]+)"/g)];
        const lastLink = aLinks[aLinks.length - 1];
        const url = lastLink?.[1] ?? "";
        if (!url || seen.has(url) || !isArticleUrl(url)) continue;
        // Marca's Real Madrid hub hosts articles under /en/football/... (e.g. /spanish-football/),
        // while sidebar widgets include unrelated /nfl/, /nba/, and /lifestyle/ links.
        if (!url.toLowerCase().includes("/football/")) continue;
        seen.add(url);
        seen.add(title);
        results.push({ title, url, time: "", category: "realmadrid" });
    }
    return results;
}

function extractF1(html: string): RawNewsItem[] {
    const results: RawNewsItem[] = [];
    const pattern = /href="(\/en\/latest\/article\/[^"]+)"[^>]*>(.*?)<\/a>/gs;
    for (const m of html.matchAll(pattern)) {
        const urlPath = m[1] ?? "";
        const title = stripTags(m[2] ?? "");
        const url = `https://www.formula1.com${urlPath}`;
        if (title && title.length > 10 && isArticleUrl(url)) {
            results.push({
                title,
                url,
                time: "",
                category: "f1",
            });
        }
    }
    return results;
}

function extractTechcrunch(html: string): RawNewsItem[] {
    const results: RawNewsItem[] = [];
    const seen = new Set<string>();
    const pattern = /href="(https:\/\/techcrunch\.com\/20\d{2}\/\d{2}\/\d{2}\/[^"]+)"[^>]*>(.*?)<\/a>/gs;
    for (const m of html.matchAll(pattern)) {
        const url = m[1] ?? "";
        const title = stripTags(m[2] ?? "");
        if (!title || title.length < 10 || seen.has(url) || !isArticleUrl(url)) continue;
        seen.add(url);
        // Search forward for nearest <time datetime> (~500 chars)
        const afterStart = (m.index ?? 0) + m[0].length;
        const after = html.slice(afterStart, afterStart + 500);
        const timeMatch = after.match(/<time[^>]*datetime="([^"]+)"/);
        results.push({
            title,
            url,
            time: timeMatch?.[1] ?? "",
            category: "ai",
        });
    }
    return results;
}

function extractGlobalTimes(html: string): RawNewsItem[] {
    const results: RawNewsItem[] = [];
    const seenUrls = new Set<string>();
    // Global Times homepage uses <a> tags with class="new_title_s", "new_title_m", "new_title_ml"
    const pattern = /<a[^>]*href="(https?:\/\/www\.globaltimes\.cn\/page\/\d+\/\d+\.shtml)"[^>]*class="new_title_[sml][l]?"[^>]*>([^<]+)<\/a>/g;
    const patternAlt = /<a[^>]*class="new_title_[sml][l]?"[^>]*href="(https?:\/\/www\.globaltimes\.cn\/page\/\d+\/\d+\.shtml)"[^>]*>([^<]+)<\/a>/g;

    for (const m of html.matchAll(pattern)) {
        const url = m[1] ?? "";
        const title = stripTags(m[2] ?? "");
        if (!title || title.length < 10 || !isArticleUrl(url)) continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        results.push({ title, url, time: "", category: "domestic" });
    }
    // Also match the alternate attribute order (class before href)
    for (const m of html.matchAll(patternAlt)) {
        const url = m[1] ?? "";
        const title = stripTags(m[2] ?? "");
        if (!title || title.length < 10 || !isArticleUrl(url)) continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        results.push({ title, url, time: "", category: "domestic" });
    }
    return results.slice(0, 30);
}

/**
 * Parse both RSS 2.0 (`<item>`) and Atom 1.0 (`<entry>`) feeds into raw items.
 * Set `includeDescription` to false for aggregator feeds (like Google News) whose
 * `<description>` only echoes the headline and publisher name.
 */
function extractRss(xml: string, includeDescription = true): RawNewsItem[] {
    const results: RawNewsItem[] = [];
    const itemPattern = /<(item|entry)(?:\s[^>]*)?>(.*?)<\/\1>/gs;
    for (const m of xml.matchAll(itemPattern)) {
        const isAtom = m[1] === "entry";
        const entry = m[2] ?? "";

        const titleMatch = entry.match(/<title(?:\s[^>]*)?>(.*?)<\/title>/s);
        if (!titleMatch?.[1]) continue;
        const title = htmlUnescape(stripCdata(titleMatch[1]));
        if (!title || title.length <= 5) continue;

        let url = "";
        if (isAtom) {
            const linkMatch =
                entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i) ??
                entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*\/?>/i) ??
                entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
            url = linkMatch?.[1] ?? "";
        } else {
            const linkMatch = entry.match(/<link(?:\s[^>]*)?>(.*?)<\/link>/s);
            url = linkMatch?.[1] ? stripCdata(linkMatch[1]) : "";
        }
        url = htmlUnescape(url).trim();
        if (!url) continue;

        const dateMatch =
            entry.match(/<pubDate(?:\s[^>]*)?>(.*?)<\/pubDate>/s) ??
            entry.match(/<published(?:\s[^>]*)?>(.*?)<\/published>/s) ??
            entry.match(/<updated(?:\s[^>]*)?>(.*?)<\/updated>/s);
        const time = dateMatch?.[1] ? htmlUnescape(stripCdata(dateMatch[1])) : "";

        // Extract description/content — used as pre-populated `raw` for sources
        // whose article pages are inaccessible (Motorsport.com / RaceFans) or
        // already publish full articles in RSS (TMTPost `<content:encoded>`).
        let raw: string | undefined;
        if (includeDescription) {
            const descMatch =
                entry.match(/<content:encoded(?:\s[^>]*)?>(.*?)<\/content:encoded>/s) ??
                entry.match(/<description(?:\s[^>]*)?>(.*?)<\/description>/s) ??
                entry.match(/<content(?:\s[^>]*)?>(.*?)<\/content>/s) ??
                entry.match(/<summary(?:\s[^>]*)?>(.*?)<\/summary>/s);
            if (descMatch?.[1]) {
                let desc = htmlUnescape(stripCdata(descMatch[1]));
                // Strip trailing "Keep reading" link
                desc = desc.replace(/<a[^>]*class=['"]more['"][^>]*>.*?<\/a>/gi, "");
                const pMatches = [...desc.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
                    .map(p => stripTags(p[1] ?? "").replace(/\s+/g, " ").trim())
                    .filter(Boolean);
                const strippedAll = stripTags(desc).replace(/\s+/g, " ").trim();
                const pText = pMatches.join("\n\n");
                const text = pMatches.length > 0 && pText.length >= strippedAll.length * 0.5
                    ? pText
                    : strippedAll;
                if (text.length > 40) raw = text;
            }
        }

        const resultItem: RawNewsItem = {
            title,
            url,
            time,
            category: "international", // Default; overridden by feed config
        };
        if (raw) {
            resultItem.raw = raw;
        }
        results.push(resultItem);
    }
    return results;
}

// ─── Source Fetchers ─────────────────────────────────────────

async function fetchAndExtractHtml(
    url: string,
    sourceName: string,
    extractor: (html: string) => RawNewsItem[],
    options?: FetchOptions,
): Promise<BriefNews[]> {
    try {
        const html = await fetchText(url, options);
        return extractor(html).map((item) => toBriefNews(item, sourceName));
    } catch (error) {
        if (error instanceof Error) {
            logExpectedError(error);
            return [];
        }
        throw error;
    }
}

async function fetchBbcSport(options?: FetchOptions): Promise<BriefNews[]> {
    return fetchAndExtractHtml("https://www.bbc.com/sport", "BBC Sport", extractBbcSport, options);
}

async function fetchCnnWorld(options?: FetchOptions): Promise<BriefNews[]> {
    return fetchAndExtractHtml("https://edition.cnn.com/world", "CNN", extractCnn, options);
}

async function fetchMarca(options?: FetchOptions): Promise<BriefNews[]> {
    return fetchAndExtractHtml(
        "https://www.marca.com/en/football/real-madrid.html",
        "Marca",
        extractMarca,
        options,
    );
}

async function fetchF1(options?: FetchOptions): Promise<BriefNews[]> {
    return fetchAndExtractHtml(
        "https://www.formula1.com/en/latest.html",
        "Formula 1",
        extractF1,
        options,
    );
}

async function fetchTechcrunch(options?: FetchOptions): Promise<BriefNews[]> {
    return fetchAndExtractHtml(
        "https://techcrunch.com/category/artificial-intelligence/",
        "TechCrunch",
        extractTechcrunch,
        options,
    );
}

async function fetchGlobalTimes(options?: FetchOptions): Promise<BriefNews[]> {
    return fetchAndExtractHtml("https://www.globaltimes.cn/", "Global Times", extractGlobalTimes, options);
}

// ─── RSS Feed Configuration ─────────────────────────────────

const RSS_FEEDS: Record<string, RssFeedConfig> = {
    bbc_world: {
        url: "https://feeds.bbci.co.uk/news/world/rss.xml",
        category: "international",
        sourceName: "BBC",
    },
    aljazeera: {
        url: "https://www.aljazeera.com/xml/rss/all.xml",
        category: "international",
        sourceName: "Al Jazeera",
    },
    france24: {
        url: "https://www.france24.com/en/rss",
        category: "international",
        sourceName: "France 24",
    },
    gn_international: {
        url: "https://news.google.com/rss/search?q=international+news&hl=en-US&gl=US&ceid=US:en",
        category: "international",
        sourceName: "Google News",
    },
    gn_chinanews: {
        url: "https://news.google.com/rss/search?q=China&hl=en-US&gl=US&ceid=US:en",
        category: "international",
        sourceName: "Google News",
    },
    gn_realmadrid: {
        url: "https://news.google.com/rss/search?q=%22Real+Madrid%22+when:2d&hl=en-US&gl=US&ceid=US:en",
        category: "realmadrid",
        sourceName: "Google News",
    },
    managing_madrid: {
        url: "https://www.managingmadrid.com/rss/index.xml",
        category: "realmadrid",
        sourceName: "Managing Madrid",
    },
    football_espana: {
        url: "https://football-espana.net/category/real-madrid/feed",
        category: "realmadrid",
        sourceName: "Football España",
    },
    gn_f1: {
        url: "https://news.google.com/rss/search?q=Formula+1+Ferrari+Leclerc&hl=en-US&gl=US&ceid=US:en",
        category: "f1",
        sourceName: "Google News",
    },
    racefans: {
        url: "https://www.racefans.net/feed/",
        category: "f1",
        sourceName: "RaceFans",
    },
    gn_mlb: {
        url: "https://news.google.com/rss/search?q=MLB+Dodgers&hl=en-US&gl=US&ceid=US:en",
        category: "mlb",
        sourceName: "Google News",
    },
    gn_ai: {
        url: "https://news.google.com/rss/search?q=AI+large+language+model&hl=en-US&gl=US&ceid=US:en",
        category: "ai",
        sourceName: "Google News",
    },
    cgtn_china: {
        url: "https://www.cgtn.com/subscribe/rss/section/china.xml",
        category: "domestic",
        sourceName: "CGTN",
    },
    gn_football: {
        url: "https://news.google.com/rss/search?q=(football+OR+soccer)+AND+(%22Champions+League%22+OR+%22Premier+League%22+OR+%22La+Liga%22+OR+%22Serie+A%22+OR+%22Bundesliga%22+OR+%22UEFA%22+OR+%22transfer+news%22)+-nfl+-rugby+-hockey&hl=en-US&gl=US&ceid=US:en",
        category: "football",
        sourceName: "Google News",
    },
    gn_wtt: {
        url: "https://news.google.com/rss/search?q=WTT+table+tennis&hl=en-US&gl=US&ceid=US:en",
        category: "tabletennis",
        sourceName: "Google News",
    },
    gn_ttcn: {
        url: "https://news.google.com/rss/search?q=China+table+tennis&hl=en-US&gl=US&ceid=US:en",
        category: "tabletennis",
        sourceName: "Google News",
    },
    motorsport: {
        url: "https://www.motorsport.com/rss/f1/news/",
        category: "f1",
        sourceName: "Motorsport.com",
    },
    chinanews: {
        url: "https://www.chinanews.com.cn/rss/scroll-news.xml",
        category: "domestic",
        sourceName: "中新网",
    },
    jiemian: {
        url: "https://a.jiemian.com/index.php?m=article&a=rss",
        category: "domestic",
        sourceName: "界面新闻",
    },
    qbitai: {
        url: "https://www.qbitai.com/feed",
        category: "ai",
        sourceName: "量子位",
    },
    tmtpost: {
        url: "https://www.tmtpost.com/rss.xml",
        category: "ai",
        sourceName: "钛媒体",
    },
    infoq_cn: {
        url: "https://www.infoq.cn/feed",
        category: "ai",
        sourceName: "InfoQ 中文",
    },
};

async function fetchRssFeed(feedKey: string, options?: FetchOptions): Promise<BriefNews[]> {
    const config = RSS_FEEDS[feedKey];
    if (!config) throw new Error(`Unknown RSS feed: ${feedKey}`);

    try {
        const xml = await fetchText(config.url, options);
        // Google News RSS descriptions only echo the headline/source, so leave `raw` unset to force full article reading
        const rawItems = extractRss(xml, config.sourceName !== "Google News");
        // Override category from feed config
        for (const item of rawItems) {
            item.category = config.category;
        }

        // Collect URLs to resolve (limit to MAX_DECODE_ITEMS)
        const limit = options?.fetch_max_decode_items ?? MAX_DECODE_ITEMS;
        const urlsToResolve = rawItems.slice(0, limit).map((item) => item.url);
        const resolved = await resolveGoogleNewsUrls(urlsToResolve, options);

        const results: BriefNews[] = [];
        for (let i = 0; i < rawItems.length; i++) {
            const item = rawItems[i]!;
            if (i < resolved.length) {
                const result = resolved[i]!;
                if (result.status === "ok" && result.url) {
                    item.url = result.url;
                } else if (result.status === "error") {
                    continue; // Skip items with failed Google News URL resolution
                }
                // "passthrough": keep original URL (already a direct link)
            } else {
                // Beyond resolution limit — skip if it's a Google News wrapper
                if (articleToken(item.url) !== null) continue;
            }

            // Validate that the final URL is a plausible article URL (skip if not)
            if (item.url && !isArticleUrl(item.url)) continue;

            results.push(toBriefNews(item, config.sourceName));
        }
        return results;
    } catch (error) {
        if (error instanceof Error) {
            logExpectedError(error);
            return [];
        }
        throw error;
    }
}

// ─── Category Mapping & Unified Entry ────────────────────────

type SourceFetcher = (options?: FetchOptions) => Promise<BriefNews[]>;

const CATEGORY_SOURCES: Record<NewsCategory, SourceFetcher[]> = {
    international: [
        (opts) => fetchRssFeed("bbc_world", opts),
        fetchCnnWorld,
        (opts) => fetchRssFeed("aljazeera", opts),
        (opts) => fetchRssFeed("france24", opts),
        (opts) => fetchRssFeed("gn_international", opts),
        (opts) => fetchRssFeed("gn_chinanews", opts),
    ],
    football: [
        fetchBbcSport,
        (opts) => fetchRssFeed("gn_football", opts),
    ],
    realmadrid: [
        fetchMarca,
        (opts) => fetchRssFeed("managing_madrid", opts),
        (opts) => fetchRssFeed("football_espana", opts),
        (opts) => fetchRssFeed("gn_realmadrid", opts),
    ],
    f1: [
        fetchF1,
        (opts) => fetchRssFeed("racefans", opts),
        fetchBbcSport,
        (opts) => fetchRssFeed("gn_f1", opts),
        (opts) => fetchRssFeed("motorsport", opts),
    ],
    ai: [
        fetchTechcrunch,
        (opts) => fetchRssFeed("gn_ai", opts),
        (opts) => fetchRssFeed("qbitai", opts),
        (opts) => fetchRssFeed("tmtpost", opts),
        (opts) => fetchRssFeed("infoq_cn", opts),
    ],
    mlb: [
        (opts) => fetchRssFeed("gn_mlb", opts),
    ],
    domestic: [
        fetchGlobalTimes,
        (opts) => fetchRssFeed("cgtn_china", opts),
        (opts) => fetchRssFeed("chinanews", opts),
        (opts) => fetchRssFeed("jiemian", opts),
    ],
    tabletennis: [
        (opts) => fetchRssFeed("gn_wtt", opts),
        (opts) => fetchRssFeed("gn_ttcn", opts),
    ],
};

interface FetchArguments {
    category: NewsCategory;
    options: FetchOptions;
}

/**
 * Fetch all news for a given category from every related source.
 * Sources run concurrently. Expected errors per source yield empty results
 * without affecting other sources. Results are deduplicated by canonical URL.
 */
export async function fetchNewsByCategory({ category, options }: FetchArguments): Promise<Map<string, BriefNews>> {
    const sources = CATEGORY_SOURCES[category];
    if (!sources) {
        throw new TypeError(`Invalid or unsupported category: ${category}`);
    }

    const settled = await Promise.allSettled(sources.map((fn) => fn(options)));
    const allNews = new Map<string, BriefNews>();
    const seenUrls = new Set<string>();

    for (const result of settled) {
        if (result.status === "rejected") {
            // Bubble up unexpected internal errors
            throw result.reason;
        }
        for (const news of result.value) {
            // Filter by requested category (some sources return mixed categories)
            if (news.category !== category) continue;
            const canonical = canonicalUrl(news.url);
            if (canonical && seenUrls.has(canonical)) continue;
            if (canonical) seenUrls.add(canonical);
            allNews.set(news.hash_id, news);
        }
    }
    return allNews;
}
