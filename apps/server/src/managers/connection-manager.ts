import {
  generateSocketId,
  type RealtimeConnection,
  type SessionSnapshot,
} from '@socketo/core'
import { type AttachmentData, isAttachmentData } from '@/types'

const MAX_ATTACHMENT_BYTES = 16_384

type WebSocketUpgrade = {
  server: WebSocket
  client: WebSocket
  socketId: string
}

export class ConnectionManager {
  private sockets = new Map<string, WebSocket>()

  constructor(private ctx: DurableObjectState) {}

  public upgrade(): WebSocketUpgrade {
    const [server, client] = Object.values(new WebSocketPair())
    const socketId = generateSocketId()

    server.serializeAttachment({ id: socketId, channels: new Set() })
    this.ctx.acceptWebSocket(server)
    this.sockets.set(socketId, server)

    return { server, client, socketId }
  }

  public restore(): WebSocket[] {
    const sockets = this.ctx.getWebSockets()
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment()
      if (!isAttachmentData(attachment)) {
        try {
          ws.close(1002, 'Invalid connection state')
        } catch {
          // The socket may already be closed.
        }
        continue
      }
      const { id } = attachment
      this.sockets.set(id, ws)
    }
    return sockets
  }

  public getSockets(): WebSocket[] {
    return [...this.sockets.values()]
  }

  public toConnection(ws: WebSocket): RealtimeConnection {
    const attachment = ws.deserializeAttachment()
    if (!isAttachmentData(attachment))
      throw new Error('Invalid connection state')
    const { id } = attachment
    return {
      id,
      send: (message) => {
        try {
          ws.send(message)
        } catch {
          ws.close(4200, 'Send failed')
        }
      },
      close: (code, reason) => {
        this.sockets.delete(id)
        ws.close(code, reason)
      },
    }
  }

  public syncSession(
    ws: WebSocket,
    snapshot: SessionSnapshot,
    state?: AttachmentData,
  ): boolean {
    const attachment = state ?? ws.deserializeAttachment()
    if (!isAttachmentData(attachment)) return false

    attachment.channels = new Set(snapshot.channels)
    attachment.user_id = snapshot.userId
    attachment.user_info = snapshot.userInfo
    attachment.presence_user_id = snapshot.presenceUserId
    attachment.presence_user_info = snapshot.presenceUserInfo

    if (!isAttachmentWithinLimit(attachment)) return false

    try {
      ws.serializeAttachment(attachment)
    } catch {
      return false
    }

    return true
  }

  public remove(ws: WebSocket): string | undefined {
    const attachment = ws.deserializeAttachment()
    if (isAttachmentData(attachment)) {
      this.sockets.delete(attachment.id)
      return attachment.id
    }

    for (const [id, socket] of this.sockets) {
      if (socket === ws) {
        this.sockets.delete(id)
        return id
      }
    }

    return undefined
  }

  public getSocketCount() {
    return this.sockets.size
  }

  public sendTo(ws: WebSocket, message: string) {
    try {
      ws.send(message)
    } catch {
      ws.close(4200, 'Send failed')
    }
  }
}

function isAttachmentWithinLimit(attachment: AttachmentData) {
  try {
    const serialized = JSON.stringify({
      ...attachment,
      channels: [...attachment.channels],
    })
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= MAX_ATTACHMENT_BYTES
    )
  } catch {
    return false
  }
}
