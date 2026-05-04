export class ConnectionManager {
  private sockets = new Map<string, WebSocket>()
  private channels = new Map<string, Set<string>>()

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
      const { id, channels } = ws.deserializeAttachment()
      this.sockets.set(id, ws)

      for (const channel of channels) {
        this.addToChannel(id, channel)
      }
    }
  }

  public remove(ws: WebSocket) {
    const { id } = ws.deserializeAttachment()
    this.sockets.delete(id)
  }

  public subscribe(ws: WebSocket, channel: string) {
    const { id } = ws.deserializeAttachment()

    this.addToChannel(id, channel)

    const state = ws.deserializeAttachment()
    state.channels.add(channel)
    ws.serializeAttachment(state)
  }

  public unsubscribe(ws: WebSocket, channel: string) {
    const { id } = ws.deserializeAttachment()

    const sockets = this.channels.get(channel)

    if (sockets) {
      sockets.delete(id)

      if (sockets.size === 0) {
        this.channels.delete(channel)
      }
    }

    const state = ws.deserializeAttachment()
    state.channels.delete(channel)
    ws.serializeAttachment(state)
  }

  public unsubscribeAll(ws: WebSocket) {
    const { id, channels } = ws.deserializeAttachment()

    for (const channel of channels) {
      const sockets = this.channels.get(channel)
      if (sockets) {
        sockets.delete(id)
        if (sockets.size === 0) {
          this.channels.delete(channel)
        }
      }
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
  ) {
    const sockets = this.channels.get(channel)

    if (!sockets || sockets.size === 0) {
      return
    }

    const message = JSON.stringify({ event, channel, data })

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
      const message = typeof data === 'string' ? data : JSON.stringify(data)
      ws.send(message)
    } catch {
      ws.close()
    }
  }

  public getSocketCount() {
    return this.sockets.size
  }

  public getChannels() {
    return this.channels
  }

  private addToChannel(id: string, channel: string) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set())
    }
    this.channels.get(channel)?.add(id)
  }
}
