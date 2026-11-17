import * as z from "zod";

/** Supported output languages for summarization and briefing formatting. */
export const LanguageSchema = z.enum([
    "English",
    "Chinese",
    "Spanish",
    "French",
    "German",
    "Italian",
    "Portuguese",
    "Russian",
    "Japanese",
    "Korean",
]);

export type Language = z.infer<typeof LanguageSchema>;
