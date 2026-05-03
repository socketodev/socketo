import { Kysely } from 'kysely'
import { DoSqliteDialect } from './dialects/do-sqlite-dialect'
import type { Database } from './types'

export function createDatabase(storage: SqlStorage) {
  return new Kysely<Database>({
    dialect: new DoSqliteDialect({ storage }),
  })
}
