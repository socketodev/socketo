import type { PresenceData } from '../types'

export class ConnectionManager {
  private sockets = new Map<string, WebSocket>()
  private channels = new Map<string, Set<string>>()
  private users = new Map<string, Set<string>>()

  constructor(private ctx: DurableObjectState) {}

  public upgrade(): { server: WebSocket; client: WebSocket; socketId: string } {
    const [server, client] = Object.values(new WebSocketPair())

    const socketId = crypto.randomUUID()
    server.serializeAttachment({ id: socketId, channels: new Set() })

    this.ctx.acceptWebSocket(server)
    this.sockets.set(socketId, server)

    return { server, client, socketId }
  }

  public restore() {
    for (const ws of this.ctx.getWebSockets()) {
      const { id, channels, user_id } = ws.deserializeAttachment()
      this.sockets.set(id, ws)

      for (const channel of channels) {
        this.addToChannel(id, channel)
        if (user_id) {
          this.addUserToChannel(channel, user_id)
        }
      }
    }
  }

  public remove(ws: WebSocket) {
    const { id, channels, user_id } = ws.deserializeAttachment()
    this.sockets.delete(id)

    for (const channel of channels) {
      this.removeUserFromChannel(channel, user_id)
    }
  }

  public subscribe(ws: WebSocket, channel: string, user_id?: string) {
    const { id } = ws.deserializeAttachment()

    this.addToChannel(id, channel)

    const state = ws.deserializeAttachment()
    state.channels.add(channel)
    ws.serializeAttachment(state)

    if (user_id) {
      this.addUserToChannel(channel, user_id)
    }
  }

  public unsubscribe(ws: WebSocket, channel: string) {
    const { id, user_id } = ws.deserializeAttachment()

    const sockets = this.channels.get(channel)

    if (sockets) {
      sockets.delete(id)

      if (sockets.size === 0) {
        this.channels.delete(channel)
      }
    }

    this.removeUserFromChannel(channel, user_id)

    const state = ws.deserializeAttachment()
    state.channels.delete(channel)
    ws.serializeAttachment(state)
  }

  public unsubscribeAll(ws: WebSocket) {
    const { id, channels, user_id } = ws.deserializeAttachment()

    for (const channel of channels) {
      const sockets = this.channels.get(channel)
      if (sockets) {
        sockets.delete(id)
        if (sockets.size === 0) {
          this.channels.delete(channel)
        }
      }
      this.removeUserFromChannel(channel, user_id)
    }

    const state = ws.deserializeAttachment()
    state.channels.clear()
    ws.serializeAttachment(state)
  }

  public broadcast(
    channel: string,
    event: string,
    data: unknown,
    exceptId?: string,
    userId?: string,
  ) {
    const sockets = this.channels.get(channel)

    if (!sockets || sockets.size === 0) {
      return
    }

    const serializedData =
      (event.startsWith('pusher:') || event.startsWith('pusher_internal:')) &&
      typeof data !== 'string'
        ? JSON.stringify(data)
        : data

    const msg: Record<string, unknown> = {
      event,
      channel,
      data: serializedData,
    }
    if (userId) msg.user_id = userId
    const message = JSON.stringify(msg)

    for (const id of sockets) {
      if (id === exceptId) {
        continue
      }

      const ws = this.sockets.get(id)
      if (ws) {
        this.sendTo(ws, message)
      }
    }
  }

  public sendTo(ws: WebSocket, data: object | string) {
    try {
      ws.send(typeof data === 'string' ? data : this.stringify(data))
    } catch {
      ws.close(4200, 'Send failed')
    }
  }

  public getSocketCount() {
    return this.sockets.size
  }

  public getChannels() {
    return this.channels
  }

  public getPresenceData(channel: string): PresenceData {
    const userSet = this.users.get(channel)
    if (!userSet || userSet.size === 0) {
      return { presence: { ids: [], hash: {}, count: 0 } }
    }

    const ids = Array.from(userSet)
    const hash: Record<string, Record<string, unknown>> = {}

    for (const ws of this.sockets.values()) {
      const { user_id, user_info } = ws.deserializeAttachment()
      if (user_id && userSet.has(user_id)) {
        hash[user_id] = user_info || {}
      }
    }

    return {
      presence: {
        ids,
        hash,
        count: ids.length,
      },
    }
  }

  public getMemberCount(channel: string): number {
    const userSet = this.users.get(channel)
    return userSet ? userSet.size : 0
  }

  public getSocketById(id: string): WebSocket | undefined {
    return this.sockets.get(id)
  }

  public getChannelOccupancy(channel: string): {
    occupied: boolean
    user_count: number
    subscription_count: number
  } {
    const socketIds = this.channels.get(channel)

    if (!socketIds || socketIds.size === 0) {
      return { occupied: false, user_count: 0, subscription_count: 0 }
    }

    const userSet = this.users.get(channel)
    return {
      occupied: true,
      user_count: userSet ? userSet.size : 0,
      subscription_count: socketIds.size,
    }
  }

  public getPresenceChannelUsers(channel: string): { id: string }[] {
    const userSet = this.users.get(channel)
    if (!userSet) return []

    return Array.from(userSet).map((id) => ({ id }))
  }

  public terminateUserConnections(userId: string) {
    for (const [id, ws] of this.sockets) {
      const { user_id } = ws.deserializeAttachment()
      if (user_id === userId) {
        this.unsubscribeAll(ws)
        ws.close(4200, 'Terminated by server')
        this.sockets.delete(id)
      }
    }
  }

  private addUserToChannel(channel: string, userId: string) {
    if (!this.users.has(channel)) {
      this.users.set(channel, new Set())
    }
    this.users.get(channel)!.add(userId)
  }

  private removeUserFromChannel(channel: string, userId: string | undefined) {
    if (!userId) return

    const userSet = this.users.get(channel)
    if (userSet) {
      userSet.delete(userId)
      if (userSet.size === 0) {
        this.users.delete(channel)
      }
    }
  }

  private addToChannel(id: string, channel: string) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set())
    }
    this.channels.get(channel)?.add(id)
  }

  private stringify(data: object): string {
    if ('data' in data && typeof data.data !== 'string') {
      data = { ...data, data: JSON.stringify(data.data) }
    }
    return JSON.stringify(data)
  }
}
