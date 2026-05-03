import type { Context } from 'hono'
import type { ServerDO } from './durable-objects/server'

export interface HonoContext extends Context {
  Bindings: Env
  Variables: {
    app: {
      stub: DurableObjectStub<ServerDO>
      secret: string
    }
  }
}

export interface MessageData {
  channel: string
  channel_data?: string
  auth?: string
  user_data?: string
}

export interface PusherMessage {
  event: string
  data: MessageData
  channel?: string
}

export interface AttachmentData {
  id: string
  channels: Set<string>
  [key: string]: unknown
}

declare global {
  interface WebSocket {
    deserializeAttachment(): AttachmentData
    serializeAttachment(data: AttachmentData): void
  }
}
