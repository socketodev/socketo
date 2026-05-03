import type { ConnectionManager } from '../managers/connection-manager'
import type { PusherMessage } from '../types'
import type { AppHandler } from './app-handler'

export class WebSocketHandler {
  constructor(
    ctx: DurableObjectState,
    private connections: ConnectionManager,
    private app: AppHandler,
    private key: string,
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

  public async handleMessage(ws: WebSocket, message: string) {
    try {
      const { event, channel, data } = JSON.parse(message) as PusherMessage

      if (event === 'pusher:subscribe') {
        this.handleSubscribe(ws, data.channel)
      } else if (event === 'pusher:unsubscribe') {
        this.handleUnsubscribe(ws, data.channel)
      } else if (this.isClientEvent(event)) {
        await this.handleClientEvent(ws, { event, channel, data })
      } else {
        console.log('Message event handler not implemented.', event)
      }
    } catch {
      //
    }
  }

  public handleClose(ws: WebSocket) {
    this.connections.unsubscribeAll(ws)
    this.connections.remove(ws)
  }

  private handleSubscribe(ws: WebSocket, channel: string) {
    if (this.connections.isSubscribed(ws, channel)) {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        channel,
        data: {
          code: 4100,
          message: 'Already subscribed to channel',
        },
      })
    }

    this.connections.subscribe(ws, channel)

    this.connections.sendTo(ws, {
      event: 'pusher_internal:subscription_succeeded',
      data: { channel },
    })
  }

  private handleUnsubscribe(ws: WebSocket, channel: string) {
    this.connections.unsubscribe(ws, channel)
  }

  private isClientEvent(event: string) {
    return event.startsWith('client-')
  }

  private async handleClientEvent(ws: WebSocket, message: PusherMessage) {
    const { event, channel, data } = message
    const config = await this.app.getConfig(this.key)

    if (!config.enable_client_events) {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        channel,
        data: {
          code: 4301,
          message: 'Client events are not enabled',
        },
      })
    }

    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    if (payload.length > 262_144) {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        channel,
        data: {
          code: 4302,
          message: 'Maximum client event data size exceeded',
        },
      })
    }

    if (channel) {
      if (this.connections.isSubscribed(ws, channel)) {
        const { id } = ws.deserializeAttachment()
        this.connections.broadcast(channel, event, data, id)
      }
    }
  }

  public canAcceptNewConnection(maxConnections: number) {
    if (maxConnections === -1) return true
    return this.connections.getSocketCount() + 1 <= maxConnections
  }
}
