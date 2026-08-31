import { createHmac } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import {
  type AppPolicy,
  generateSocketId,
  invalidInfoAttribute,
  type JsonValue,
  type RealtimeConnection,
  RealtimeNamespace,
  serializeMessage,
  verifyRestAuth,
} from '@socketo/realtime-core'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  decodeAuthRequest,
  decodeBatchRequest,
  decodeEventTriggerRequest,
} from './protocol.js'

const APP_KEY = 'local'
const BATCH_LIMIT = 10

type WsSocket = import('ws').WebSocket

type AppVariables = {
  parsedBody: JsonValue
}

export type ServerOptions = {
  port?: number
  appSecret?: string
}

function ts() {
  return new Date().toISOString().slice(11, 19)
}

function sendSocket(ws: WsSocket, message: string): void {
  try {
    ws.send(message)
  } catch {
    ws.close(4200, 'Send failed')
  }
}

function toConnection(id: string, ws: WsSocket): RealtimeConnection {
  return {
    id,
    send(message) {
      sendSocket(ws, message)
    },
    close(code, reason) {
      try {
        ws.close(code, reason)
      } catch {
        // Socket may already be closed
      }
    },
  }
}

export class SocketoServer {
  public readonly port: number
  public readonly appSecret: string
  private readonly namespace: RealtimeNamespace
  private readonly timers = new Map<
    string,
    {
      activity: ReturnType<typeof setInterval>
      pong: ReturnType<typeof setTimeout> | null
    }
  >()
  private httpServer: ReturnType<typeof createHttpServer> | null = null

  private readonly ACTIVITY_TIMEOUT = 120_000
  private readonly PONG_TIMEOUT = 30_000

  constructor(options: ServerOptions = {}) {
    this.port = options.port ?? 8787
    this.appSecret = options.appSecret || ''
    const policy: AppPolicy = {
      key: APP_KEY,
      secret: this.appSecret || APP_KEY,
      enableClientEvents: true,
    }
    this.namespace = new RealtimeNamespace(policy)
  }

  createApp(): Hono<{ Variables: AppVariables }> {
    const app = new Hono<{ Variables: AppVariables }>()
    const secret = this.appSecret || APP_KEY

    app.use('*', cors())

    // REST Auth Middleware
    app.use('/apps/:id/*', async (c, next) => {
      const appId = c.req.param('id')
      if (appId !== APP_KEY) {
        return c.json({ error: 'Invalid app key' }, 403)
      }

      const url = new URL(c.req.url)
      let rawBody: string | undefined
      if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
        rawBody = await c.req.text()
      }

      const isValid = verifyRestAuth({
        method: c.req.method,
        path: url.pathname,
        query: url.searchParams,
        body: rawBody,
        appKey: APP_KEY,
        appSecret: secret,
      })

      if (!isValid) {
        return c.json({ error: 'Invalid auth signature' }, 401)
      }

      if (rawBody !== undefined) {
        try {
          const parsed = rawBody ? JSON.parse(rawBody) : {}
          c.set('parsedBody', parsed)
        } catch {
          return c.json({ error: 'Invalid request body' }, 400)
        }
      }

      await next()
    })

    // Sockets metric
    app.get('/apps/:id/sockets', (c) => {
      return c.json({ sockets: this.namespace.getSocketCount() })
    })

    // Auth endpoint for private/presence channels
    app.post('/apps/:id/auth', (c) => {
      const body = decodeAuthRequest(c.get('parsedBody') ?? {})
      const { socket_id, channel_name, channel_data } = body

      if (!socket_id || !channel_name) {
        return c.json({ error: 'Invalid payload' }, 400)
      }
      if (
        !channel_name.startsWith('private-') &&
        !channel_name.startsWith('presence-')
      ) {
        return c.json(
          { error: 'Public channels do not require authentication' },
          400,
        )
      }
      if (channel_name.startsWith('presence-') && !channel_data) {
        return c.json(
          { error: 'Missing channel_data for presence channel' },
          400,
        )
      }

      const stringToSign = channel_data
        ? `${socket_id}:${channel_name}:${channel_data}`
        : `${socket_id}:${channel_name}`
      const signature = createHmac('sha256', secret)
        .update(stringToSign)
        .digest('hex')
      const auth = `${APP_KEY}:${signature}`

      const res = {
        auth,
        channel_data,
      } satisfies { auth: string; channel_data?: string }
      return c.json(res)
    })

    // Event Trigger
    app.post('/apps/:id/events', async (c) => {
      const body = decodeEventTriggerRequest(c.get('parsedBody') ?? {})
      const { name, channels, channel, data, socket_id, info } = body

      if (channel && channels) {
        return c.json(
          { error: 'Specify either channel or channels, not both' },
          400,
        )
      }

      const chanList = channels ?? (channel ? [channel] : [])
      if (chanList.length === 0 || !name) {
        return c.json({ error: 'Missing channel or name' }, 400)
      }

      const invalidAttr = invalidInfoAttribute(info)
      if (invalidAttr) {
        return c.json({ error: `Invalid info attribute: ${invalidAttr}` }, 400)
      }

      for (const ch of chanList) {
        await this.namespace.broadcast({
          event: name,
          channel: ch,
          data: data ?? {},
          exceptId: socket_id,
        })
      }

      console.log(`[${ts()}] trigger    ${name} → ${chanList.join(', ')}`)

      if (info) {
        const attrs = info.split(',').map((s) => s.trim())
        const result: Record<
          string,
          { subscription_count?: number; user_count?: number }
        > = {}
        for (const ch of chanList) {
          const chInfo = this.namespace.getChannel(ch)
          const chRes = {} satisfies {
            subscription_count?: number
            user_count?: number
          }
          if (chInfo) {
            if (
              attrs.includes('subscription_count') &&
              !ch.startsWith('presence-')
            ) {
              chRes.subscription_count = chInfo.subscription_count
            }
            if (attrs.includes('user_count') && ch.startsWith('presence-')) {
              chRes.user_count = chInfo.user_count
            }
          }
          result[ch] = chRes
        }
        return c.json({ channels: result })
      }

      return c.json({})
    })

    // Batch Events Trigger
    app.post('/apps/:id/batch_events', async (c) => {
      const body = decodeBatchRequest(c.get('parsedBody') ?? {})
      const batch = body.batch

      if (!batch || !Array.isArray(batch)) {
        return c.json({ error: 'Invalid payload' }, 400)
      }
      if (batch.length === 0) {
        return c.json({ error: 'Batch must contain at least one event' }, 400)
      }
      if (batch.length > BATCH_LIMIT) {
        return c.json(
          { error: `Batch size must not exceed ${BATCH_LIMIT}` },
          400,
        )
      }

      for (const event of batch) {
        if (event.channels) {
          return c.json(
            { error: 'Batch events must use channel, not channels' },
            400,
          )
        }
        if (!event.name || !event.channel) {
          return c.json(
            { error: 'Each batch event must have name and channel' },
            400,
          )
        }
        if (event.info) {
          const invalidAttr = invalidInfoAttribute(event.info)
          if (invalidAttr) {
            return c.json(
              { error: `Invalid info attribute: ${invalidAttr}` },
              400,
            )
          }
        }
      }

      const results: Array<{
        subscription_count?: number
        user_count?: number
      }> = []
      for (const event of batch) {
        await this.namespace.broadcast({
          event: event.name!,
          channel: event.channel!,
          data: event.data ?? {},
          exceptId: event.socket_id,
        })

        console.log(`[${ts()}] batch      ${event.name} → ${event.channel}`)

        const infoRes = {} satisfies {
          subscription_count?: number
          user_count?: number
        }
        if (event.info) {
          const infoAttrs = event.info.split(',').map((s) => s.trim())
          const chInfo = this.namespace.getChannel(event.channel!)
          if (chInfo) {
            if (
              infoAttrs.includes('subscription_count') &&
              !event.channel!.startsWith('presence-')
            ) {
              infoRes.subscription_count = chInfo.subscription_count
            }
            if (
              infoAttrs.includes('user_count') &&
              event.channel!.startsWith('presence-')
            ) {
              infoRes.user_count = chInfo.user_count
            }
          }
        }
        results.push(infoRes)
      }

      return c.json({ batch: results })
    })

    // Channels List
    app.get('/apps/:id/channels', (c) => {
      const prefix = c.req.query('filter_by_prefix') || ''
      const info = c.req.query('info') || ''

      if (info) {
        const invalidAttr = invalidInfoAttribute(info)
        if (invalidAttr) {
          return c.json(
            { error: `Invalid info attribute: ${invalidAttr}` },
            400,
          )
        }
      }

      const infoAttrs = info
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const includeUserCount = infoAttrs.includes('user_count')
      const includeSubCount = infoAttrs.includes('subscription_count')

      if (includeUserCount && !prefix.startsWith('presence-')) {
        return c.json(
          { error: 'user_count requires filtering by presence- prefix' },
          400,
        )
      }

      const channels: Record<
        string,
        { user_count?: number; subscription_count?: number }
      > = {}
      if (includeUserCount) {
        const all = this.namespace.getChannelsWithInfo()
        for (const [name, counts] of all) {
          if (prefix && !name.startsWith(prefix)) continue
          const chInfo = {
            user_count: counts.user_count,
          } satisfies { user_count?: number; subscription_count?: number }
          if (includeSubCount && !name.startsWith('presence-')) {
            chInfo.subscription_count = counts.subscription_count
          }
          channels[name] = chInfo
        }
      } else {
        const all = this.namespace.getChannels()
        for (const [name, count] of all) {
          if (prefix && !name.startsWith(prefix)) continue
          const chInfo = {} satisfies { subscription_count?: number }
          if (includeSubCount && !name.startsWith('presence-')) {
            chInfo.subscription_count = count
          }
          channels[name] = chInfo
        }
      }

      return c.json({ channels })
    })

    // Channel Info
    app.get('/apps/:id/channels/:name', (c) => {
      const channel = c.req.param('name')
      const info = c.req.query('info') || ''
      const infoAttrs = info
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      const invalidAttr = invalidInfoAttribute(info)
      if (invalidAttr) {
        return c.json({ error: `Invalid info attribute: ${invalidAttr}` }, 400)
      }
      if (
        infoAttrs.includes('user_count') &&
        !channel.startsWith('presence-')
      ) {
        return c.json(
          { error: 'user_count is only available for presence channels' },
          400,
        )
      }
      if (
        infoAttrs.includes('subscription_count') &&
        channel.startsWith('presence-')
      ) {
        return c.json(
          {
            error:
              'subscription_count is only available for non-presence channels',
          },
          400,
        )
      }

      const channelInfo = this.namespace.getChannel(channel)
      if (!channelInfo) {
        return c.json({ occupied: false })
      }

      const res = {
        occupied: true,
      } satisfies {
        occupied: boolean
        subscription_count?: number
        user_count?: number
      }
      if (infoAttrs.includes('subscription_count')) {
        res.subscription_count = channelInfo.subscription_count
      }
      if (infoAttrs.includes('user_count')) {
        res.user_count = channelInfo.user_count
      }
      return c.json(res)
    })

    // Presence Channel Users
    app.get('/apps/:id/channels/:name/users', (c) => {
      const channel = c.req.param('name')
      const users = this.namespace.getChannelUsers(channel)
      if (users === null) {
        return c.json(
          { error: 'users endpoint is only available for presence channels' },
          400,
        )
      }
      return c.json({ users })
    })

    // Terminate Connections
    app.post('/apps/:id/users/:userId/terminate_connections', async (c) => {
      const userId = c.req.param('userId')
      await this.namespace.terminateUserConnections(userId)
      return c.json({})
    })

    return app
  }

  async listen(port = this.port): Promise<void> {
    const { WebSocketServer } = await import('ws')
    const app = this.createApp()
    const requestListener = getRequestListener(app.fetch)
    const httpServer = createHttpServer(requestListener)
    this.httpServer = httpServer

    const wss = new WebSocketServer({ noServer: true })

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      const match = url.pathname.match(/^\/app\/([^/]+)$/)

      if (!match) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }

      const appKey = match[1]
      const protocol = url.searchParams.get('protocol')

      if (appKey !== APP_KEY) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }

      if (protocol !== '7') {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const socketId = generateSocketId()
        this.namespace.connect(toConnection(socketId, ws))
        this.startActivityTimer(socketId, ws)

        sendSocket(
          ws,
          serializeMessage({
            event: 'pusher:connection_established',
            data: {
              socket_id: socketId,
              activity_timeout: 120,
            },
          }),
        )

        console.log(`[${ts()}] connect    ${socketId.slice(0, 8)}`)

        ws.on('message', (rawData: string | Buffer) => {
          this.startActivityTimer(socketId, ws)
          const text = String(rawData)
          void this.namespace.receive(socketId, text).catch(() => undefined)
        })

        let disconnected = false
        const disconnect = () => {
          if (disconnected) return
          disconnected = true
          this.clearTimers(socketId)
          void this.namespace.disconnect(socketId).catch(() => undefined)
          console.log(`[${ts()}] disconnect ${socketId.slice(0, 8)}`)
        }

        ws.on('error', disconnect)
        ws.on('close', disconnect)
      })
    })

    return new Promise<void>((resolve) => {
      httpServer.listen(port, () => resolve())
    })
  }

  async close(): Promise<void> {
    const httpServer = this.httpServer
    if (!httpServer) return
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve())
    })
  }

  private rejectSocket(ws: WsSocket, code: number, message: string): void {
    sendSocket(
      ws,
      serializeMessage({ event: 'pusher:error', data: { code, message } }),
    )
    ws.close(code, message)
  }

  private startActivityTimer(socketId: string, ws: WsSocket): void {
    this.clearTimers(socketId)
    const activity = setInterval(() => {
      sendSocket(ws, serializeMessage({ event: 'pusher:ping', data: {} }))
      const existing = this.timers.get(socketId)
      if (!existing) return
      if (existing.pong) clearTimeout(existing.pong)
      const pong = setTimeout(() => {
        this.clearTimers(socketId)
        try {
          ws.close(4201, 'Pong reply not received')
        } catch {
          // Socket may already be closed
        }
      }, this.PONG_TIMEOUT)
      existing.pong = pong
    }, this.ACTIVITY_TIMEOUT)
    this.timers.set(socketId, { activity, pong: null })
  }

  private clearTimers(socketId: string): void {
    const existing = this.timers.get(socketId)
    if (!existing) return
    clearInterval(existing.activity)
    if (existing.pong) clearTimeout(existing.pong)
    this.timers.delete(socketId)
  }
}
