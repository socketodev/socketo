#!/usr/bin/env node

import type { JsonValue } from '@socketo/core'
import {
  type AuthRequest,
  decodeAuthResponse,
  decodeChannelListResponse,
  decodeConnectionEstablished,
  decodePresenceSubscription,
  type EventTriggerRequest,
  isStringValue,
  parseJson,
  parsePusherMessage,
  stringifyMessageData,
} from './protocol.js'
import { SocketoServer } from './worker.js'

const DEFAULT_PORT = 8787
const APP_KEY = 'local'

type CliFlagValue = string | boolean | undefined

interface CliFlags {
  [key: string]: CliFlagValue
}

type SubscribePayload = {
  channel: string
  auth?: string
  channel_data?: string
}

function parseFlags(args: string[]): CliFlags {
  const result: CliFlags = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--') break
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        result[key] = next
        i++
      } else {
        result[key] = true
      }
    } else if (arg.startsWith('-')) {
      const flag = arg.slice(1)
      if (flag === 'h' || flag === 'help') {
        result.help = true
      } else if (flag === 'p') {
        const next = args[i + 1]
        if (next) {
          result.port = next
          i++
        }
      }
    }
  }
  return result
}

function readStringFlag(value: CliFlagValue): string | undefined {
  return isStringValue(value) ? value : undefined
}

function readPort(flags: CliFlags): number {
  const value = readStringFlag(flags.port)
  return value === undefined ? DEFAULT_PORT : parseInt(value, 10)
}

function parseTriggerData(value: string | undefined): JsonValue {
  if (!value) return {}
  try {
    return parseJson(value)
  } catch {
    console.warn(`Warning: Could not parse data as JSON, sending as raw string.
  If using cmd.exe, try wrapping JSON in escaped double quotes.`)
    return value
  }
}

// --- Commands ---

function showHelp() {
  console.log(`
Socketo - Local Pusher-compatible WebSocket server

Usage:
  socketo <command> [options]

Commands:
  start [options]          Start the local Pusher-compatible server
  subscribe <channel>      Subscribe to a channel and watch live events
  trigger <channel> <event> [data]  Trigger an event on a channel
  info                     Show server status and active channels
  generate                 Generate client/server code with prefilled keys
  help                     Show this help message

Start Options:
  -p, --port <port>        Port number (default: ${DEFAULT_PORT})
  --app-secret <secret>    Secret for auth signature validation

Subscribe Options:
  -p, --port <port>        Server port (default: ${DEFAULT_PORT})
  --presence               Include presence channel_data
  --user-id <id>           User ID for presence channels

Trigger Options:
  -p, --port <port>        Server port (default: ${DEFAULT_PORT})
  --socket-id <id>         Exclude this socket from broadcast
`)
}

async function cmdStart(args: string[]) {
  const flags = parseFlags(args)

  if (flags.help) {
    console.log(`
Start the local Pusher-compatible WebSocket server.

Usage:
  socketo start [options]

  Options:
  -p, --port <port>            Port number (default: ${DEFAULT_PORT})
  --app-secret <secret>        Secret for auth signature validation
 `)
    return
  }

  const port = readPort(flags)
  if (!port || port < 1 || port > 65535) {
    console.error(`Error: Invalid port number`)
    process.exit(1)
  }

  const appSecret = readStringFlag(flags['app-secret']) ?? ''

  const server = new SocketoServer({
    port,
    appSecret: appSecret || undefined,
  })

  await server.listen()
  console.log(`
  Socketo server ready at ws://localhost:${port}
  App key: ${APP_KEY}

  Pusher client config:

  new Pusher('${APP_KEY}', {
    wsHost: 'localhost',
    wsPort: ${port},
    forceTLS: false,
    enabledTransports: ['ws'],
    cluster: 'local',
  })${
    appSecret
      ? `

  Auth: APP_SECRET is set`
      : ''
  }`)

  process.on('SIGINT', async () => {
    await server.close()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    await server.close()
    process.exit(0)
  })
}

async function cmdSubscribe(args: string[]) {
  const flags = parseFlags(args)

  if (flags.help) {
    console.log(`
Subscribe to a channel and watch live events in real-time.

Usage:
  socketo subscribe <channel> [options]

Options:
  -p, --port <port>        Server port (default: ${DEFAULT_PORT})
  --presence               Include presence channel_data
  --user-id <id>           User ID for presence channels (default: "user-1")
`)
    return
  }

  const channel = args.find((a) => !a.startsWith('-'))
  if (!channel) {
    console.error('Error: Channel name is required')
    console.log('Usage: socketo subscribe <channel>')
    process.exit(1)
  }

  const port = readPort(flags)
  const isPresence = flags.presence === true || channel.startsWith('presence-')
  const userId = readStringFlag(flags['user-id']) ?? 'user-1'

  const ws = new WebSocket(`ws://localhost:${port}/app/${APP_KEY}?protocol=7`)

  ws.addEventListener('open', () => {
    console.log(`  Connected to ws://localhost:${port}`)
  })

  ws.addEventListener('message', (event) => {
    const msg = parsePusherMessage(String(event.data))
    const ts = new Date().toLocaleTimeString()

    if (msg.event === 'pusher:connection_established') {
      void subscribeToChannel(
        ws,
        port,
        channel,
        isPresence,
        userId,
        msg.data,
      ).catch(() => {
        console.error(`Error: Could not subscribe to ${channel}`)
        ws.close()
        process.exit(1)
      })
      return
    }

    if (msg.event === 'pusher_internal:subscription_succeeded') {
      const presence = decodePresenceSubscription(msg.data).presence
      if (presence) {
        console.log(
          `  Presence: ${presence.count} member(s), IDs: ${presence.ids.join(', ')}`,
        )
      }
      return
    }

    if (msg.event === 'pusher:pong') {
      return
    }

    const dataStr = stringifyMessageData(msg.data)
    const userIdStr = msg.user_id ? ` [user: ${msg.user_id}]` : ''
    const chStr = msg.channel !== channel ? ` (${msg.channel})` : ''

    console.log(`  ${ts}  ${msg.event}${chStr}${userIdStr}`)
    console.log(`           ${dataStr}\n`)
  })

  ws.addEventListener('error', () => {
    console.error(`Error: Could not connect to ws://localhost:${port}`)
    console.error('Is the server running? Start it with: socketo start')
    process.exit(1)
  })

  ws.addEventListener('close', () => {
    process.exit(0)
  })

  process.on('SIGINT', () => {
    ws.close()
    process.exit(0)
  })
}

async function subscribeToChannel(
  ws: WebSocket,
  port: number,
  channel: string,
  isPresence: boolean,
  userId: string,
  connectionData: JsonValue | undefined,
): Promise<void> {
  const connection = decodeConnectionEstablished(connectionData)
  const channelData = isPresence
    ? JSON.stringify({
        user_id: userId,
        user_info: { name: userId },
      })
    : undefined
  const subscribeData: SubscribePayload = { channel }

  if (channel.startsWith('private-') || channel.startsWith('presence-')) {
    const authRequest: AuthRequest = {
      socket_id: connection.socket_id,
      channel_name: channel,
    }
    if (channelData) authRequest.channel_data = channelData
    const response = await fetch(
      `http://localhost:${port}/apps/${APP_KEY}/auth`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest),
      },
    )
    if (!response.ok) throw new Error(`Auth failed: ${response.status}`)
    const auth = decodeAuthResponse(parseJson(await response.text()))
    subscribeData.auth = auth.auth
  }

  if (channelData) subscribeData.channel_data = channelData
  ws.send(
    JSON.stringify({
      event: 'pusher:subscribe',
      data: subscribeData,
    }),
  )
  console.log(`  Subscribed to ${channel}`)
  console.log('  Waiting for events...\n')
}

async function cmdTrigger(args: string[]) {
  const flags = parseFlags(args)

  if (flags.help) {
    console.log(`
Trigger an event on a channel via the REST API.

Usage:
  socketo trigger <channel> <event> [data] [options]

Options:
  -p, --port <port>        Server port (default: ${DEFAULT_PORT})
  --socket-id <id>         Exclude this socket from broadcast
`)
    return
  }

  const positionalArgs = args.filter((a) => !a.startsWith('-'))
  const channel = positionalArgs[0]
  const eventName = positionalArgs[1]

  if (!channel || !eventName) {
    console.error('Error: Channel name and event name are required')
    console.log('Usage: socketo trigger <channel> <event> [data]')
    process.exit(1)
  }

  const port = readPort(flags)
  const socketId = readStringFlag(flags['socket-id'])

  const data = parseTriggerData(positionalArgs[2])

  const body: EventTriggerRequest = {
    name: eventName,
    channel,
    data,
  }
  if (socketId) body.socket_id = socketId

  const res = await fetch(`http://localhost:${port}/apps/${APP_KEY}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.ok) {
    console.log(`  Event '${eventName}' sent to ${channel}`)
  } else {
    const text = await res.text()
    console.error(`Error: ${res.status} ${text}`)
    process.exit(1)
  }
}

async function cmdInfo(args: string[]) {
  const flags = parseFlags(args)

  if (flags.help) {
    console.log(`
Show server status and active channels.

Usage:
  socketo info [options]

Options:
  -p, --port <port>        Server port (default: ${DEFAULT_PORT})
`)
    return
  }

  const port = readPort(flags)

  try {
    const res = await fetch(
      `http://localhost:${port}/apps/${APP_KEY}/channels?info=subscription_count`,
    )
    if (!res.ok) {
      console.error(`Error: Could not reach server at port ${port}`)
      console.error('Is the server running? Start it with: socketo start')
      process.exit(1)
    }

    const body = decodeChannelListResponse(parseJson(await res.text()))
    const channels = Object.keys(body.channels)

    console.log(`
  Server: ws://localhost:${port}
  App key: ${APP_KEY}
  Channels: ${channels.length}
`)

    if (channels.length > 0) {
      console.log('  Active Channels:')
      for (const ch of channels) {
        const info = body.channels[ch]
        const count = info?.subscription_count ?? '?'
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

function cmdGenerate() {
  console.log(`
// ── Client (pusher-js) ──

import Pusher from 'pusher-js'

const pusher = new Pusher('${APP_KEY}', {
  wsHost: 'localhost',
  wsPort: ${DEFAULT_PORT},
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
  appId: '${APP_KEY}',
  key: '${APP_KEY}',
  secret: '${APP_KEY}',
  host: 'localhost:${DEFAULT_PORT}',
  useTLS: false,
})

server.trigger('my-channel', 'my-event', { hello: 'world' })

// ── Start Server ──
// npx @socketo/cli start
`)
}

// --- Main ---

const rawArgs = process.argv.slice(2)
const command = rawArgs[0]

if (!command || command === 'help') {
  showHelp()
  process.exit(0)
}

const cmdArgs = rawArgs.slice(1)

switch (command) {
  case 'start':
    await cmdStart(cmdArgs)
    break
  case 'subscribe':
    await cmdSubscribe(cmdArgs)
    break
  case 'trigger':
    await cmdTrigger(cmdArgs)
    break
  case 'info':
    await cmdInfo(cmdArgs)
    break
  case 'generate':
    cmdGenerate()
    break
  default:
    console.error(`Error: Unknown command '${command}'`)
    showHelp()
    process.exit(1)
}
