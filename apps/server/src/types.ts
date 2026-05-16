import type { Context } from 'hono'
import type { ServerDO } from './durable-objects/server'

export type HonoContext = Context & {
  Bindings: Env
  Variables: {
    app: {
      stub: DurableObjectStub<ServerDO>
      secret: string
    }
  }
}

export type PusherMessage = {
  event: string
  data: unknown
  channel?: string
}

export type ParsedUserData = {
  id: string
  user_info?: Record<string, unknown>
}

export type PresenceData = {
  presence: {
    ids: string[]
    hash: Record<string, Record<string, unknown>>
    count: number
  }
}

export type SigninData = {
  auth?: string
  user_data?: string
}

export type SubscribeData = {
  channel: string
  auth?: string
  channel_data?: string
}

export type UnsubscribeData = {
  channel?: string
}

export type AttachmentData = {
  id: string
  channels: Set<string>
  user_id?: string
  user_info?: Record<string, unknown>
}

declare global {
  interface WebSocket {
    deserializeAttachment(): AttachmentData
    serializeAttachment(data: AttachmentData): void
  }
}
