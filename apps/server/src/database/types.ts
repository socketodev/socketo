import type { DurableObjectLocationHint } from '@cloudflare/workers-types'
import type { Insertable, Selectable, Updateable } from 'kysely'

export interface Database {
  apps: AppsTable
  webhook_endpoints: WebhookEndpointsTable
}

export interface AppsTable {
  id: string
  key: string
  secret: string
  max_connections: number
  enable_client_events: boolean
  location_hint: DurableObjectLocationHint | null
}

export interface WebhookEndpointsTable {
  id: string
  app_id: string
  url: string
  events: string
  is_enabled: number
  created_at?: string
}

export type App = Selectable<AppsTable>
export type CreateApp = Insertable<AppsTable>
export type UpdateApp = Updateable<AppsTable>
