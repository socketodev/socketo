import {
  type AppPolicy,
  RealtimeNamespace,
  type SessionSnapshot,
} from '@socketo/core'
import type { BatchEvent, Event } from '../api/schemas/apps'
import type { App } from '../database/types'
import type { ConnectionManager } from '../managers/connection-manager'
import { isAttachmentData } from '../types'
export class WebSocketHandler {
  private namespace: RealtimeNamespace | undefined

  constructor(
    private ctx: DurableObjectState,
    private connections: ConnectionManager,
  ) {
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ event: 'pusher:ping', data: {} }),
        JSON.stringify({ event: 'pusher:pong', data: {} }),
      ),
    )
  }

  public configure(config: App): RealtimeNamespace {
    const policy = this.toPolicy(config)

    if (!this.namespace) {
      this.namespace = new RealtimeNamespace(policy)
    } else {
      this.namespace.updatePolicy(policy)
    }

    return this.namespace
  }

  public restore() {
    const namespace = this.getNamespace()
    this.connections.restore()

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
      namespace.restore(this.connections.toConnection(ws), session)
    }
  }

  public getNamespace(): RealtimeNamespace {
    if (!this.namespace) {
      throw new Error(`App not found for key: ${this.ctx.id.name}`)
    }
    return this.namespace
  }

  public register(ws: WebSocket) {
    const namespace = this.getNamespace()
    const connection = this.connections.toConnection(ws)
    namespace.connect(connection)
    const snapshot = namespace.getSession(connection.id)
    if (!snapshot || !this.connections.syncSession(ws, snapshot)) {
      this.connections.remove(ws)
      void namespace.disconnect(connection.id)
      ws.close(4200, 'Connection state too large')
    }
  }

  public async handleMessage(ws: WebSocket, message: string) {
    const namespace = this.getNamespace()
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
      }
    } finally {
      this.connections.remove(ws)
    }
  }

  public trigger(payload: Event) {
    return this.getNamespace().trigger(payload)
  }

  public triggerBatch(payload: BatchEvent) {
    return this.getNamespace().triggerBatch(payload)
  }

  public queryChannels(options?: { filterByPrefix?: string; info?: string }) {
    return this.getNamespace().queryChannels(options)
  }

  public queryChannel(channel: string, options?: { info?: string }) {
    return this.getNamespace().queryChannel(channel, options)
  }

  public queryChannelUsers(channel: string) {
    return this.getNamespace().queryChannelUsers(channel)
  }

  public async terminateUserConnections(userId: string) {
    await this.getNamespace().terminateUserConnections(userId)
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
