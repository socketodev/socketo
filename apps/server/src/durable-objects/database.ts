import { DurableObject } from 'cloudflare:workers'
import type { WebhookEndpointConfig } from '@socketo/core'
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

  public async getAppByIdOrKey(identifier: string) {
    return this.db
      .selectFrom('apps')
      .selectAll()
      .where((eb) =>
        eb.or([eb('id', '=', identifier), eb('key', '=', identifier)]),
      )
      .executeTakeFirst()
  }

  public async getWebhooksByAppId(
    appId: string,
  ): Promise<WebhookEndpointConfig[]> {
    const rows = await this.db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('app_id', '=', appId)
      .where('is_enabled', '=', 1)
      .execute()

    return rows.map((r) => {
      let events: string[] = []
      try {
        const parsed = JSON.parse(r.events)
        if (Array.isArray(parsed)) {
          events = parsed
        }
      } catch {
        events = []
      }
      return {
        id: r.id,
        url: r.url,
        events,
        isEnabled: r.is_enabled === 1,
      }
    })
  }

  async migrate() {
    const migrator = createMigrator(this.db)
    const { error, results } = await migrator.migrateToLatest()
    if (error) {
      throw error
    }
    return { results }
  }
}
