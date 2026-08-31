import { verifyChannelAuth, verifySigninAuth } from './auth'
import {
  type IncomingMessage,
  type OutgoingMessage,
  type ParsedPresenceMember,
  parseMessage,
  parsePresenceMember,
  serializeMessage,
} from './messages'
import type {
  AppPolicy,
  BatchEventPayload,
  BatchTriggerResult,
  BroadcastEvent,
  ChannelAttributes,
  ChannelOccupancy,
  ChannelQueryResponse,
  ChannelsQueryResponse,
  EventPayload,
  JsonValue,
  PresenceData,
  RealtimeConnection,
  RealtimeHooks,
  SessionSnapshot,
  TriggerResult,
  UserInfo,
} from './types'
import {
  isPresenceChannel,
  isProtectedChannel,
  isRecord,
  isUnsupportedChannel,
  isValidChannelName,
  isValidEventName,
  stringValue,
} from './validation'

type Session = {
  id: string
  connection: RealtimeConnection
  channels: Set<string>
  userId?: string
  userInfo?: UserInfo
  presenceUserId: Map<string, string>
  presenceUserInfo: Map<string, UserInfo>
  disconnecting: boolean
}

type PresenceUser = {
  socketIds: Set<string>
  userInfo: UserInfo
}

const MAX_PRESENCE_MEMBERS = 100
const MAX_PRESENCE_USER_ID_LENGTH = 128
const MAX_PRESENCE_USER_INFO_BYTES = 1024

export class RealtimeNamespace {
  private policy: AppPolicy
  private readonly hooks: RealtimeHooks
  private readonly sessions = new Map<string, Session>()
  private readonly channels = new Map<string, Set<string>>()
  private readonly presenceUsers = new Map<string, Map<string, PresenceUser>>()
  private readonly socketOperations = new Map<string, Promise<void>>()

  constructor(policy: AppPolicy, hooks: RealtimeHooks = {}) {
    this.policy = { ...policy }
    this.hooks = hooks
  }

  public updatePolicy(policy: AppPolicy) {
    this.policy = { ...policy }
  }

  public connect(connection: RealtimeConnection) {
    this.sessions.set(connection.id, {
      id: connection.id,
      connection,
      channels: new Set(),
      presenceUserId: new Map(),
      presenceUserInfo: new Map(),
      disconnecting: false,
    })
  }

  public restore(connection: RealtimeConnection, snapshot: SessionSnapshot) {
    const session: Session = {
      id: connection.id,
      connection,
      channels: new Set(
        snapshot.channels.filter((channel) => !isUnsupportedChannel(channel)),
      ),
      userId: snapshot.userId,
      userInfo: snapshot.userInfo,
      presenceUserId: new Map(Object.entries(snapshot.presenceUserId ?? {})),
      presenceUserInfo: new Map(
        Object.entries(snapshot.presenceUserInfo ?? {}),
      ),
      disconnecting: false,
    }
    this.sessions.set(connection.id, session)

    for (const channel of session.channels) {
      this.addChannelSubscription(connection.id, channel)
      if (isPresenceChannel(channel)) {
        const userId = session.presenceUserId.get(channel) ?? session.userId
        if (userId) {
          session.presenceUserId.set(channel, userId)
          this.addPresenceMember(
            channel,
            session,
            userId,
            session.presenceUserInfo.get(channel) ?? session.userInfo ?? {},
          )
        }
      }
    }
  }

  public receive(socketId: string, rawMessage: string) {
    return this.enqueueSocketOperation(socketId, () =>
      this.receiveNow(socketId, rawMessage),
    )
  }

  private async receiveNow(socketId: string, rawMessage: string) {
    const session = this.sessions.get(socketId)
    if (!session || session.disconnecting) return
    const connection = session.connection

    let message: IncomingMessage
    try {
      message = parseMessage(rawMessage)
    } catch {
      this.sendError(connection, 4300, 'Invalid message format')
      return
    }

    const guard = await this.guardMessage(socketId, message)
    if (this.sessions.get(socketId) !== session || session.disconnecting) return

    if (guard) {
      this.sendError(connection, guard.code, guard.message)
      return
    }

    if (message.event === 'pusher:ping') {
      this.send(connection, { event: 'pusher:pong', data: {} })
      return
    }

    if (message.event === 'pusher:pong') return

    if (message.event === 'pusher:signin') {
      await this.handleSignin(connection, session, message.data)
      return
    }

    if (message.event === 'pusher:subscribe') {
      await this.handleSubscribe(connection, session, message.data)
      return
    }

    if (message.event === 'pusher:unsubscribe') {
      const data = isRecord(message.data) ? message.data : {}
      const channel = stringValue(data.channel)
      if (channel) await this.unsubscribe(session, channel)
      return
    }

    if (message.event.startsWith('client-')) {
      await this.handleClientEvent(connection, session, message)
      return
    }

    this.sendError(connection, 4009, 'Event not supported')
  }

  public disconnect(socketId: string) {
    return this.enqueueSocketOperation(socketId, () =>
      this.disconnectNow(socketId),
    )
  }

  private async disconnectNow(socketId: string) {
    const session = this.sessions.get(socketId)
    if (!session || session.disconnecting) return

    session.disconnecting = true
    try {
      for (const channel of session.channels) {
        await this.unsubscribe(session, channel)
      }

      this.sessions.delete(socketId)
    } finally {
      session.disconnecting = false
    }
  }

  public async broadcast(event: BroadcastEvent): Promise<number> {
    const socketIds = this.channels.get(event.channel)
    if (!socketIds) {
      await this.emit(this.hooks.onBroadcast, {
        ...event,
        recipientCount: 0,
      })
      return 0
    }

    const data = serializeData(event.data)
    let recipientCount = 0

    for (const socketId of socketIds) {
      if (socketId === event.exceptId) continue

      const session = this.sessions.get(socketId)
      if (!session) continue

      const message: OutgoingMessage = {
        event: event.event,
        channel: event.channel,
        data,
      }
      if (event.userId) message.user_id = event.userId
      this.send(session.connection, message)
      recipientCount += 1
    }

    await this.emit(this.hooks.onBroadcast, { ...event, recipientCount })
    return recipientCount
  }

  public async trigger(payload: EventPayload): Promise<TriggerResult> {
    const channels =
      payload.channels ?? (payload.channel ? [payload.channel] : [])
    let recipientCount = 0

    for (const channel of channels) {
      recipientCount += await this.broadcast({
        channel,
        event: payload.name,
        data: payload.data,
        exceptId: payload.socket_id,
      })
    }

    if (payload.info) {
      const requested = payload.info.split(',').map((s) => s.trim())
      const includeUserCount = requested.includes('user_count')
      const includeSubscriptionCount = requested.includes('subscription_count')

      const result: Record<string, Record<string, number>> = {}

      for (const channel of channels) {
        const occ = this.getChannel(channel)
        const attrs: Record<string, number> = {}
        if (occ) {
          if (includeUserCount && channel.startsWith('presence-')) {
            attrs.user_count = occ.user_count
          }
          if (includeSubscriptionCount && !channel.startsWith('presence-')) {
            attrs.subscription_count = occ.subscription_count
          }
        }
        result[channel] = attrs
      }

      return { recipientCount, channels: result }
    }

    return { recipientCount }
  }

  public async triggerBatch(
    payload: BatchEventPayload,
  ): Promise<BatchTriggerResult> {
    for (const item of payload.batch) {
      await this.broadcast({
        channel: item.channel,
        event: item.name,
        data: item.data,
        exceptId: item.socket_id,
      })
    }

    const batchResponses = payload.batch.map((item) => {
      if (!item.info) return {}

      const requested = item.info.split(',').map((s) => s.trim())
      const includeUserCount = requested.includes('user_count')
      const includeSubscriptionCount = requested.includes('subscription_count')

      const occ = this.getChannel(item.channel)
      const attrs: Record<string, number> = {}
      if (occ) {
        if (includeUserCount && item.channel.startsWith('presence-')) {
          attrs.user_count = occ.user_count
        }
        if (includeSubscriptionCount && !item.channel.startsWith('presence-')) {
          attrs.subscription_count = occ.subscription_count
        }
      }
      return attrs
    })

    return { batch: batchResponses }
  }

  public getSession(socketId: string): SessionSnapshot | undefined {
    const session = this.sessions.get(socketId)
    if (!session) return undefined

    const snapshot: SessionSnapshot = {
      id: session.id,
      channels: [...session.channels],
    }
    if (session.userId) snapshot.userId = session.userId
    if (session.userInfo) snapshot.userInfo = session.userInfo
    if (session.presenceUserId.size > 0) {
      snapshot.presenceUserId = Object.fromEntries(session.presenceUserId)
    }
    if (session.presenceUserInfo.size > 0) {
      snapshot.presenceUserInfo = Object.fromEntries(session.presenceUserInfo)
    }
    return snapshot
  }

  public getAllSessions(): SessionSnapshot[] {
    return [...this.sessions.keys()]
      .map((id) => this.getSession(id))
      .filter((s): s is SessionSnapshot => s !== undefined)
  }

  public getSocketCount() {
    return this.sessions.size
  }

  public getChannelsCount() {
    return this.channels.size
  }

  public getUsersCount() {
    const userIds = new Set<string>()
    for (const session of this.sessions.values()) {
      if (session.userId) userIds.add(session.userId)
      for (const userId of session.presenceUserId.values()) {
        userIds.add(userId)
      }
    }
    return userIds.size
  }

  public getChannels(): Map<string, number> {
    return new Map(
      [...this.channels].map(([channel, sockets]) => [channel, sockets.size]),
    )
  }

  public getChannelsWithInfo(): Map<
    string,
    { subscription_count: number; user_count: number }
  > {
    return new Map(
      [...this.channels].map(([channel, sockets]) => [
        channel,
        {
          subscription_count: sockets.size,
          user_count: this.getMemberCount(channel),
        },
      ]),
    )
  }

  public getChannel(channel: string): ChannelOccupancy | null {
    const sockets = this.channels.get(channel)
    if (!sockets || sockets.size === 0) return null

    return {
      occupied: true,
      user_count: this.getMemberCount(channel),
      subscription_count: sockets.size,
    }
  }

  public getChannelUsers(channel: string): { id: string }[] | null {
    if (!isPresenceChannel(channel)) return null

    return [...(this.presenceUsers.get(channel)?.keys() ?? [])].map((id) => ({
      id,
    }))
  }

  public queryChannels(options?: {
    filterByPrefix?: string
    info?: string
  }): ChannelsQueryResponse {
    const requestedAttrs = options?.info
      ? options.info.split(',').map((s) => s.trim())
      : []
    const includeUserCount = requestedAttrs.includes('user_count')
    const includeSubscriptionCount =
      requestedAttrs.includes('subscription_count')
    const filterByPrefix = options?.filterByPrefix

    const result: Record<string, ChannelAttributes> = {}

    for (const [channel, sockets] of this.channels) {
      if (filterByPrefix && !channel.startsWith(filterByPrefix)) continue

      const attrs: ChannelAttributes = {}
      if (includeSubscriptionCount && !channel.startsWith('presence-')) {
        attrs.subscription_count = sockets.size
      }
      if (includeUserCount && channel.startsWith('presence-')) {
        attrs.user_count = this.getMemberCount(channel)
      }

      result[channel] = attrs
    }

    return { channels: result } satisfies ChannelsQueryResponse
  }

  public queryChannel(
    channelName: string,
    options?: { info?: string },
  ): ChannelQueryResponse | null {
    const sockets = this.channels.get(channelName)
    if (!sockets || sockets.size === 0) return null

    const requestedAttrs = options?.info
      ? options.info.split(',').map((s) => s.trim())
      : []
    const response: ChannelQueryResponse = { occupied: true }

    if (
      requestedAttrs.includes('user_count') &&
      channelName.startsWith('presence-')
    ) {
      response.user_count = this.getMemberCount(channelName)
    }
    if (
      requestedAttrs.includes('subscription_count') &&
      !channelName.startsWith('presence-')
    ) {
      response.subscription_count = sockets.size
    }

    return response
  }

  public queryChannelUsers(channelName: string): { id: string }[] | null {
    return this.getChannelUsers(channelName)
  }

  public async terminateUserConnections(userId: string) {
    const socketIds = this.getUserSocketIds(userId)

    await Promise.all(
      socketIds.map(async (socketId) => {
        const session = this.sessions.get(socketId)
        if (!session) return

        try {
          session.connection.close(4200, 'Terminated by server')
        } finally {
          await this.disconnect(socketId)
        }
      }),
    )
  }

  private async handleSignin(
    connection: RealtimeConnection,
    session: Session,
    rawData: JsonValue | undefined,
  ) {
    const data = isRecord(rawData) ? rawData : {}
    const auth = stringValue(data.auth)
    const userData = stringValue(data.user_data)

    if (!auth || !userData) {
      this.sendError(
        connection,
        4009,
        'Invalid signin data: auth and user_data required',
      )
      return
    }

    if (!verifySigninAuth(session.id, userData, auth, this.policy)) {
      this.sendError(connection, 4009, 'Invalid signin signature')
      return
    }

    if (this.sessions.get(session.id) !== session || session.disconnecting)
      return

    let parsedUser: JsonValue
    try {
      parsedUser = JSON.parse(userData)
    } catch {
      this.sendError(connection, 4009, 'Invalid user_data JSON')
      return
    }

    if (!isRecord(parsedUser)) {
      this.sendError(connection, 4009, 'user_data must contain an id field')
      return
    }

    const userId = stringValue(parsedUser.id)
    if (userId === undefined || userId.length === 0) {
      this.sendError(connection, 4009, 'user_data must contain an id field')
      return
    }

    if (session.userId && session.userId !== userId) {
      this.sendError(
        connection,
        4009,
        'Connection is already associated with a different user',
      )
      return
    }

    session.userId = userId
    session.userInfo = isRecord(parsedUser.user_info)
      ? parsedUser.user_info
      : {}
    this.updatePresenceMemberInfo(session)

    this.send(connection, {
      event: 'pusher:signin_success',
      data: { user_data: userData },
    })
  }

  private async guardMessage(socketId: string, message: IncomingMessage) {
    if (!this.hooks.beforeMessage) return undefined
    try {
      return await this.hooks.beforeMessage(socketId, message)
    } catch {
      return { code: 4300, message: 'Message guard failed' }
    }
  }

  private async enqueueSocketOperation(
    socketId: string,
    operation: () => Promise<void>,
  ) {
    const previous = this.socketOperations.get(socketId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.socketOperations.set(socketId, current)

    return current.finally(() => {
      if (this.socketOperations.get(socketId) === current) {
        this.socketOperations.delete(socketId)
      }
    })
  }

  private async handleSubscribe(
    connection: RealtimeConnection,
    session: Session,
    rawData: JsonValue | undefined,
  ) {
    const data = isRecord(rawData) ? rawData : {}
    const channel = stringValue(data.channel)
    const auth = stringValue(data.auth)
    const channelData = stringValue(data.channel_data)

    if (!channel || !isValidChannelName(channel)) {
      this.sendError(connection, 4009, 'Invalid channel name', channel)
      return
    }

    if (isUnsupportedChannel(channel)) {
      this.sendError(connection, 4300, 'Unsupported channel type', channel)
      return
    }

    if (session.channels.has(channel)) {
      this.sendSubscriptionSucceeded(connection, channel)
      return
    }

    if (isProtectedChannel(channel)) {
      if (!auth) {
        this.sendError(
          connection,
          4009,
          'Auth string required for protected channel',
          channel,
        )
        return
      }

      const valid = verifyChannelAuth(
        session.id,
        channel,
        auth,
        this.policy,
        isPresenceChannel(channel) ? channelData : undefined,
      )
      if (this.sessions.get(session.id) !== session || session.disconnecting) {
        return
      }
      if (!valid) {
        this.sendError(
          connection,
          4009,
          'Invalid channel auth signature',
          channel,
        )
        return
      }
    }

    if (isPresenceChannel(channel)) {
      await this.subscribePresence(connection, session, channel, channelData)
      return
    }

    this.addChannelSubscription(session.id, channel)
    this.sendSubscriptionSucceeded(connection, channel)
    if (this.channels.get(channel)?.size === 1) {
      await this.emit(this.hooks.onChannelOccupied, channel)
    }
  }

  private async subscribePresence(
    connection: RealtimeConnection,
    session: Session,
    channel: string,
    channelData: string | undefined,
  ) {
    let member: ParsedPresenceMember
    if (channelData !== undefined) {
      let parsedChannelData: JsonValue
      try {
        parsedChannelData = JSON.parse(channelData)
      } catch {
        this.sendError(
          connection,
          4009,
          'Invalid presence channel_data',
          channel,
        )
        return
      }

      const parsedMember = parsePresenceMember(parsedChannelData)
      if (
        !parsedMember ||
        (session.userId && parsedMember.userId !== session.userId)
      ) {
        this.sendError(
          connection,
          4009,
          'Invalid presence channel_data',
          channel,
        )
        return
      }
      member = parsedMember
    } else if (session.userId) {
      member = {
        userId: session.userId,
        userInfo: session.userInfo ?? {},
      }
    } else {
      this.sendError(
        connection,
        4009,
        'channel_data is required for presence channels',
        channel,
      )
      return
    }

    if (
      member.userId.length === 0 ||
      member.userId.length > MAX_PRESENCE_USER_ID_LENGTH
    ) {
      this.sendError(
        connection,
        4300,
        'Presence user ID limit exceeded',
        channel,
      )
      return
    }

    const memberBytes = new TextEncoder().encode(
      JSON.stringify({ user_id: member.userId, user_info: member.userInfo }),
    ).byteLength
    if (memberBytes > MAX_PRESENCE_USER_INFO_BYTES) {
      this.sendError(
        connection,
        4300,
        'Presence user object limit exceeded',
        channel,
      )
      return
    }

    const wasAlreadyInChannel =
      this.presenceUsers.get(channel)?.has(member.userId) ?? false
    if (
      !wasAlreadyInChannel &&
      (this.presenceUsers.get(channel)?.size ?? 0) >= MAX_PRESENCE_MEMBERS
    ) {
      this.sendError(connection, 4300, 'Presence member limit reached', channel)
      return
    }

    session.presenceUserId.set(channel, member.userId)
    session.presenceUserInfo.set(channel, member.userInfo)
    this.addChannelSubscription(session.id, channel)
    this.addPresenceMember(channel, session, member.userId, member.userInfo)

    this.sendSubscriptionSucceeded(connection, channel)
    if (this.channels.get(channel)?.size === 1) {
      await this.emit(this.hooks.onChannelOccupied, channel)
    }

    if (!wasAlreadyInChannel) {
      await this.broadcast({
        channel,
        event: 'pusher_internal:member_added',
        data: { user_id: member.userId, user_info: member.userInfo },
        exceptId: session.id,
      })
      await this.emit(this.hooks.onMemberAdded, channel, member.userId)
    }
  }

  private async handleClientEvent(
    connection: RealtimeConnection,
    session: Session,
    message: IncomingMessage,
  ) {
    const channel = message.channel
    if (!isValidEventName(message.event)) return
    if (!channel || !isProtectedChannel(channel)) {
      this.sendError(
        connection,
        4009,
        'Client events are only allowed on private or presence channels',
        channel,
      )
      return
    }
    if (!this.policy.enableClientEvents) {
      this.sendError(connection, 4009, 'Client events are not enabled', channel)
      return
    }
    if (!session.channels.has(channel)) return

    const event: BroadcastEvent = {
      channel,
      event: message.event,
      data: message.data ?? {},
      exceptId: session.id,
    }
    if (isPresenceChannel(channel)) {
      const userId = session.presenceUserId.get(channel) ?? session.userId
      if (userId) event.userId = userId
    }
    await this.broadcast(event)
    await this.emit(this.hooks.onClientEvent, event)
  }

  private async unsubscribe(session: Session, channel: string) {
    if (!session.channels.has(channel)) return

    const userId = isPresenceChannel(channel)
      ? this.getPresenceUserId(session, channel)
      : undefined
    const wasLastUserSocket = userId
      ? this.isLastPresenceSocket(channel, userId)
      : false

    this.removeChannelSubscription(session.id, channel)

    if (userId && wasLastUserSocket) {
      await this.broadcast({
        channel,
        event: 'pusher_internal:member_removed',
        data: { user_id: userId },
        exceptId: session.id,
      })
      await this.emit(this.hooks.onMemberRemoved, channel, userId)
    }

    if (!this.channels.has(channel)) {
      await this.emit(this.hooks.onChannelVacated, channel)
    }
  }

  private sendSubscriptionSucceeded(
    connection: RealtimeConnection,
    channel: string,
  ) {
    this.send(connection, {
      event: 'pusher_internal:subscription_succeeded',
      channel,
      data: isPresenceChannel(channel) ? this.getPresenceData(channel) : {},
    })
  }

  private sendError(
    connection: RealtimeConnection,
    code: number,
    errorMessage: string,
    channel?: string,
  ) {
    const outgoing: OutgoingMessage = {
      event: 'pusher:error',
      data: { code, message: errorMessage },
    }
    if (channel) outgoing.channel = channel
    this.send(connection, outgoing)
  }

  private send(connection: RealtimeConnection, message: OutgoingMessage) {
    try {
      connection.send(serializeMessage(message))
    } catch {
      connection.close(4200, 'Send failed')
    }
  }

  private addChannelSubscription(socketId: string, channel: string) {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set())
    this.channels.get(channel)?.add(socketId)
    this.sessions.get(socketId)?.channels.add(channel)
  }

  private removeChannelSubscription(socketId: string, channel: string) {
    const session = this.sessions.get(socketId)
    const sockets = this.channels.get(channel)
    sockets?.delete(socketId)
    if (sockets?.size === 0) this.channels.delete(channel)

    if (session && isPresenceChannel(channel)) {
      this.removePresenceMember(channel, session)
    }

    session?.presenceUserInfo.delete(channel)
    session?.presenceUserId.delete(channel)
    session?.channels.delete(channel)
  }

  private addPresenceMember(
    channel: string,
    session: Session,
    userId: string,
    userInfo: UserInfo,
  ) {
    if (!this.presenceUsers.has(channel))
      this.presenceUsers.set(channel, new Map())
    const users = this.presenceUsers.get(channel)
    if (!users?.has(userId)) {
      users?.set(userId, { socketIds: new Set(), userInfo })
    }
    users?.get(userId)?.socketIds.add(session.id)
  }

  private removePresenceMember(channel: string, session: Session) {
    const userId = this.getPresenceUserId(session, channel)
    if (!userId) return
    const users = this.presenceUsers.get(channel)
    const user = users?.get(userId)
    if (!user) return

    user.socketIds.delete(session.id)
    if (user.socketIds.size === 0) users?.delete(userId)
    else {
      const representativeId = user.socketIds.values().next().value
      if (representativeId !== undefined) {
        const representative = this.sessions.get(representativeId)
        if (representative) {
          user.userInfo =
            representative.presenceUserInfo.get(channel) ??
            representative.userInfo ??
            {}
        }
      }
    }
    if (users?.size === 0) this.presenceUsers.delete(channel)
  }

  private isLastPresenceSocket(channel: string, userId: string) {
    return this.presenceUsers.get(channel)?.get(userId)?.socketIds.size === 1
  }

  private updatePresenceMemberInfo(session: Session) {
    for (const channel of session.channels) {
      const userId = this.getPresenceUserId(session, channel)
      if (!userId) continue
      const user = this.presenceUsers.get(channel)?.get(userId)
      const representativeId = user?.socketIds.values().next().value
      if (user && representativeId === session.id) {
        user.userInfo =
          session.presenceUserInfo.get(channel) ?? session.userInfo ?? {}
      }
    }
  }

  private getPresenceUserId(session: Session, channel: string) {
    return isPresenceChannel(channel)
      ? (session.presenceUserId.get(channel) ?? session.userId)
      : undefined
  }

  private getMemberCount(channel: string) {
    return this.presenceUsers.get(channel)?.size ?? 0
  }

  private getUserSocketIds(userId: string) {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.userId === userId ||
          [...session.presenceUserId.values()].includes(userId),
      )
      .map((session) => session.id)
  }

  private getPresenceData(channel: string): PresenceData {
    const users = this.presenceUsers.get(channel)
    const hash: Record<string, UserInfo> = {}
    const ids = [...(users?.keys() ?? [])]

    for (const userId of ids) {
      hash[userId] = users?.get(userId)?.userInfo ?? {}
    }

    return { presence: { ids, hash, count: ids.length } }
  }

  private async emit<T extends (...args: never[]) => void | Promise<void>>(
    hook: T | undefined,
    ...args: Parameters<T>
  ) {
    if (!hook) return
    try {
      await hook(...args)
    } catch {
      // Hooks must not break protocol delivery.
    }
  }
}

function serializeData(data: JsonValue): string {
  return stringValue(data) ?? JSON.stringify(data)
}
