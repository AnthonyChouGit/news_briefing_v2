import { randomUUID } from "node:crypto";
import {
    createAnthropic,
    type AnthropicLanguageModelOptions,
    type AnthropicProviderSettings
} from "@ai-sdk/anthropic";
import {
    createOpenAI,
    type OpenAILanguageModelResponsesOptions,
    type OpenAIProviderSettings
} from "@ai-sdk/openai";
import {
    createOpenAICompatible,
    type OpenAICompatibleProviderSettings
} from "@ai-sdk/openai-compatible";
import {
    extractJsonMiddleware,
    generateText,
    Output,
    wrapLanguageModel
} from "ai";
import { jsonrepair } from "jsonrepair";
import { z, type ZodType } from "zod";

/**
 * Reasoning effort level passed to models that support extended thinking
 * (e.g., OpenAI reasoning or Claude adaptive thinking).
 */
export const AIReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).optional();
export type AIReasoningEffort = z.infer<typeof AIReasoningEffortSchema>;

/**
 * Supported upstream API protocol types:
 * - `openai`: OpenAI Responses API (`/responses`)
 * - `anthropic`: Anthropic Messages API (`/messages`)
 * - `openai-compatible`: OpenAI Chat Completions compatible API (`/chat/completions`)
 */
export const AIProviderTypeSchema = z.enum(["openai", "anthropic", "openai-compatible"]);
export type AIProviderType = z.infer<typeof AIProviderTypeSchema>;

/**
 * Zod schema for validating `AIClient` initialization configuration.
 */
export const AIClientConfigSchema = z.object({
    ai_api_key: z.string().nonempty(),
    ai_base_url: z.string().nonempty(),
    ai_model: z.string().nonempty(),
    ai_timeout: z.coerce.number().int().positive().default(300000),
    // 0 is allowed and disables retries
    ai_max_retries: z.coerce.number().int().nonnegative().default(3),
    // Explicit output cap. Without it, ai-sdk limits models it does not recognize
    // (e.g., Anthropic-protocol third-party models) to 4096 tokens, which can truncate JSON.
    ai_max_output_tokens: z.coerce.number().int().positive().default(16384),
    ai_reasoning_effort: AIReasoningEffortSchema,
    ai_provider_type: AIProviderTypeSchema
});
export type AIClientConfig = z.infer<typeof AIClientConfigSchema>;

/**
 * Provider name used for `openai-compatible`. It is both the `name` passed to
 * `createOpenAICompatible` and the key under `providerOptions`, so the two must match.
 */
const OPENAI_COMPATIBLE_PROVIDER_NAME = "openaiCompatible";

type ProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];

/** Compile-time exhaustiveness guard for `switch` statements over a union type. */
function assertNever(value: never): never {
    throw new Error(`Unsupported AI provider type: ${String(value)}`);
}

const isJsonStart = (text: string): boolean => text.startsWith("{") || text.startsWith("[");

/** Removes inline `<think>...</think>` blocks emitted by reasoning models. */
function stripThinking(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Returns the content of the first Markdown code fence (```` ```json ... ``` ````), or the input if none. */
function extractFencedBlock(text: string): string {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    return match?.[1] ? match[1].trim() : text;
}

/** Slices from the first `{` / `[` to the last matching closing char, dropping surrounding prose. */
function sliceOuterJson(text: string): string {
    const firstBrace = text.indexOf("{");
    const firstBracket = text.indexOf("[");

    let startIdx = -1;
    let closeChar = "";
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        startIdx = firstBrace;
        closeChar = "}";
    } else if (firstBracket !== -1) {
        startIdx = firstBracket;
        closeChar = "]";
    }
    if (startIdx === -1) {
        return text;
    }

    const endIdx = text.lastIndexOf(closeChar);
    return endIdx >= startIdx ? text.slice(startIdx, endIdx + 1) : text;
}

/**
 * Extracts and repairs valid JSON from raw model text output:
 * 1. Strips `<think>` blocks.
 * 2. When the text does not already start with `{` / `[`, strips Markdown code fences
 *    and then surrounding prose (skipped otherwise, to avoid corrupting backticks/brackets inside JSON strings).
 * 3. Applies `jsonrepair` to fix trailing commas, unescaped quotes, and minor syntax issues.
 */
function repairJsonText(rawText: string): string {
    let candidate = stripThinking(rawText);
    if (!candidate) {
        return "";
    }

    if (!isJsonStart(candidate)) {
        candidate = extractFencedBlock(candidate);
        if (!isJsonStart(candidate)) {
            candidate = sliceOuterJson(candidate);
        }
    }

    try {
        return jsonrepair(candidate);
    } catch {
        // Keep the candidate text on repair failure so Output.object / JSON.parse raises a clear error
        return candidate;
    }
}

/**
 * Instantiates the underlying provider language model according to `ai_provider_type`.
 */
function createBaseModel(config: AIClientConfig): Parameters<typeof wrapLanguageModel>[0]["model"] {
    // OpenCode Zen gateways use the x-opencode-session header for session tracking
    const headers = config.ai_base_url.includes("opencode")
        ? { "x-opencode-session": randomUUID() }
        : undefined;

    switch (config.ai_provider_type) {
        case "openai": {
            const settings: OpenAIProviderSettings = {
                apiKey: config.ai_api_key,
                baseURL: config.ai_base_url,
                ...(headers ? { headers } : {})
            };
            return createOpenAI(settings)(config.ai_model);
        }
        case "anthropic": {
            const settings: AnthropicProviderSettings = {
                apiKey: config.ai_api_key,
                baseURL: config.ai_base_url,
                ...(headers ? { headers } : {})
            };
            return createAnthropic(settings)(config.ai_model);
        }
        case "openai-compatible": {
            const settings: OpenAICompatibleProviderSettings = {
                name: OPENAI_COMPATIBLE_PROVIDER_NAME,
                apiKey: config.ai_api_key,
                baseURL: config.ai_base_url,
                // @ai-sdk/openai-compatible defaults supportsStructuredOutputs to false;
                // enable it explicitly so response_format: { type: "json_schema" } is sent instead of json_object.
                supportsStructuredOutputs: true,
                ...(headers ? { headers } : {})
            };
            return createOpenAICompatible(settings)(config.ai_model);
        }
        default:
            return assertNever(config.ai_provider_type);
    }
}

/**
 * Builds provider-specific options (only when a reasoning effort is configured).
 */
function buildProviderOptions(
    providerType: AIProviderType,
    effort: AIReasoningEffort
): ProviderOptions {
    if (!effort) {
        return undefined;
    }

    switch (providerType) {
        case "openai": {
            const options = {
                reasoningEffort: effort
            } satisfies OpenAILanguageModelResponsesOptions;
            return { openai: options };
        }
        case "anthropic": {
            const options = {
                effort,
                thinking: { type: "adaptive" as const }
            } satisfies AnthropicLanguageModelOptions;
            return { anthropic: options };
        }
        case "openai-compatible":
            return { [OPENAI_COMPATIBLE_PROVIDER_NAME]: { reasoningEffort: effort } };
        default:
            return assertNever(providerType);
    }
}

/**
 * Single-turn structured output client unified on the Vercel AI SDK.
 * Supports `openai`, `anthropic`, and `openai-compatible` providers, combining
 * response repair middleware with Zod schema validation to guarantee valid JSON output.
 */
export class AIClient {
    private readonly model: ReturnType<typeof wrapLanguageModel>;
    private readonly provider_options: ProviderOptions;
    private readonly timeout: number;
    private readonly max_retries: number;
    private readonly max_output_tokens: number;

    constructor(config: AIClientConfig) {
        this.timeout = config.ai_timeout;
        this.max_retries = config.ai_max_retries;
        this.max_output_tokens = config.ai_max_output_tokens;
        this.provider_options = buildProviderOptions(config.ai_provider_type, config.ai_reasoning_effort);

        // Run extractJsonMiddleware before ai-sdk parses Output.object to normalize
        // code fences, surrounding prose, thinking tags, and minor JSON syntax issues.
        this.model = wrapLanguageModel({
            model: createBaseModel(config),
            middleware: extractJsonMiddleware({ transform: repairJsonText })
        });
    }

    /**
     * Executes a single-turn structured generation request and returns a typed object
     * validated against the provided Zod schema.
     *
     * @param prompt User prompt or input payload text for this turn
     * @param instruction Optional system instructions (`undefined` to omit)
     * @param response_schema Zod schema used to constrain output and validate the result
     * @param signal Optional `AbortSignal` for cancelling execution (e.g., from `light-dag`)
     * @returns Parsed and Zod-validated structured output
     */
    public async ask<T extends ZodType>(
        prompt: string,
        instruction: string | undefined,
        response_schema: T,
        signal?: AbortSignal
    ): Promise<z.infer<T>> {
        const result = await generateText({
            model: this.model,
            prompt,
            ...(instruction ? { instructions: instruction } : {}),
            output: Output.object({ schema: response_schema }),
            timeout: this.timeout,
            maxRetries: this.max_retries,
            maxOutputTokens: this.max_output_tokens,
            ...(signal ? { abortSignal: signal } : {}),
            ...(this.provider_options ? { providerOptions: this.provider_options } : {})
        });

        // ai-sdk only populates result.output when finishReason === "stop";
        // reading result.output on other finish reasons (e.g., "other" or "length") throws NoOutputGeneratedError.
        if (result.finishReason === "stop") {
            return result.output as z.infer<T>;
        }

        // Fallback for non-"stop" completions: repair remaining text and validate via Zod
        const repaired = repairJsonText(result.text);
        if (repaired.length > 0) {
            try {
                const parsed: unknown = JSON.parse(repaired);
                return response_schema.parse(parsed);
            } catch (err) {
                throw new Error(
                    `AI structured output ended with finishReason="${result.finishReason}" and JSON fallback failed: ${err instanceof Error ? err.message : String(err)}`,
                    { cause: err }
                );
            }
        }

        throw new Error(
            `AI structured output did not finish normally (finishReason="${result.finishReason}") and returned empty content.`
        );
    }
}
