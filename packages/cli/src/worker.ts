import { createHmac } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import {
  type AppPolicy,
  generateSocketId,
  invalidInfoAttribute,
  isStringValue,
  type JsonValue,
  type RealtimeConnection,
  type RealtimeHooks,
  RealtimeNamespace,
  serializeMessage,
  verifyRestAuth,
} from '@socketo/core'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

const BATCH_LIMIT = 10

type WsSocket = import('ws').WebSocket
type WsServer = import('ws').WebSocketServer

export type Logger = (...args: unknown[]) => void

export interface ServerOptions {
  port?: number
  host?: string
  appId?: string
  appKey?: string
  appSecret?: string
  enableClientEvents?: boolean
  verbose?: boolean
  logger?: Logger
}

type HonoEnv = {
  Variables: {
    parsedBody: unknown
  }
}

interface AuthResponseBody {
  auth: string
  channel_data?: string
}

interface AuthRequestBody {
  socket_id?: string
  channel_name?: string
  channel_data?: string
}

interface TriggerRequestBody {
  name?: string
  channels?: string[]
  channel?: string
  data?: JsonValue
  socket_id?: string
  info?: string
}

interface BatchEventItem {
  name?: string
  channel?: string
  channels?: string[]
  data?: JsonValue
  socket_id?: string
  info?: string
}

interface BatchRequestBody {
  batch?: BatchEventItem[]
}

function ts(): string {
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
      if (ws.readyState === ws.OPEN) {
        sendSocket(ws, message)
      }
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
  public readonly host: string
  public readonly appId: string
  public readonly appKey: string
  public readonly appSecret: string
  public readonly startTime: number = Date.now()
  public verbose: boolean
  public logger: Logger
  private readonly namespace: RealtimeNamespace
  private readonly timers = new Map<
    string,
    {
      activity: ReturnType<typeof setInterval>
      pong: ReturnType<typeof setTimeout> | null
    }
  >()
  private httpServer: ReturnType<typeof createHttpServer> | null = null
  private wss: WsServer | null = null
  private readonly sockets = new Set<WsSocket>()

  private readonly ACTIVITY_TIMEOUT = 120_000
  private readonly PONG_TIMEOUT = 30_000

  constructor(options: ServerOptions = {}) {
    this.port = options.port ?? 8787
    this.host = options.host || '0.0.0.0'
    this.appKey = options.appKey || 'local'
    this.appId = options.appId || this.appKey
    this.appSecret = options.appSecret || this.appKey
    this.verbose = options.verbose ?? false
    this.logger = options.logger ?? console.log

    const policy: AppPolicy = {
      key: this.appKey,
      secret: this.appSecret || this.appKey,
      enableClientEvents: options.enableClientEvents ?? true,
    }

    const hooks: RealtimeHooks = {
      onClientEvent: (event) => {
        if (this.verbose) {
          this.log(
            `[${ts()}] client-event ${event.event} on ${event.channel}`,
            event.data ?? '',
          )
        } else {
          this.log(`[${ts()}] client-event ${event.event} on ${event.channel}`)
        }
      },
      onMemberAdded: (channel, userId) => {
        this.log(`[${ts()}] member+     ${userId} → ${channel}`)
      },
      onMemberRemoved: (channel, userId) => {
        this.log(`[${ts()}] member-     ${userId} ← ${channel}`)
      },
      onChannelOccupied: (channel) => {
        this.log(`[${ts()}] occupied    ${channel}`)
      },
      onChannelVacated: (channel) => {
        this.log(`[${ts()}] vacated     ${channel}`)
      },
    }

    this.namespace = new RealtimeNamespace(policy, hooks)
  }

  public log(...args: unknown[]): void {
    this.logger(...args)
  }

  public setLogger(logger: Logger): void {
    this.logger = logger
  }

  createApp(): Hono<HonoEnv> {
    const app = new Hono<HonoEnv>()
    const appKey = this.appKey
    const secret = this.appSecret || appKey

    app.use('*', cors())

    // REST Auth Middleware
    app.use('/apps/:id/*', async (c, next) => {
      const appIdParam = c.req.param('id')
      if (
        appKey !== '*' &&
        appIdParam !== this.appKey &&
        appIdParam !== this.appId
      ) {
        return c.json({ error: 'Invalid app key' }, 403)
      }

      const url = new URL(c.req.url)
      let rawBody: string | undefined
      if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
        const text = await c.req.text()
        rawBody = text || url.searchParams.has('body_md5') ? text : undefined
      }

      const authKey = url.searchParams.get('auth_key')
      const targetAppKey =
        authKey === this.appId || authKey === this.appKey
          ? authKey
          : this.appKey

      const isValid = verifyRestAuth({
        method: c.req.method,
        path: url.pathname,
        query: url.searchParams,
        body: rawBody,
        appKey: targetAppKey,
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
      // SAFETY: parsedBody is populated by body parsing middleware and validated structurally below.
      const body = (c.get('parsedBody') ?? {}) as AuthRequestBody
      const { socket_id, channel_name, channel_data } = body

      if (!socket_id || !channel_name) {
        return c.json({ error: 'Invalid payload' }, 400)
      }

      const signString = channel_data
        ? `${socket_id}:${channel_name}:${channel_data}`
        : `${socket_id}:${channel_name}`

      const signature = createHmac('sha256', secret)
        .update(signString)
        .digest('hex')

      const auth = `${appKey}:${signature}`

      const res: AuthResponseBody = { auth }
      if (channel_data !== undefined) res.channel_data = channel_data

      return c.json(res)
    })

    // Single / Multi-channel Events Trigger
    app.post('/apps/:id/events', async (c) => {
      // SAFETY: parsedBody is populated by body parsing middleware and validated structurally below.
      const body = (c.get('parsedBody') ?? {}) as TriggerRequestBody
      const { name, channels, channel, data, socket_id, info } = body

      if (channel && channels) {
        return c.json(
          { error: 'Cannot provide both channel and channels' },
          400,
        )
      }

      const chanList = channels ?? (channel ? [channel] : [])
      if (!name || chanList.length === 0) {
        return c.json({ error: 'Invalid payload' }, 400)
      }
      if (channels && channels.length === 0) {
        return c.json({ error: 'At least one channel must be specified' }, 400)
      }

      const invalidAttr = invalidInfoAttribute(info)
      if (invalidAttr) {
        return c.json({ error: `Invalid info attribute: ${invalidAttr}` }, 400)
      }

      const result = await this.namespace.trigger({
        name,
        channels: chanList,
        data: data ?? {},
        socket_id,
        info,
      })

      if (this.verbose) {
        this.log(
          `[${ts()}] trigger    ${name} → ${chanList.join(', ')}`,
          data ?? '',
        )
      } else {
        this.log(`[${ts()}] trigger    ${name} → ${chanList.join(', ')}`)
      }

      if (result.channels) {
        return c.json({ channels: result.channels })
      }

      return c.json({})
    })

    // Batch Events Trigger
    app.post('/apps/:id/batch_events', async (c) => {
      // SAFETY: parsedBody is populated by body parsing middleware and validated structurally below.
      const body = (c.get('parsedBody') ?? {}) as BatchRequestBody
      const batch = body.batch

      if (!batch || !Array.isArray(batch)) {
        return c.json({ error: 'Batch must be an array' }, 400)
      }
      if (batch.length === 0) {
        return c.json({ error: 'Batch cannot be empty' }, 400)
      }
      if (batch.length > BATCH_LIMIT) {
        return c.json(
          { error: `Batch size cannot exceed ${BATCH_LIMIT} events` },
          400,
        )
      }

      for (const event of batch) {
        if (!event.name) {
          return c.json({ error: 'Every event in batch requires a name' }, 400)
        }
        if (!event.channel) {
          return c.json(
            { error: 'Every event in batch requires a channel' },
            400,
          )
        }
        if (event.channels) {
          return c.json(
            { error: 'Batch events only support single channel' },
            400,
          )
        }
        const invalidAttr = invalidInfoAttribute(event.info)
        if (invalidAttr) {
          return c.json(
            { error: `Invalid info attribute: ${invalidAttr}` },
            400,
          )
        }
      }

      const result = await this.namespace.triggerBatch({
        batch: batch
          .filter(
            (item): item is typeof item & { name: string; channel: string } =>
              Boolean(item.name && item.channel),
          )
          .map((item) => ({
            name: item.name,
            channel: item.channel,
            data: item.data ?? {},
            socket_id: item.socket_id,
            info: item.info,
          })),
      })

      if (this.verbose) {
        for (const event of batch) {
          this.log(
            `[${ts()}] batch      ${event.name} → ${event.channel}`,
            event.data ?? '',
          )
        }
      } else {
        for (const event of batch) {
          this.log(`[${ts()}] batch      ${event.name} → ${event.channel}`)
        }
      }

      return c.json(result)
    })

    // List channels
    app.get('/apps/:id/channels', (c) => {
      const prefix = c.req.query('filter_by_prefix')
      const info = c.req.query('info')
      const infoAttrs = info ? info.split(',').map((s) => s.trim()) : []

      const invalidAttr = invalidInfoAttribute(info)
      if (invalidAttr) {
        return c.json({ error: `Invalid info attribute: ${invalidAttr}` }, 400)
      }
      if (infoAttrs.includes('user_count') && prefix !== 'presence-') {
        return c.json(
          {
            error:
              'user_count requires filter_by_prefix=presence- or individual presence channel query',
          },
          400,
        )
      }

      const result = this.namespace.queryChannels({
        filterByPrefix: prefix,
        info,
      })
      return c.json(result)
    })

    // Get channel info
    app.get('/apps/:id/channels/:name', (c) => {
      const channel = c.req.param('name')
      const info = c.req.query('info')
      const infoAttrs = info ? info.split(',').map((s) => s.trim()) : []

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
              'subscription_count cannot be queried on presence channels (use user_count instead)',
          },
          400,
        )
      }

      const result = this.namespace.queryChannel(channel, { info })
      if (!result) {
        return c.json({ occupied: false })
      }

      return c.json(result)
    })

    // Get presence channel users
    app.get('/apps/:id/channels/:name/users', (c) => {
      const channel = c.req.param('name')

      if (!channel.startsWith('presence-')) {
        return c.json(
          { error: 'Users endpoint is only available for presence channels' },
          400,
        )
      }

      const users = this.namespace.queryChannelUsers(channel)
      return c.json({ users: users ?? [] })
    })

    // Terminate user connections
    app.post('/apps/:id/users/:user_id/terminate_connections', async (c) => {
      const userId = c.req.param('user_id')
      await this.namespace.terminateUserConnections(userId)
      return c.json({})
    })

    // Send event directly to user
    app.post('/apps/:id/users/:user_id/events', async (c) => {
      const userId = c.req.param('user_id')
      // SAFETY: parsedBody is populated by REST auth middleware as JsonRecord.
      const body = (c.get('parsedBody') ?? {}) as { name?: string; data?: unknown }
      if (!isStringValue(body.name)) {
        return c.json({ error: 'Event name is required' }, 400)
      }

      // SAFETY: body conforms to JsonRecord and data defaults to empty object.
      await this.namespace.sendToUser(userId, body.name, (body.data ?? {}) as never)
      return c.json({})
    })

    return app
  }

  async listen(): Promise<void> {
    const { WebSocketServer } = await import('ws')
    const port = this.port
    const host = this.host
    const app = this.createApp()
    const appKey = this.appKey

    const httpServer = createHttpServer(getRequestListener(app.fetch))
    this.httpServer = httpServer
    const wss = new WebSocketServer({ noServer: true })
    this.wss = wss

    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${host}:${port}`)
      const match = url.pathname.match(/^\/app\/([^/]+)$/)

      if (!match || (appKey !== '*' && match[1] !== appKey)) {
        socket.destroy()
        return
      }

      const protocol = url.searchParams.get('protocol')
      if (!protocol) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          this.rejectSocket(ws, 4008, 'No protocol version supplied')
        })
        return
      }
      if (protocol !== '7') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          this.rejectSocket(ws, 4007, 'Unsupported protocol version')
        })
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        this.sockets.add(ws)
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

        if (this.verbose) {
          this.log(`[${ts()}] connect    ${socketId}`)
        }

        ws.on('message', (rawData: string | Buffer) => {
          this.startActivityTimer(socketId, ws)
          const text = Buffer.isBuffer(rawData)
            ? rawData.toString()
            : rawData
          void this.namespace.receive(socketId, text).catch(() => undefined)
        })

        ws.on('close', () => {
          this.sockets.delete(ws)
          this.clearTimers(socketId)
          this.namespace.disconnect(socketId)
          if (this.verbose) {
            this.log(`[${ts()}] disconnect ${socketId}`)
          }
        })
      })
    })

    return new Promise<void>((resolve) => {
      httpServer.listen(port, host === '0.0.0.0' ? undefined : host, () =>
        resolve(),
      )
    })
  }

  async close(): Promise<void> {
    for (const [, timer] of this.timers) {
      clearInterval(timer.activity)
      if (timer.pong) clearTimeout(timer.pong)
    }
    this.timers.clear()

    for (const ws of this.sockets) {
      try {
        ws.terminate()
      } catch {
        // Socket already closed
      }
    }
    this.sockets.clear()

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    const httpServer = this.httpServer
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
      this.httpServer = null
    }
  }

  public async broadcast(
    channel: string,
    event: string,
    data: JsonValue = {},
  ): Promise<number> {
    return this.namespace.broadcast({
      channel,
      event,
      data,
    })
  }

  public getChannelsInfo(): Map<
    string,
    { subscription_count: number; user_count: number }
  > {
    return this.namespace.getChannelsWithInfo()
  }

  public getPresenceUsers(channel: string): Array<{ id: string }> | null {
    return this.namespace.getChannelUsers(channel)
  }

  public getSocketsInfo(): Array<{
    id: string
    channels: string[]
    userId?: string
  }> {
    return this.namespace.getAllSessions().map((s) => ({
      id: s.id,
      channels: s.channels,
      userId: s.userId,
    }))
  }

  public async terminateUser(userId: string): Promise<void> {
    await this.namespace.terminateUserConnections(userId)
  }

  public getStartTime(): number {
    return this.startTime
  }

  public getSocketCount(): number {
    return this.namespace.getSocketCount()
  }

  public getChannelsCount(): number {
    return this.namespace.getChannelsCount()
  }

  public getUsersCount(): number {
    return this.namespace.getUsersCount()
  }

  public toggleVerbose(): boolean {
    this.verbose = !this.verbose
    return this.verbose
  }

  public printBanner(): void {
    const DIM = '\x1b[2m'
    // Primary brand color: oklch(60% .118 184.704) -> rgb(0, 150, 137)
    const PRIMARY = '\x1b[38;2;0;150;137m'
    const PRIMARY_BOLD = '\x1b[1;38;2;0;150;137m'
    const RESET = '\x1b[0m'

    const displayHost = this.host === '0.0.0.0' ? 'localhost' : this.host
    const wsUrl = `ws://${displayHost}:${this.port}`
    const restUrl = `http://${displayHost}:${this.port}`

    const isUnified =
      this.appId === this.appKey && this.appKey === this.appSecret

    const credLine = isUnified
      ? `  ${DIM}➜${RESET}  ${PRIMARY}App id/key/secret:${RESET}  ${this.appKey}`
      : `  ${DIM}➜${RESET}  ${PRIMARY}App ID:${RESET}             ${this.appId}\n  ${DIM}➜${RESET}  ${PRIMARY}App Key:${RESET}            ${this.appKey}\n  ${DIM}➜${RESET}  ${PRIMARY}App Secret:${RESET}         ${this.appSecret}`

    console.log(`
  ${PRIMARY_BOLD}⚡ Socketo Dev Server${RESET}

  ${DIM}➜${RESET}  ${PRIMARY}WebSocket:${RESET}          ${wsUrl}
  ${DIM}➜${RESET}  ${PRIMARY}REST API:${RESET}           ${restUrl}
${credLine}
  ${DIM}➜${RESET}  ${PRIMARY}Verbose:${RESET}            ${this.verbose ? 'enabled' : 'disabled'} ${DIM}(/v to toggle)${RESET}

  ${DIM}Type${RESET} ${PRIMARY}/help${RESET} ${DIM}for interactive commands (e.g. /trigger)${RESET}
  ${DIM}Type${RESET} ${PRIMARY}/quit${RESET} ${DIM}or press Ctrl+C to stop${RESET}
`)
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
