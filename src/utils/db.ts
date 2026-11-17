import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type { BriefNews } from "../operators/common/BriefNews.schema.js";
import { type DBConfig } from "../config.js";
import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";


interface BriefNewsTable {
    hash_id: BriefNews["hash_id"];
    url: BriefNews["url"];
    title: BriefNews["title"];
    source_date: ColumnType<Date, Date | string, Date | string>;
    source_name: BriefNews["source_name"];
    category: BriefNews["category"];
    bullets: ColumnType<string[] | null, string[] | null | undefined, string[] | null | undefined>;
    raw: ColumnType<string | null, string | null | undefined, string | null | undefined>;
    created_at: Generated<Date>;
}

type BriefNewsSelect = Selectable<BriefNewsTable>;
type BriefNewsInsert = Insertable<BriefNewsTable>;

interface BriefNewsDatabase {
    brief_news: BriefNewsTable;
}

export class BriefNewsRepository {

    private db: Kysely<BriefNewsDatabase>;

    constructor(config: DBConfig) {
        const dialect = new PostgresDialect({
            pool: new Pool({
                database: config.db_name,
                host: config.db_host,
                port: config.db_port,
                user: config.db_user,
                password: config.db_password
            })
        });
        this.db = new Kysely<BriefNewsDatabase>({
            dialect
        });
    }

    async findRecentByHours(
        hours: number,
        category ?: BriefNews["category"],
        signal ?: AbortSignal,
    ): Promise < BriefNewsSelect[] > {
        const sinceDate = new Date(Date.now() - hours * 60 * 60 * 1000);
        let query = this.db
            .selectFrom("brief_news")
            .selectAll()
            .where("source_date", ">=", sinceDate);

        if(category !== undefined) {
            query = query.where("category", "=", category);
        }

        // Forward AbortSignal to Kysely and cancel any in-flight PostgreSQL query on abort
        return await query.execute({ signal, inflightQueryAbortStrategy: "cancel query" });
    }

    async saveNew(items: BriefNewsInsert[], signal ?: AbortSignal): Promise < void> {
            // Reject immediately if already aborted, even when `items` is empty
            signal?.throwIfAborted();
        if(items.length === 0) {
            return;
        }

        await this.db
            .insertInto("brief_news")
            .values(items)
            .onConflict((oc) => oc.doNothing())
            .execute({ signal, inflightQueryAbortStrategy: "cancel query" });
    }

    /**
     * Deletes news items whose `source_date` is strictly older than `hours` hours ago,
     * optionally scoped to a single category.
     *
     * @returns Number of deleted rows.
     */
    async deleteOlderThanHours(
        hours: number,
        category?: BriefNews["category"],
        signal?: AbortSignal,
    ): Promise<number> {
        if (!Number.isFinite(hours) || hours <= 0) {
            throw new RangeError(`Expected positive finite hours, received: ${hours}`);
        }

        const beforeDate = new Date(Date.now() - hours * 60 * 60 * 1000);
        let query = this.db
            .deleteFrom("brief_news")
            .where("source_date", "<", beforeDate);

        if (category !== undefined) {
            query = query.where("category", "=", category);
        }

        // Forward AbortSignal to Kysely and cancel any in-flight PostgreSQL query on abort
        const result = await query.executeTakeFirst({
            signal,
            inflightQueryAbortStrategy: "cancel query",
        });
        return Number(result?.numDeletedRows ?? 0n);
    }

    async release() {
        await this.db.destroy();
    }

}