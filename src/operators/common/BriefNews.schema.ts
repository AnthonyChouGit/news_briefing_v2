import * as z from "zod";

export const NewsCategorySchema = z.enum([
    "international",
    "football",
    "realmadrid",
    "f1",
    "ai",
    "mlb",
    "domestic",
    "tabletennis",
]);
export type NewsCategory = z.infer<typeof NewsCategorySchema>;

export const BriefNewsSchema = z.object({
    hash_id: z.string().nonempty(),
    url: z.url().nonempty(),
    title: z.string().nonempty(),
    source_date: z.coerce.date(),
    source_name: z.string().nonempty(),
    category: NewsCategorySchema,
    bullets: z.array(z.string().nonempty()).min(3).max(5).nullable().optional(),
    raw: z.string().nullable().optional(),
    created_at: z.coerce.date().optional(),
});
export type BriefNews = z.infer<typeof BriefNewsSchema>;
