import { isStringValue, type JsonObject, type JsonValue } from '@socketo/core'
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
  data: JsonValue
  channel?: string
}

export type ParsedUserData = {
  id: string
  user_info?: JsonObject
}

export type PresenceData = {
  presence: {
    ids: string[]
    hash: Record<string, JsonObject>
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
  user_info?: JsonObject
  presence_user_id?: Record<string, string>
  presence_user_info?: Record<string, JsonObject>
}

type AttachmentCandidate = {
  id?: string | number
  channels?: Set<string | number>
}

export function isAttachmentData(
  value: AttachmentCandidate | null | undefined,
): value is AttachmentData {
  if (
    value === null ||
    value === undefined ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    !(value.channels instanceof Set)
  ) {
    return false
  }

  return [...value.channels].every(isStringValue)
}

declare global {
  interface WebSocket {
    deserializeAttachment(): AttachmentCandidate | null
    serializeAttachment(data: AttachmentData): void
  }
}
