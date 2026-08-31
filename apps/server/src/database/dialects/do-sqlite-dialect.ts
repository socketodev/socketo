import type { SqlStorage } from '@cloudflare/workers-types'
import type {
  DatabaseConnection,
  DatabaseIntrospector,
  DatabaseMetadata,
  DatabaseMetadataOptions,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
  SchemaMetadata,
  TableMetadata,
} from 'kysely'
import {
  CompiledQuery,
  DEFAULT_MIGRATION_LOCK_TABLE,
  DEFAULT_MIGRATION_TABLE,
  SqliteAdapter,
  SqliteQueryCompiler,
} from 'kysely'

class DoSqliteAdapter extends SqliteAdapter {}

type SqlValue = ArrayBuffer | string | number | boolean | null
type SqlRow = Record<string, SqlValue>

/**
 * Config for the Durable Object SQLite dialect.
 */
export interface DoSqliteDialectConfig {
  storage: SqlStorage
  onCreateConnection?:
    | ((connection: DatabaseConnection) => Promise<void>)
    | undefined
}

class DoSqliteDriver implements Driver {
  readonly #config: DoSqliteDialectConfig
  #connection?: DatabaseConnection

  constructor(config: DoSqliteDialectConfig) {
    this.#config = { ...config }
  }

  async init(): Promise<void> {
    this.#connection = new DoSqliteConnection(this.#config.storage)

    if (this.#config.onCreateConnection) {
      await this.#config.onCreateConnection(this.#connection)
    }
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#connection)
      throw new Error('Database connection is not initialized')
    return this.#connection
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('BEGIN'))
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'))
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'))
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

class DoSqliteConnection implements DatabaseConnection {
  readonly #storage: SqlStorage

  constructor(storage: SqlStorage) {
    this.#storage = storage
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const cursor = this.#storage.exec(
      compiledQuery.sql,
      ...compiledQuery.parameters,
    )
    // SAFETY: Kysely's O is the row shape requested by this compiled query; normalization preserves its columns.
    const rows = cursor.toArray().map(normalizeRow) as O[]

    return {
      insertId: undefined,
      rows,
      numAffectedRows:
        cursor.rowsWritten > 0 ? BigInt(cursor.rowsWritten) : undefined,
    }
  }

  streamQuery<O>(): AsyncIterableIterator<QueryResult<O>> {
    throw new Error('DO SQLite does not support streaming queries.')
  }
}

function normalizeRow(row: SqlRow) {
  if (!('enable_client_events' in row)) {
    return row
  }

  const value = row.enable_client_events
  return {
    ...row,
    enable_client_events: value === true || value === 1,
  }
}

class DoSqliteIntrospector implements DatabaseIntrospector {
  readonly #db: Kysely<unknown>
  readonly #storage: SqlStorage

  constructor(db: Kysely<unknown>, storage: SqlStorage) {
    this.#db = db
    this.#storage = storage
  }

  async getSchemas(): Promise<SchemaMetadata[]> {
    // SQLite doesn't support schemas.
    return []
  }

  async getTables(
    options: DatabaseMetadataOptions = { withInternalKyselyTables: false },
  ): Promise<TableMetadata[]> {
    let query = this.#db
      // @ts-expect-error - sqlite_master is not in the schema
      .selectFrom('sqlite_master')
      // @ts-expect-error
      .where('type', 'in', ['table', 'view'])
      // @ts-expect-error
      .where('name', 'not like', 'sqlite_%')
      // @ts-expect-error - D1 internal tables
      .where('name', 'not like', '_cf_%')
      .select(['name', 'type', 'sql'])
      .$castTo<{ name: string; type: string; sql: string | null }>()

    if (!options.withInternalKyselyTables) {
      query = query
        // @ts-expect-error
        .where('name', '!=', DEFAULT_MIGRATION_TABLE)
        // @ts-expect-error
        .where('name', '!=', DEFAULT_MIGRATION_LOCK_TABLE)
    }

    const tables = await query.execute()

    if (tables.length === 0) {
      return []
    }

    const columnInfoList = await Promise.all(
      tables.map((table) => {
        const cursor = this.#storage.exec(
          'SELECT * FROM pragma_table_info(?)',
          table.name,
        )
        // SAFETY: pragma_table_info returns the declared SQLite column metadata shape.
        return cursor.toArray() as Array<{
          cid: number
          name: string
          type: string
          notnull: number
          dflt_value: string | null
          pk: number
        }>
      }),
    )

    return tables.map((table, index) => {
      const columnInfo = columnInfoList[index]

      // Find the column that has `autoincrement` from CREATE SQL
      let autoIncrementCol = table.sql
        ?.split(/[(),]/)
        ?.find((it) => it.toLowerCase().includes('autoincrement'))
        ?.split(/\s+/)
        ?.filter(Boolean)?.[0]
        ?.replace(/["`]/g, '')

      // In SQLite, `INTEGER PRIMARY KEY` is always an alias for rowid
      // and auto-increments even without the explicit AUTOINCREMENT keyword.
      if (!autoIncrementCol) {
        const pkCols = columnInfo.filter((r) => r.pk > 0)
        const singlePk = pkCols.length === 1 ? pkCols[0] : undefined
        if (singlePk && singlePk.type.toLowerCase() === 'integer') {
          autoIncrementCol = singlePk.name
        }
      }

      return {
        name: table.name,
        isView: table.type === 'view',
        columns: columnInfo.map((col) => ({
          name: col.name,
          dataType: col.type,
          isNullable: !col.notnull,
          isAutoIncrementing: col.name === autoIncrementCol,
          hasDefaultValue: col.dflt_value != null,
        })),
      }
    })
  }

  async getMetadata(
    options?: DatabaseMetadataOptions,
  ): Promise<DatabaseMetadata> {
    return {
      tables: await this.getTables(options),
    }
  }
}

class DoSqliteQueryCompiler extends SqliteQueryCompiler {}

export class DoSqliteDialect implements Dialect {
  readonly #config: DoSqliteDialectConfig

  constructor(config: DoSqliteDialectConfig) {
    this.#config = { ...config }
  }

  createDriver(): Driver {
    return new DoSqliteDriver(this.#config)
  }

  createQueryCompiler(): QueryCompiler {
    return new DoSqliteQueryCompiler()
  }

  createAdapter(): DialectAdapter {
    return new DoSqliteAdapter()
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new DoSqliteIntrospector(db, this.#config.storage)
  }
}
