import { DurableObject } from 'cloudflare:workers'
import {
  createErrorMessage,
  createHandshakeMessage,
  serializeMessage,
} from '@socketo/core'
import type { BatchEvent, Event } from '@/api/schemas/apps'
import type { App } from '@/database/types'
import { WebSocketHandler } from '@/handlers/ws-handler'
import { ConnectionManager } from '@/managers/connection-manager'

export class ServerDO extends DurableObject<Env> {
  private config: App | undefined
  private connections: ConnectionManager
  private ws: WebSocketHandler

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    this.connections = new ConnectionManager(ctx)
    this.ws = new WebSocketHandler(ctx, this.connections)

    ctx.blockConcurrencyWhile(async () => {
      await this.init()
      this.restore()
    })
  }

  private async init() {
    const appKey = this.ctx.id.name
    if (!appKey) {
      throw new Error('App key is missing')
    }

    const db = this.env.DatabaseDO.get(
      this.env.DatabaseDO.idFromName('default'),
    )
    const config = await db.getAppByKey(appKey)
    if (!config) {
      throw new Error(`App not found for key: ${appKey}`)
    }

    this.config = config
    this.ws.configure(config)
  }

  private restore() {
    this.ws.restore()
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
    const url = new URL(request.url)

    const protocol = url.searchParams.get('protocol')
    if (!protocol) {
      return this.rejectConnection(4008, 'No protocol version supplied')
    } else if (protocol !== '7') {
      return this.rejectConnection(4007, 'Unsupported protocol version')
    }

    if (!this.config) {
      return this.rejectConnection(4001, 'App not found')
    }

    if (!this.ws.canAcceptNewConnection(this.config.max_connections)) {
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
