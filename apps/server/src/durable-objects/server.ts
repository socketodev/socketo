import { DurableObject } from 'cloudflare:workers'
import {
  createErrorMessage,
  createHandshakeMessage,
  serializeMessage,
} from '@socketo/core'
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

  public trigger(payload: Event) {
    return this.ws.trigger(payload)
  }

  public triggerBatch(payload: BatchEvent) {
    return this.ws.triggerBatch(payload)
  }

  public queryChannels(options?: { filterByPrefix?: string; info?: string }) {
    return this.ws.queryChannels(options)
  }

  public queryChannel(channelName: string, options?: { info?: string }) {
    return this.ws.queryChannel(channelName, options)
  }

  public queryChannelUsers(channelName: string) {
    return this.ws.queryChannelUsers(channelName)
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
      serializeMessage(createHandshakeMessage(socketId, 120)),
    )

    return new Response(null, { status: 101, webSocket: client })
  }

  private rejectConnection(code: number, message: string): Response {
    const { client, server } = this.connections.upgrade()
    this.connections.sendTo(
      server,
      serializeMessage(createErrorMessage(code, message)),
    )
    server.close(code, message)
    return new Response(null, { status: 101, webSocket: client })
  }
}
