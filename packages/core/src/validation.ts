import type { JsonObject, JsonValue } from './types'

const CHANNEL_NAME_REGEX = /^[a-zA-Z0-9_=@,.;-]+$/
const DEFAULT_CHANNEL_NAME_LENGTH = 164
const DEFAULT_EVENT_NAME_LENGTH = 200
const INFO_ATTRIBUTES = new Set(['subscription_count', 'user_count'])
export function isPresenceChannel(channel: string): boolean {
  return channel.startsWith('presence-') && !isUnsupportedChannel(channel)
}

export function isPrivateChannel(channel: string): boolean {
  return (
    channel.startsWith('private-') &&
    !channel.startsWith('private-encrypted-') &&
    !channel.startsWith('private-cache-')
  )
}

export function isProtectedChannel(channel: string): boolean {
  return isPrivateChannel(channel) || isPresenceChannel(channel)
}

export function isUnsupportedChannel(channel: string): boolean {
  return (
    channel.startsWith('cache-') ||
    channel.startsWith('private-cache-') ||
    channel.startsWith('presence-cache-') ||
    channel.startsWith('private-encrypted-')
  )
}

export function isServerToUserChannel(channel: string): boolean {
  return channel.startsWith('#server-to-user-')
}

export function isValidChannelName(
  channel: string,
  maxLength = DEFAULT_CHANNEL_NAME_LENGTH,
): boolean {
  if (channel.length < 1 || channel.length > maxLength) return false
  if (channel.startsWith('pusher:')) return false
  if (
    channel === 'private-' ||
    channel === 'presence-' ||
    channel === '#server-to-user-'
  ) {
    return false
  }
  if (isServerToUserChannel(channel)) {
    return CHANNEL_NAME_REGEX.test(channel.slice('#server-to-user-'.length))
  }
  return CHANNEL_NAME_REGEX.test(channel)
}

export function isValidEventName(
  event: string,
  maxLength = DEFAULT_EVENT_NAME_LENGTH,
): boolean {
  return event.length > 0 && event.length <= maxLength
}

export function invalidInfoAttribute(info: string | undefined): string | null {
  if (!info) return null
  for (const attribute of info
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (!INFO_ATTRIBUTES.has(attribute)) return attribute
  }
  return null
}

export function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isStringValue(value: JsonValue | undefined): value is string {
  return typeof value === 'string'
}

export function isStringOrNumberValue(
  value: JsonValue | undefined,
): value is string | number {
  return typeof value === 'string' || typeof value === 'number'
}

export function stringValue(value: JsonValue | undefined): string | undefined {
  return isStringValue(value) ? value : undefined
}

export function generateSocketId(): string {
  const array = new Uint32Array(2)
  crypto.getRandomValues(array)
  return `${array[0]}.${array[1]}`
}

export function isValidSocketId(socketId: string): boolean {
  return /^\d+\.\d+$/.test(socketId)
}
