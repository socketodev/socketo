import type { Migration, MigrationProvider } from 'kysely'
import { type Kysely, Migrator } from 'kysely'
import type { Database } from './types'

export const migrations: Record<string, Migration> = {
  '001': {
    async up(db) {
      await db.schema
        .createTable('apps')
        .addColumn('id', 'text', (col) => col.unique().primaryKey())
        .addColumn('key', 'text', (col) => col.unique().notNull())
        .addColumn('secret', 'text', (col) => col.notNull())
        .addColumn('max_connections', 'integer', (col) =>
          col.notNull().defaultTo(10_000),
        )
        .addColumn('enable_client_events', 'boolean', (col) =>
          col.notNull().defaultTo(true),
        )
        .execute()
    },
    async down(db) {
      await db.schema.dropTable('apps').execute()
    },
  },
}

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
