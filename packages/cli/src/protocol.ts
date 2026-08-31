import type { JsonObject, JsonValue } from '@socketo/realtime-core'

export type { JsonObject, JsonValue } from '@socketo/realtime-core'

export type DisplayMessage = {
  event: string
  data?: JsonValue
  channel?: string
  user_id?: string | number
}

export type AuthRequest = {
  socket_id?: string
  channel_name?: string
  channel_data?: string
}

export type AuthResponse = {
  auth: string
  channel_data?: string
}

export type EventTriggerRequest = {
  name?: string
  channels?: string[]
  channel?: string
  data?: JsonValue
  socket_id?: string
  info?: string
}

export type BatchEventRequest = {
  name?: string
  channel?: string
  channels?: string[]
  data?: JsonValue
  socket_id?: string
  info?: string
}

export type BatchRequest = {
  batch?: BatchEventRequest[]
}

export type ChannelInfo = {
  subscription_count?: number
  user_count?: number
}

export type ChannelInfoMap = {
  [channel: string]: ChannelInfo
}

export type ChannelListResponse = {
  channels: ChannelInfoMap
}

export type ChannelInfoResponse = {
  occupied: boolean
  subscription_count?: number
  user_count?: number
}

export type BatchEventResult = {
  subscription_count?: number
  user_count?: number
}

export type ConnectionEstablished = {
  socket_id: string
  activity_timeout: number
}

export type PresenceInfo = {
  count: number
  ids: string[]
}

export type PresenceSubscription = {
  presence?: PresenceInfo
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isStringValue(value: JsonValue | undefined): value is string {
  return typeof value === 'string'
}

function isNumberValue(value: JsonValue | undefined): value is number {
  return typeof value === 'number'
}

function isStringOrNumberValue(
  value: JsonValue | undefined,
): value is string | number {
  return isStringValue(value) || isNumberValue(value)
}

export function parseJson(text: string): JsonValue {
  try {
    const value: JsonValue = JSON.parse(text)
    return value
  } catch {
    throw new Error('Invalid JSON')
  }
}

function requireJsonObject(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object')
  return value
}

function requiredString(object: JsonObject, key: string): string {
  const value = object[key]
  if (!isStringValue(value)) throw new Error(`Expected ${key} to be a string`)
  return value
}

function requiredNumber(object: JsonObject, key: string): number {
  const value = object[key]
  if (!isNumberValue(value)) throw new Error(`Expected ${key} to be a number`)
  return value
}

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (!isStringValue(value)) throw new Error(`Expected ${key} to be a string`)
  return value
}

function optionalStringOrNumber(
  object: JsonObject,
  key: string,
): string | number | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (!isStringOrNumberValue(value)) {
    throw new Error(`Expected ${key} to be a string or number`)
  }
  return value
}

function optionalNumber(object: JsonObject, key: string): number | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (!isNumberValue(value)) throw new Error(`Expected ${key} to be a number`)
  return value
}

function optionalStringArray(
  object: JsonObject,
  key: string,
): string[] | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`Expected ${key} to be an array`)

  const result: string[] = []
  for (const item of value) {
    if (!isStringValue(item)) {
      throw new Error(`Expected ${key} to contain only strings`)
    }
    result.push(item)
  }
  return result
}

function parseNestedObject(value: JsonValue | undefined): JsonObject {
  const parsed = isStringValue(value) ? parseJson(value) : value
  return requireJsonObject(parsed)
}

export function parsePusherMessage(text: string): DisplayMessage {
  const object = requireJsonObject(parseJson(text))
  const message: DisplayMessage = { event: requiredString(object, 'event') }
  const data = object.data
  const channel = optionalString(object, 'channel')
  const userId = optionalStringOrNumber(object, 'user_id')

  if (data !== undefined) message.data = data
  if (channel !== undefined) message.channel = channel
  if (userId !== undefined) message.user_id = userId
  return message
}

export function decodeConnectionEstablished(
  value: JsonValue | undefined,
): ConnectionEstablished {
  const object = parseNestedObject(value)
  return {
    socket_id: requiredString(object, 'socket_id'),
    activity_timeout: requiredNumber(object, 'activity_timeout'),
  }
}

export function decodeAuthRequest(value: JsonValue): AuthRequest {
  const object = requireJsonObject(value)
  const request: AuthRequest = {}
  const socketId = optionalString(object, 'socket_id')
  const channelName = optionalString(object, 'channel_name')
  const channelData = optionalString(object, 'channel_data')

  if (socketId !== undefined) request.socket_id = socketId
  if (channelName !== undefined) request.channel_name = channelName
  if (channelData !== undefined) request.channel_data = channelData
  return request
}

export function decodeAuthResponse(value: JsonValue): AuthResponse {
  const object = requireJsonObject(value)
  const response: AuthResponse = {
    auth: requiredString(object, 'auth'),
  }
  const channelData = optionalString(object, 'channel_data')
  if (channelData !== undefined) response.channel_data = channelData
  return response
}

export function decodeEventTriggerRequest(
  value: JsonValue,
): EventTriggerRequest {
  const object = requireJsonObject(value)
  const request: EventTriggerRequest = {}
  const name = optionalString(object, 'name')
  const channels = optionalStringArray(object, 'channels')
  const channel = optionalString(object, 'channel')
  const socketId = optionalString(object, 'socket_id')
  const info = optionalString(object, 'info')

  if (name !== undefined) request.name = name
  if (channels !== undefined) request.channels = channels
  if (channel !== undefined) request.channel = channel
  if (object.data !== undefined) request.data = object.data
  if (socketId !== undefined) request.socket_id = socketId
  if (info !== undefined) request.info = info
  return request
}

function decodeBatchEvent(value: JsonValue): BatchEventRequest {
  const object = requireJsonObject(value)
  const event: BatchEventRequest = {}
  const name = optionalString(object, 'name')
  const channel = optionalString(object, 'channel')
  const channels = optionalStringArray(object, 'channels')
  const socketId = optionalString(object, 'socket_id')
  const info = optionalString(object, 'info')

  if (name !== undefined) event.name = name
  if (channel !== undefined) event.channel = channel
  if (channels !== undefined) event.channels = channels
  if (object.data !== undefined) event.data = object.data
  if (socketId !== undefined) event.socket_id = socketId
  if (info !== undefined) event.info = info
  return event
}

export function decodeBatchRequest(value: JsonValue): BatchRequest {
  const object = requireJsonObject(value)
  const request: BatchRequest = {}
  const batch = object.batch
  if (batch === undefined) return request
  if (!Array.isArray(batch)) throw new Error('Expected batch to be an array')
  request.batch = batch.map(decodeBatchEvent)
  return request
}

function decodeChannelInfo(value: JsonValue): ChannelInfo {
  const object = requireJsonObject(value)
  const info: ChannelInfo = {}
  const subscriptionCount = optionalNumber(object, 'subscription_count')
  const userCount = optionalNumber(object, 'user_count')

  if (subscriptionCount !== undefined) {
    info.subscription_count = subscriptionCount
  }
  if (userCount !== undefined) info.user_count = userCount
  return info
}

export function decodeChannelListResponse(
  value: JsonValue,
): ChannelListResponse {
  const object = requireJsonObject(value)
  const channelObject = requireJsonObject(object.channels)
  const channels: ChannelInfoMap = {}

  for (const [name, channel] of Object.entries(channelObject)) {
    channels[name] = decodeChannelInfo(channel)
  }
  return { channels }
}

export function decodePresenceSubscription(
  value: JsonValue | undefined,
): PresenceSubscription {
  if (value === undefined) return {}
  const object = parseNestedObject(value)
  const presence = object.presence
  if (!isJsonObject(presence)) return {}

  const count = presence.count
  const ids = presence.ids
  if (!isNumberValue(count) || !Array.isArray(ids)) return {}

  const userIds: string[] = []
  for (const id of ids) {
    if (!isStringValue(id)) return {}
    userIds.push(id)
  }
  return { presence: { count, ids: userIds } }
}

export function stringifyMessageData(value: JsonValue | undefined): string {
  if (isStringValue(value)) return value
  return JSON.stringify(value) ?? 'undefined'
}
