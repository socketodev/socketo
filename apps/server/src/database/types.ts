import type { DurableObjectLocationHint } from '@cloudflare/workers-types'
import type { Insertable, Selectable, Updateable } from 'kysely'

export interface Database {
  apps: AppsTable
}

export interface AppsTable {
  id: string
  key: string
  secret: string
  max_connections: number
  enable_client_events: boolean
  location_hint?: DurableObjectLocationHint
}

export type App = Selectable<AppsTable>
export type CreateApp = Insertable<AppsTable>
export type UpdateApp = Updateable<AppsTable>
