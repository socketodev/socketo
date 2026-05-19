import type { ConnectionManager } from '../managers/connection-manager'
import type {
  ParsedUserData,
  PusherMessage,
  SigninData,
  SubscribeData,
  UnsubscribeData,
} from '../types'
import {
  isPresenceChannel,
  isProtectedChannel,
  verifyChannelAuth,
  verifySigninAuth,
} from '../utils/auth'
import { isValidChannelName, isValidEventName } from '../utils/validation'
import type { AppHandler } from './app-handler'

export class WebSocketHandler {
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

  public async handleMessage(ws: WebSocket, message: string) {
    try {
      const parsed = JSON.parse(message) as PusherMessage
      const { event, channel, data } = parsed

      if (event === 'pusher:signin') {
        await this.handleSignin(ws, data as SigninData)
      } else if (event === 'pusher:subscribe') {
        await this.handleSubscribe(ws, data as SubscribeData)
      } else if (event === 'pusher:unsubscribe') {
        const channel = (data as UnsubscribeData)?.channel
        if (channel) await this.handleUnsubscribe(ws, channel)
      } else if (this.isClientEvent(event)) {
        await this.handleClientEvent(ws, { event, channel, data })
      } else {
        console.log('Message event handler not implemented.', event)
      }
    } catch (e) {
      console.error('Failed to handle WebSocket message:', e)
    }
  }

  public handleClose(ws: WebSocket) {
    const { channels, user_id } = ws.deserializeAttachment()

    for (const channel of channels) {
      if (isPresenceChannel(channel) && user_id) {
        this.connections.broadcast(channel, 'pusher_internal:member_removed', {
          user_id,
        })
      }
    }

    this.connections.unsubscribeAll(ws)
    this.connections.remove(ws)
  }

  private async handleSignin(
    ws: WebSocket,
    data: { auth?: string; user_data?: string },
  ) {
    if (!data.auth || !data.user_data) {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        data: {
          code: 4009,
          message: 'Invalid signin data: auth and user_data required',
        },
      })
    }

    const { id: socketId } = ws.deserializeAttachment()
    const config = await this.app.getConfig(this.ctx.id.name)

    const isValid = verifySigninAuth(
      socketId,
      data.user_data,
      data.auth,
      config.secret,
      config.key,
    )

    if (!isValid) {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        data: {
          code: 4009,
          message: 'Invalid signin signature',
        },
      })
    }

    try {
      const userData = JSON.parse(data.user_data) as ParsedUserData

      const state = ws.deserializeAttachment()
      state.user_id = userData.id
      state.user_info = userData.user_info
      ws.serializeAttachment(state)

      this.connections.sendTo(ws, {
        event: 'pusher:signin_success',
        data: { user_data: data.user_data },
      })
    } catch {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        data: {
          code: 4009,
          message: 'Invalid user_data JSON',
        },
      })
    }
  }

  private async handleSubscribe(
    ws: WebSocket,
    data: { channel: string; auth?: string; channel_data?: string },
  ) {
    if (!isValidChannelName(data.channel)) {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        channel: data.channel,
        data: {
          code: 4009,
          message: 'Invalid channel name',
        },
      })
    }

    const { channels } = ws.deserializeAttachment()
    if (channels.has(data.channel)) {
      return this.connections.sendTo(ws, {
        event: 'pusher_internal:subscription_succeeded',
        channel: data.channel,
        data: isPresenceChannel(data.channel)
          ? this.connections.getPresenceData(data.channel)
          : {},
      })
    }

    if (isProtectedChannel(data.channel)) {
      if (!data.auth) {
        return this.connections.sendTo(ws, {
          event: 'pusher:error',
          channel: data.channel,
          data: {
            code: 4009,
            message: 'Auth string required for protected channel',
          },
        })
      }

      const { id: socketId } = ws.deserializeAttachment()
      const config = await this.app.getConfig(this.ctx.id.name)

      const isValid = verifyChannelAuth(
        socketId,
        data.channel,
        data.auth,
        config.secret,
        config.key,
      )

      if (!isValid) {
        return this.connections.sendTo(ws, {
          event: 'pusher:error',
          channel: data.channel,
          data: {
            code: 4009,
            message: 'Invalid channel auth signature',
          },
        })
      }
    }

    if (isPresenceChannel(data.channel)) {
      await this.handlePresenceSubscribe(ws, data)
    } else {
      this.connections.subscribe(ws, data.channel)

      this.connections.sendTo(ws, {
        event: 'pusher_internal:subscription_succeeded',
        channel: data.channel,
        data: {},
      })
    }
  }

  private async handlePresenceSubscribe(
    ws: WebSocket,
    data: { channel: string; channel_data?: string },
  ) {
    const { id, user_id } = ws.deserializeAttachment()
    if (!user_id) {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        channel: data.channel,
        data: {
          code: 4009,
          message: 'User must be signed in to subscribe to presence channel',
        },
      })
    }

    try {
      const channelData = data.channel_data
        ? (JSON.parse(data.channel_data) as {
            user_id: string
            user_info?: Record<string, unknown>
          })
        : null

      const state = ws.deserializeAttachment()
      if (channelData?.user_info) {
        state.user_info = channelData.user_info
      }
      ws.serializeAttachment(state)

      const { user_info } = ws.deserializeAttachment()
      this.connections.subscribe(ws, data.channel, user_id)

      const presenceData = this.connections.getPresenceData(data.channel)

      this.connections.sendTo(ws, {
        event: 'pusher_internal:subscription_succeeded',
        channel: data.channel,
        data: presenceData,
      })

      this.connections.broadcast(
        data.channel,
        'pusher_internal:member_added',
        {
          user_id,
          user_info: user_info || {},
        },
        id,
      )
    } catch {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        channel: data.channel,
        data: {
          code: 4009,
          message: 'Invalid channel_data JSON',
        },
      })
    }
  }

  private async handleUnsubscribe(ws: WebSocket, channel: string) {
    if (isPresenceChannel(channel)) {
      const { id, user_id } = ws.deserializeAttachment()
      if (user_id) {
        this.connections.broadcast(
          channel,
          'pusher_internal:member_removed',
          {
            user_id,
          },
          id,
        )
      }
    }

    this.connections.unsubscribe(ws, channel)
  }

  private isClientEvent(event: string) {
    return event.startsWith('client-')
  }

  private async handleClientEvent(ws: WebSocket, message: PusherMessage) {
    const { event, channel, data } = message

    if (!isValidEventName(event)) {
      return
    }

    if (channel && !isProtectedChannel(channel)) {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        channel,
        data: {
          code: 4009,
          message:
            'Client events are only allowed on private or presence channels',
        },
      })
    }

    const config = await this.app.getConfig(this.ctx.id.name)
    if (!config.enable_client_events) {
      return this.connections.sendTo(ws, {
        event: 'pusher:error',
        channel,
        data: {
          code: 4009,
          message: 'Client events are not enabled',
        },
      })
    }

    const { id, channels } = ws.deserializeAttachment()
    if (channel && channels.has(channel)) {
      const broadcastData =
        typeof data === 'string' ? data : JSON.stringify(data)
      if (isPresenceChannel(channel)) {
        const { user_id } = ws.deserializeAttachment()
        this.connections.broadcast(channel, event, broadcastData, id, user_id)
      } else {
        this.connections.broadcast(channel, event, broadcastData, id)
      }
    }
  }

  public canAcceptNewConnection(maxConnections: number) {
    if (maxConnections === -1) return true
    return this.connections.getSocketCount() + 1 <= maxConnections
  }
}
