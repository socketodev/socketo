import type { Migration, MigrationProvider } from 'kysely'
import { type Kysely, Migrator, sql } from 'kysely'
import type { Database } from './types'

export const migrations = {
  '001': {
    async up(db) {
      await db.schema
        .createTable('apps')
        .addColumn('id', 'text', (col) => col.primaryKey().unique())
        .addColumn('key', 'text', (col) => col.unique().notNull())
        .addColumn('secret', 'text', (col) => col.notNull())
        .addColumn('max_connections', 'integer', (col) =>
          col.notNull().defaultTo(10000),
        )
        .addColumn('enable_client_events', 'integer', (col) =>
          col.notNull().defaultTo(1),
        )
        .addColumn('location_hint', 'text')
        .execute()
    },
    async down(db) {
      await db.schema.dropTable('apps').execute()
    },
  },
  '002': {
    async up(db) {
      await db.schema
        .createTable('webhook_endpoints')
        .addColumn('id', 'text', (col) => col.primaryKey().unique())
        .addColumn('app_id', 'text', (col) =>
          col.references('apps.id').onDelete('cascade').notNull(),
        )
        .addColumn('url', 'text', (col) => col.notNull())
        .addColumn('events', 'text', (col) => col.notNull())
        .addColumn('is_enabled', 'integer', (col) => col.notNull().defaultTo(1))
        .addColumn('created_at', 'text', (col) =>
          col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
        )
        .execute()
      await db.schema
        .createIndex('idx_webhook_endpoints_app_id')
        .on('webhook_endpoints')
        .column('app_id')
        .execute()
    },
    async down(db) {
      await db.schema.dropTable('webhook_endpoints').execute()
    },
  },
} satisfies Record<string, Migration>

class ObjectMigrationProvider implements MigrationProvider {
  getMigrations() {
    return Promise.resolve(migrations)
  }
}

export function createMigrator(storage: Kysely<Database>) {
  return new Migrator({
    db: storage,
    provider: new ObjectMigrationProvider(),
  })
}
