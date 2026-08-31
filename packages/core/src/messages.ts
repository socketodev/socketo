import type { JsonValue, UserInfo } from './types'
import { isRecord, isStringOrNumberValue, stringValue } from './validation'

export type IncomingMessage = {
  event: string
  channel?: string
  data?: JsonValue
}

export type OutgoingMessage = {
  event: string
  channel?: string
  data?: JsonValue
  user_id?: string
}

export type ParsedPresenceMember = {
  userId: string
  userInfo: UserInfo
}

export function parseMessage(message: string): IncomingMessage {
  const parsed: JsonValue = JSON.parse(message)
  if (!isRecord(parsed)) {
    throw new Error('Invalid message')
  }

  const event = stringValue(parsed.event)
  if (event === undefined) throw new Error('Invalid message')

  return {
    event,
    channel: stringValue(parsed.channel),
    data: parsed.data,
  }
}

export function serializeMessage(message: OutgoingMessage): string {
  const data = stringValue(message.data) ?? JSON.stringify(message.data ?? {})

  return JSON.stringify({ ...message, data })
}

export function parsePresenceMember(
  data: JsonValue | undefined,
): ParsedPresenceMember | null {
  if (!isRecord(data) || !isStringOrNumberValue(data.user_id)) {
    return null
  }

  const userInfo = isRecord(data.user_info) ? data.user_info : {}
  return { userId: String(data.user_id), userInfo }
}

export function createHandshakeMessage(
  socketId: string,
  activityTimeout = 120,
): OutgoingMessage {
  return {
    event: 'pusher:connection_established',
    data: {
      socket_id: socketId,
      activity_timeout: activityTimeout,
    },
  }
}

export function createErrorMessage(
  code: number,
  message: string,
  channel?: string,
): OutgoingMessage {
  const outgoing: OutgoingMessage = {
    event: 'pusher:error',
    data: { code, message },
  }
  if (channel) outgoing.channel = channel
  return outgoing
}

