import {
  type AppPolicy,
  RealtimeNamespace,
  type SessionSnapshot,
} from '@socketo/core'
import type { BatchEvent, Event } from '../api/schemas/apps'
import type { App } from '../database/types'
import type { ConnectionManager } from '../managers/connection-manager'
import { isAttachmentData } from '../types'
import type { AppHandler } from './app-handler'

export class WebSocketHandler {
  private namespace: RealtimeNamespace | undefined

  constructor(
    private ctx: DurableObjectState,
    private connections: ConnectionManager,
    private app: AppHandler,
  ) {
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ event: 'pusher:ping', data: {} }),
        JSON.stringify({ event: 'pusher:pong', data: {} }),
      ),
    )

    ctx.blockConcurrencyWhile(async () => {
      this.connections.restore()
    })
  }

  public configure(config: App): RealtimeNamespace {
    const policy = this.toPolicy(config)

    if (!this.namespace) {
      this.namespace = new RealtimeNamespace(policy)

      for (const ws of this.connections.getSockets()) {
        const snapshot = ws.deserializeAttachment()
        if (!isAttachmentData(snapshot)) {
          this.connections.remove(ws)
          try {
            ws.close(1002, 'Invalid connection state')
          } catch {
            // The socket may already be closed.
          }
          continue
        }
        const session: SessionSnapshot = {
          id: snapshot.id,
          channels: [...snapshot.channels],
        }
        if (snapshot.user_id) session.userId = snapshot.user_id
        if (snapshot.user_info) session.userInfo = snapshot.user_info
        if (snapshot.presence_user_id) {
          session.presenceUserId = snapshot.presence_user_id
        }
        if (snapshot.presence_user_info) {
          session.presenceUserInfo = snapshot.presence_user_info
        }
        this.namespace.restore(this.connections.toConnection(ws), session)
      }
    } else {
      this.namespace.updatePolicy(policy)
    }

    return this.namespace
  }

  public async getNamespace(): Promise<RealtimeNamespace> {
    const config = await this.app.getConfig(this.ctx.id.name)
    if (!config) throw new Error(`App not found for key: ${this.ctx.id.name}`)
    return this.configure(config)
  }

  public register(ws: WebSocket) {
    if (!this.namespace) {
      throw new Error('WebSocket namespace is not configured')
    }

    const connection = this.connections.toConnection(ws)
    this.namespace.connect(connection)
    const snapshot = this.namespace.getSession(connection.id)
    if (!snapshot || !this.connections.syncSession(ws, snapshot)) {
      this.connections.remove(ws)
      void this.namespace.disconnect(connection.id)
      ws.close(4200, 'Connection state too large')
    }
  }

  public async handleMessage(ws: WebSocket, message: string) {
    const namespace = await this.getNamespace()
    const attachment = ws.deserializeAttachment()
    if (!isAttachmentData(attachment)) {
      const socketId = this.connections.remove(ws)
      if (socketId) await namespace.disconnect(socketId)
      ws.close(1002, 'Invalid connection state')
      return
    }
    const { id } = attachment

    await namespace.receive(id, message)

    const snapshot = namespace.getSession(id)
    if (!snapshot || !this.connections.syncSession(ws, snapshot, attachment)) {
      this.connections.remove(ws)
      await namespace.disconnect(id)
      ws.close(4200, 'Connection state too large')
    }
  }

  public async handleClose(ws: WebSocket) {
    const snapshot = ws.deserializeAttachment()
    if (!isAttachmentData(snapshot)) {
      const socketId = this.connections.remove(ws)
      if (socketId && this.namespace) {
        await this.namespace.disconnect(socketId)
      }
      return
    }

    try {
      if (this.namespace) {
        await this.namespace.disconnect(snapshot.id)
      } else if (snapshot.channels.size > 0) {
        await (await this.getNamespace()).disconnect(snapshot.id)
      }
    } finally {
      this.connections.remove(ws)
    }
  }

  public async trigger(payload: Event) {
    const namespace = await this.getNamespace()
    return namespace.trigger(payload)
  }

  public async triggerBatch(payload: BatchEvent) {
    const namespace = await this.getNamespace()
    return namespace.triggerBatch(payload)
  }

  public async queryChannels(options?: {
    filterByPrefix?: string
    info?: string
  }) {
    return (await this.getNamespace()).queryChannels(options)
  }

  public async queryChannel(channel: string, options?: { info?: string }) {
    return (await this.getNamespace()).queryChannel(channel, options)
  }

  public async queryChannelUsers(channel: string) {
    return (await this.getNamespace()).queryChannelUsers(channel)
  }

  public async terminateUserConnections(userId: string) {
    await (await this.getNamespace()).terminateUserConnections(userId)
  }

  public getSocketCount() {
    return this.namespace?.getSocketCount() ?? this.connections.getSocketCount()
  }

  public canAcceptNewConnection(maxConnections: number) {
    if (maxConnections === -1) return true
    return this.getSocketCount() + 1 <= maxConnections
  }

  private toPolicy(config: App): AppPolicy {
    return {
      key: config.key,
      secret: config.secret,
      enableClientEvents: config.enable_client_events,
    }
  }
}
