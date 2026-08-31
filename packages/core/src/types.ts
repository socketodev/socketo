import type { IncomingMessage } from './messages'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }
export type UserInfo = JsonObject

export type AppPolicy = {
  key: string
  secret: string
  enableClientEvents: boolean
}

export type RealtimeConnection = {
  id: string
  send(message: string): void
  close(code?: number, reason?: string): void
}

export type SessionSnapshot = {
  id: string
  channels: string[]
  userId?: string
  userInfo?: UserInfo
  presenceUserId?: Record<string, string>
  presenceUserInfo?: Record<string, UserInfo>
}

export type PresenceData = {
  presence: {
    ids: string[]
    hash: Record<string, UserInfo>
    count: number
  }
}

export type ChannelOccupancy = {
  occupied: boolean
  user_count: number
  subscription_count: number
}

export type BroadcastEvent = {
  channel: string
  event: string
  data: JsonValue
  exceptId?: string
  userId?: string
}

export type RealtimeHooks = {
  beforeMessage?: (
    socketId: string,
    message: IncomingMessage,
  ) =>
    | RealtimeMessageGuardResult
    | undefined
    | Promise<RealtimeMessageGuardResult | undefined>
  onBroadcast?: (
    event: BroadcastEvent & { recipientCount: number },
  ) => void | Promise<void>
  onChannelOccupied?: (channel: string) => void | Promise<void>
  onChannelVacated?: (channel: string) => void | Promise<void>
  onMemberAdded?: (channel: string, userId: string) => void | Promise<void>
  onMemberRemoved?: (channel: string, userId: string) => void | Promise<void>
  onClientEvent?: (event: BroadcastEvent) => void | Promise<void>
}

export type RealtimeMessageGuardResult = {
  code: number
  message: string
}

export type EventPayload = {
  name: string
  data: JsonValue
  channel?: string
  channels?: string[]
  socket_id?: string
  info?: string
}

export type BatchEventPayload = {
  batch: Array<{
    name: string
    channel: string
    data: JsonValue
    socket_id?: string
    info?: string
  }>
}

export type ChannelAttributes = {
  subscription_count?: number
  user_count?: number
}

export type ChannelQueryResponse = {
  occupied: boolean
  subscription_count?: number
  user_count?: number
}

export type TriggerResult = {
  recipientCount: number
  channels?: Record<string, Record<string, number>>
}

export type BatchTriggerResult = {
  batch: Array<Record<string, number>>
}
