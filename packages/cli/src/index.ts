#!/usr/bin/env node

import { parseArgs } from 'node:util'
import type { JsonValue } from '@socketo/core'
import { signRestRequest } from '@socketo/core'
import { startInteractiveRepl } from './repl.js'
import { SocketoServer } from './worker.js'

const DEFAULT_PORT = 8787
const DEFAULT_HOST = 'localhost'
const DEFAULT_APP_KEY = 'local'

function showHelp() {
  console.log(`
Socketo - Local Pusher-compatible WebSocket server

Usage:
  socketo [command] [options]

Commands:
  start [options]                   Start the server (default when no command given)
  subscribe <channel> [options]     Subscribe to a channel and watch live events
  trigger <channel> <event> [data]  Trigger an event on a channel via REST
  info [options]                    Show server status and active channels
  generate                          Generate client/server code snippets
  help                              Show this help message

Options:
  -p, --port <port>                 Port number (default: ${DEFAULT_PORT})
  -H, --host <host>                 Host address to bind (default: ${DEFAULT_HOST})
  -i, --app-id <id>                 Pusher App ID (default: matches app-key)
  -k, --app-key <key>               Pusher App Key (default: ${DEFAULT_APP_KEY})
  -s, --app-secret <secret>         Pusher App Secret for auth validation
  -v, --verbose                     Log detailed event payloads and socket activity
  --socket-id <id>                  Exclude socket from broadcast (trigger)
  --user-id <id>                    User ID for presence channels (subscribe)
  --presence                        Include presence data (subscribe)
  -h, --help                        Show this help message
`)
}

function parseTriggerData(value: string | undefined): JsonValue {
  if (!value) return {}
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    console.warn(
      'Warning: Could not parse data as JSON, sending as raw string.',
    )
    return value
  }
}

async function restRequest(
  host: string,
  port: number,
  path: string,
  appKey: string,
  options: {
    method?: string
    body?: string
    query?: Record<string, string>
    secret: string
  },
): Promise<Response> {
  const method = options.method ?? 'GET'
  const { queryParams } = signRestRequest({
    method,
    path,
    query: options.query,
    body: options.body,
    appKey,
    appSecret: options.secret,
  })

  return fetch(`http://${host}:${port}${path}?${queryParams.toString()}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: options.body,
  })
}

async function cmdStart(
  host: string,
  port: number,
  appId: string,
  appKey: string,
  appSecret: string,
  verbose: boolean,
) {
  const server = new SocketoServer({
    port,
    host,
    appId,
    appKey,
    appSecret: appSecret || undefined,
    verbose,
  })

  await server.listen()
  server.printBanner()

  if (process.stdin.isTTY) {
    startInteractiveRepl(server)
  }

  const onShutdown = async () => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', onShutdown)
  process.on('SIGTERM', onShutdown)
}

async function cmdSubscribe(
  channel: string,
  host: string,
  port: number,
  appKey: string,
  appSecret: string,
  isPresence: boolean,
  userId: string,
) {
  if (!channel) {
    console.error('Error: Channel name is required')
    console.log('Usage: socketo subscribe <channel>')
    process.exit(1)
  }

  const wsHost = host === '0.0.0.0' ? 'localhost' : host
  const ws = new WebSocket(`ws://${wsHost}:${port}/app/${appKey}?protocol=7`)

  ws.addEventListener('open', () => {
    console.log(`  Connected to ws://${wsHost}:${port}`)
  })

  ws.addEventListener('message', async (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as {
        event: string
        channel?: string
        data?: unknown
        user_id?: string
      }
      const timeStr = new Date().toLocaleTimeString()

      if (msg.event === 'pusher:connection_established') {
        const connData =
          typeof msg.data === 'string'
            ? (JSON.parse(msg.data) as { socket_id: string })
            : (msg.data as { socket_id: string })
        const socketId = connData.socket_id

        const channelData =
          isPresence || channel.startsWith('presence-')
            ? JSON.stringify({
                user_id: userId,
                user_info: { name: userId },
              })
            : undefined

        const subscribePayload: {
          channel: string
          auth?: string
          channel_data?: string
        } = { channel }

        if (channel.startsWith('private-') || channel.startsWith('presence-')) {
          const authBody: {
            socket_id: string
            channel_name: string
            channel_data?: string
          } = { socket_id: socketId, channel_name: channel }
          if (channelData) authBody.channel_data = channelData

          const res = await restRequest(
            wsHost,
            port,
            `/apps/${appKey}/auth`,
            appKey,
            {
              method: 'POST',
              body: JSON.stringify(authBody),
              secret: appSecret,
            },
          )
          if (!res.ok) {
            console.error(`Error: Auth failed (${res.status})`)
            ws.close()
            process.exit(1)
          }
          const authRes = (await res.json()) as { auth: string }
          subscribePayload.auth = authRes.auth
        }

        if (channelData) subscribePayload.channel_data = channelData

        ws.send(
          JSON.stringify({
            event: 'pusher:subscribe',
            data: subscribePayload,
          }),
        )
        console.log(`  Subscribed to ${channel}`)
        console.log('  Waiting for events...\n')
        return
      }

      if (msg.event === 'pusher_internal:subscription_succeeded') {
        const rawData =
          typeof msg.data === 'string'
            ? (JSON.parse(msg.data) as {
                presence?: { count: number; ids: string[] }
              })
            : (msg.data as { presence?: { count: number; ids: string[] } })
        if (rawData?.presence) {
          console.log(
            `  Presence: ${rawData.presence.count} member(s), IDs: ${rawData.presence.ids.join(', ')}`,
          )
        }
        return
      }

      if (msg.event === 'pusher:pong') return

      const dataStr =
        typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data ?? {})
      const userStr = msg.user_id ? ` [user: ${msg.user_id}]` : ''
      const chStr =
        msg.channel && msg.channel !== channel ? ` (${msg.channel})` : ''

      console.log(`  ${timeStr}  ${msg.event}${chStr}${userStr}`)
      console.log(`           ${dataStr}\n`)
    } catch {
      console.log(`  ${event.data}`)
    }
  })

  ws.addEventListener('error', () => {
    console.error(`Error: Could not connect to ws://${wsHost}:${port}`)
    console.error('Is the server running? Start it with: socketo start')
    process.exit(1)
  })

  ws.addEventListener('close', () => process.exit(0))
  process.on('SIGINT', () => {
    ws.close()
    process.exit(0)
  })
}

async function cmdTrigger(
  channel: string,
  eventName: string,
  rawData: string | undefined,
  host: string,
  port: number,
  appKey: string,
  socketId: string | undefined,
  appSecret: string,
) {
  if (!channel || !eventName) {
    console.error('Error: Channel name and event name are required')
    console.log('Usage: socketo trigger <channel> <event> [data]')
    process.exit(1)
  }

  const httpHost = host === '0.0.0.0' ? 'localhost' : host
  const data = parseTriggerData(rawData)
  const body: {
    name: string
    channel: string
    data: JsonValue
    socket_id?: string
  } = { name: eventName, channel, data }
  if (socketId) body.socket_id = socketId

  const res = await restRequest(
    httpHost,
    port,
    `/apps/${appKey}/events`,
    appKey,
    {
      method: 'POST',
      body: JSON.stringify(body),
      secret: appSecret,
    },
  )

  if (res.ok) {
    console.log(`  Event '${eventName}' sent to ${channel}`)
  } else {
    const text = await res.text()
    console.error(`Error: ${res.status} ${text}`)
    process.exit(1)
  }
}

async function cmdInfo(
  host: string,
  port: number,
  appKey: string,
  appSecret: string,
) {
  const httpHost = host === '0.0.0.0' ? 'localhost' : host
  try {
    const res = await restRequest(
      httpHost,
      port,
      `/apps/${appKey}/channels`,
      appKey,
      {
        query: { info: 'subscription_count' },
        secret: appSecret,
      },
    )
    if (!res.ok) {
      console.error(`Error: Could not reach server at port ${port}`)
      console.error('Is the server running? Start it with: socketo start')
      process.exit(1)
    }

    const body = (await res.json()) as {
      channels: Record<string, { subscription_count?: number }>
    }
    const channels = Object.keys(body.channels || {})

    console.log(`
  Server: ws://${httpHost}:${port}
  App key: ${appKey}
  Channels: ${channels.length}
`)

    if (channels.length > 0) {
      console.log('  Active Channels:')
      for (const ch of channels) {
        const count = body.channels[ch]?.subscription_count ?? '?'
        const prefix = ch.startsWith('presence-')
          ? '👥'
          : ch.startsWith('private-')
            ? '🔒'
            : '📡'
        console.log(`    ${prefix} ${ch}  (${count} subscriber(s))`)
      }
    } else {
      console.log('  No active channels.')
    }
    console.log('')
  } catch {
    console.error(`Error: Could not reach server at port ${port}`)
    console.error('Is the server running? Start it with: socketo start')
    process.exit(1)
  }
}

function cmdGenerate(host: string, port: number, appKey: string) {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host
  console.log(`
// ── Client (pusher-js) ──
import Pusher from 'pusher-js'

const pusher = new Pusher('${appKey}', {
  wsHost: '${displayHost}',
  wsPort: ${port},
  forceTLS: false,
  enabledTransports: ['ws'],
  cluster: 'local',
})

pusher.connection.bind('connected', () => {
  console.log('Connected! Socket ID:', pusher.connection.socket_id)
  const channel = pusher.subscribe('my-channel')
  channel.bind('my-event', (data: unknown) => {
    console.log('Received:', data)
  })
})

// ── Server (pusher) ──
import Pusher from 'pusher'

const server = new Pusher({
  appId: '${appKey}',
  key: '${appKey}',
  secret: '${appKey}',
  host: '${displayHost}:${port}',
  useTLS: false,
})

server.trigger('my-channel', 'my-event', { hello: 'world' })
`)
}

// --- Main CLI Entrypoint ---

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    host: { type: 'string', short: 'H' },
    port: { type: 'string', short: 'p' },
    'app-id': { type: 'string', short: 'i' },
    'app-key': { type: 'string', short: 'k' },
    'app-secret': { type: 'string', short: 's' },
    'socket-id': { type: 'string' },
    'user-id': { type: 'string' },
    presence: { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
})

const rawCommand = parsed.positionals[0]
const host = (parsed.values.host as string) || DEFAULT_HOST
const port = parsed.values.port
  ? parseInt(parsed.values.port as string, 10)
  : DEFAULT_PORT
const appKey =
  (parsed.values['app-key'] as string) ||
  process.env.SOCKETO_APP_KEY ||
  DEFAULT_APP_KEY
const appId =
  (parsed.values['app-id'] as string) || process.env.SOCKETO_APP_ID || appKey
const appSecret =
  (parsed.values['app-secret'] as string) ||
  process.env.SOCKETO_APP_SECRET ||
  appKey
const socketId = parsed.values['socket-id'] as string | undefined
const userId = (parsed.values['user-id'] as string) || 'user-1'
const isPresence = parsed.values.presence === true
const verbose = parsed.values.verbose === true

const KNOWN_COMMANDS = new Set([
  'start',
  'subscribe',
  'trigger',
  'info',
  'generate',
  'help',
])

if (parsed.values.help || rawCommand === 'help') {
  showHelp()
  process.exit(0)
}

// Default to 'start' if no positional command is supplied or if first positional isn't a known command
const command =
  !rawCommand || !KNOWN_COMMANDS.has(rawCommand) ? 'start' : rawCommand
const channelArg = command === 'start' ? rawCommand : parsed.positionals[1]

switch (command) {
  case 'start':
    await cmdStart(host, port, appId, appKey, appSecret, verbose)
    break
  case 'subscribe':
    await cmdSubscribe(
      channelArg,
      host,
      port,
      appKey,
      appSecret,
      isPresence,
      userId,
    )
    break
  case 'trigger':
    await cmdTrigger(
      parsed.positionals[1],
      parsed.positionals[2],
      parsed.positionals[3],
      host,
      port,
      appKey,
      socketId,
      appSecret,
    )
    break
  case 'info':
    await cmdInfo(host, port, appKey, appSecret)
    break
  case 'generate':
    cmdGenerate(host, port, appKey)
    break
  default:
    console.error(`Error: Unknown command '${command}'`)
    showHelp()
    process.exit(1)
}
