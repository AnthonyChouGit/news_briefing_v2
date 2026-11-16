import * as z from "zod";

const DbConfigSchema = z.object({
    db_host: z.string().nonempty().default("localhost"),
    db_port: z.coerce.number().int().positive().default(5432),
    db_user: z.string().nonempty(),
    db_password: z.string(),
    db_name: z.string().nonempty()
});
export type DBConfig = z.infer<typeof DbConfigSchema>;