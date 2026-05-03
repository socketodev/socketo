export class ConnectionManager {
  private sockets = new Map<string, WebSocket>()
  private channels = new Map<string, Set<WebSocket>>()

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
        this.addToChannel(ws, channel)
      }
    }
  }

  public remove(ws: WebSocket) {
    const { id } = ws.deserializeAttachment()
    this.sockets.delete(id)
  }

  public subscribe(ws: WebSocket, channel: string) {
    this.addToChannel(ws, channel)

    const state = ws.deserializeAttachment()
    state.channels.add(channel)
    ws.serializeAttachment(state)
  }

  public unsubscribe(ws: WebSocket, channel: string) {
    const channels = this.channels.get(channel)

    if (channels) {
      channels.delete(ws)

      const state = ws.deserializeAttachment()
      state.channels.delete(channel)
      ws.serializeAttachment(state)

      if (channels.size === 0) {
        this.channels.delete(channel)
      }
    }
  }

  public unsubscribeAll(ws: WebSocket) {
    const { channels } = ws.deserializeAttachment()
    for (const channel of channels) {
      this.unsubscribe(ws, channel)
    }
  }

  public isSubscribed(ws: WebSocket, channel: string) {
    if (!this.channels.has(channel)) {
      return false
    }
    return this.channels.get(channel)?.has(ws) ?? false
  }

  public broadcast(
    channel: string,
    event: string,
    data: unknown,
    exceptId?: string,
  ) {
    const channels = this.channels.get(channel)

    if (channels && channels.size > 0) {
      for (const ws of channels) {
        const { id } = ws.deserializeAttachment()
        if (id !== exceptId) {
          this.sendTo(ws, { event, channel, data })
        }
      }
    }
  }

  public sendTo(ws: WebSocket, data: object) {
    try {
      ws.send(JSON.stringify(data))
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

  private addToChannel(ws: WebSocket, channel: string) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set())
    }
    this.channels.get(channel)?.add(ws)
  }
}
