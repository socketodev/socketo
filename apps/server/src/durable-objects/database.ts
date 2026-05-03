import { DurableObject } from 'cloudflare:workers'
import type { Kysely } from 'kysely'
import { createDatabase } from '@/database/client'
import { createMigrator } from '@/database/migrations'
import type { Database } from '@/database/types'

export class DatabaseDO extends DurableObject<Env> {
  private db: Kysely<Database>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    this.db = createDatabase(ctx.storage.sql)

    ctx.blockConcurrencyWhile(async () => {
      await this.migrate()
    })
  }

  public async getAppByKey(key: string) {
    return this.db
      .selectFrom('apps')
      .selectAll()
      .where('key', '=', key)
      .executeTakeFirst()
  }

  async migrate() {
    return createMigrator(this.db).migrateToLatest()
  }
}
