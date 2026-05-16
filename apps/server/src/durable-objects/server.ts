import { DurableObject } from 'cloudflare:workers'
import type { BatchEvent, Event } from '@/api/schemas/apps'
import { AppHandler } from '@/handlers/app-handler'
import { WebSocketHandler } from '@/handlers/ws-handler'
import { ConnectionManager } from '@/managers/connection-manager'
import { isPresenceChannel } from '@/utils/auth'

export class ServerDO extends DurableObject<Env> {
  private app: AppHandler
  private connections: ConnectionManager
  private ws: WebSocketHandler

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    this.app = new AppHandler(env)
    this.connections = new ConnectionManager(ctx)
    this.ws = new WebSocketHandler(ctx, this.connections, this.app)
  }

  public webSocketMessage(ws: WebSocket, message: string) {
    this.ws.handleMessage(ws, message)
  }

  public webSocketClose(ws: WebSocket) {
    this.ws.handleClose(ws)
  }

  public webSocketError(ws: WebSocket, error: unknown) {
    const { id } = ws.deserializeAttachment()
    console.error('WebSocket Error:', id, error)
  }

  public broadcast(payload: Event | BatchEvent) {
    if ('batch' in payload) {
      for (const item of payload.batch) {
        const { name, channel, data, socket_id } = item
        this.connections.broadcast(channel, name, data, socket_id)
      }
    } else {
      const { name, data, socket_id } = payload
      const channels =
        payload.channels ?? (payload.channel ? [payload.channel] : [])
      for (const channel of channels) {
        this.connections.broadcast(channel, name, data, socket_id)
      }
    }
  }

  public getChannels() {
    const channels = new Map<string, number>()

    for (const [channel, sockets] of this.connections.getChannels()) {
      channels.set(channel, sockets.size)
    }

    return channels
  }

  public getChannelsWithInfo() {
    const result = new Map<
      string,
      { subscription_count: number; user_count: number }
    >()

    for (const [channel, sockets] of this.connections.getChannels()) {
      result.set(channel, {
        subscription_count: sockets.size,
        user_count: this.connections.getMemberCount(channel),
      })
    }

    return result
  }

  public getChannel(channelName: string) {
    const occupancy = this.connections.getChannelOccupancy(channelName)

    if (!occupancy.occupied) {
      return null
    }

    return occupancy
  }

  public getChannelUsers(channelName: string) {
    if (!isPresenceChannel(channelName)) {
      return null
    }

    return this.connections.getPresenceChannelUsers(channelName)
  }

  public terminateUserConnections(userId: string) {
    this.connections.terminateUserConnections(userId)
  }

  public getSocketCount() {
    return this.connections.getSocketCount()
  }

  public async fetch(request: Request): Promise<Response> {
    const key = request.headers.get('X-APP-KEY') || ''

    try {
      const app = await this.app.getConfig(key)

      if (!this.ws.canAcceptNewConnection(app.max_connections)) {
        console.error('Connection limit exceeded.')
        return new Response(null, { status: 403 })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(message)
      return new Response(null, { status: 500 })
    }

    const { client, server, socketId } = this.connections.upgrade()

    this.connections.sendTo(server, {
      event: 'pusher:connection_established',
      data: {
        socket_id: socketId,
        activity_timeout: 120,
      },
    })

    return new Response(null, { status: 101, webSocket: client })
  }
}
