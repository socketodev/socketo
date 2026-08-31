import { DurableObject } from 'cloudflare:workers'
import { serializeMessage } from '@socketo/realtime-core'
import type { BatchEvent, Event } from '@/api/schemas/apps'
import { AppHandler } from '@/handlers/app-handler'
import { WebSocketHandler } from '@/handlers/ws-handler'
import { ConnectionManager } from '@/managers/connection-manager'

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
    return this.ws.handleMessage(ws, message)
  }

  public webSocketClose(ws: WebSocket) {
    return this.ws.handleClose(ws)
  }

  public webSocketError(ws: WebSocket, error: Error) {
    const attachment = ws.deserializeAttachment()
    console.error('WebSocket Error:', attachment?.id, error)
  }

  public broadcast(payload: Event | BatchEvent) {
    return this.ws.broadcast(payload)
  }

  public getChannels() {
    return this.ws.getChannels()
  }

  public getChannelsWithInfo() {
    return this.ws.getChannelsWithInfo()
  }

  public getChannel(channelName: string) {
    return this.ws.getChannel(channelName)
  }

  public getChannelUsers(channelName: string) {
    return this.ws.getChannelUsers(channelName)
  }

  public async terminateUserConnections(userId: string) {
    await this.ws.terminateUserConnections(userId)
  }

  public getSocketCount() {
    return this.ws.getSocketCount()
  }

  public async fetch(request: Request): Promise<Response> {
    const key = request.headers.get('X-APP-KEY') || ''
    const url = new URL(request.url)

    const protocol = url.searchParams.get('protocol')
    if (!protocol) {
      return this.rejectConnection(4008, 'No protocol version supplied')
    } else if (protocol !== '7') {
      return this.rejectConnection(4007, 'Unsupported protocol version')
    }

    const app = await this.app.getConfig(key)
    if (!app) {
      return this.rejectConnection(4001, 'App not found')
    }

    this.ws.configure(app)

    if (!this.ws.canAcceptNewConnection(app.max_connections)) {
      return this.rejectConnection(4004, 'Connection quota exceeded')
    }

    const { client, server, socketId } = this.connections.upgrade()
    this.ws.register(server)

    this.connections.sendTo(
      server,
      serializeMessage({
        event: 'pusher:connection_established',
        data: {
          socket_id: socketId,
          activity_timeout: 120,
        },
      }),
    )

    return new Response(null, { status: 101, webSocket: client })
  }

  private rejectConnection(code: number, message: string): Response {
    const { client, server } = this.connections.upgrade()
    this.connections.sendTo(
      server,
      serializeMessage({ event: 'pusher:error', data: { code, message } }),
    )
    server.close(code, message)
    return new Response(null, { status: 101, webSocket: client })
  }
}
