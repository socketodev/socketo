import readline from 'node:readline'
import type { JsonValue } from '@socketo/core'
import type { SocketoServer } from './worker.js'

const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
// Primary brand color: oklch(60% .118 184.704) -> rgb(0, 150, 137)
const PRIMARY = '\x1b[38;2;0;150;137m'
const PRIMARY_BOLD = '\x1b[1;38;2;0;150;137m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

export interface CommandDef {
  name: string
  aliases: string[]
  usage: string
  description: string
}

export const COMMANDS: CommandDef[] = [
  {
    name: '/trigger',
    aliases: ['/t', '/event'],
    usage: '/trigger <channel> <event> [data]',
    description: 'Trigger an event to a channel (JSON or raw string)',
  },
  {
    name: '/channels',
    aliases: ['/c', '/list'],
    usage: '/channels',
    description: 'List all active channels with subscriber counts',
  },
  {
    name: '/presence',
    aliases: ['/p'],
    usage: '/presence <channel>',
    description: 'Show active users in a presence channel',
  },
  {
    name: '/sockets',
    aliases: ['/s'],
    usage: '/sockets',
    description: 'Show active WebSocket connections and their channels',
  },
  {
    name: '/terminate',
    aliases: ['/kick'],
    usage: '/terminate <user_id>',
    description: 'Terminate all connections for a user',
  },
  {
    name: '/verbose',
    aliases: ['/v'],
    usage: '/verbose',
    description: 'Toggle live verbose payload logging on / off',
  },
  {
    name: '/clear',
    aliases: ['/cls'],
    usage: '/clear',
    description: 'Clear the terminal screen',
  },
  {
    name: '/help',
    aliases: ['/h', '/?'],
    usage: '/help',
    description: 'Show available interactive commands',
  },
  {
    name: '/quit',
    aliases: ['/q'],
    usage: '/quit',
    description: 'Stop server and exit',
  },
]

function printHelp() {
  console.log(`
${PRIMARY_BOLD}Interactive Commands (Type / to filter, Tab to complete):${RESET}`)
  for (const cmd of COMMANDS) {
    const aliasStr =
      cmd.aliases.length > 0 ? `${DIM}(${cmd.aliases.join(', ')})${RESET}` : ''
    console.log(`  ${PRIMARY}${cmd.usage.padEnd(36)}${RESET} ${aliasStr}`)
    console.log(`    ${DIM}${cmd.description}${RESET}`)
  }
  console.log('')
}

function parseData(raw: string | undefined): JsonValue {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return raw
  }
}

async function handleTrigger(server: SocketoServer, args: string[]) {
  const channel = args[0]
  const eventName = args[1]
  const rawData = args.slice(2).join(' ')

  if (!channel || !eventName) {
    console.log(`${RED}Usage: /trigger <channel> <event> [json_data]${RESET}`)
    console.log(
      `${DIM}Example: /trigger my-channel my-event {"hello": "world"}${RESET}`,
    )
    return
  }

  const data = parseData(rawData)
  try {
    const recipients = await server.broadcast(channel, eventName, data)
    console.log(
      `${GREEN}✔ Event '${eventName}' sent to '${channel}' (${recipients} recipient(s))${RESET}`,
    )
  } catch (err) {
    console.log(`${RED}Failed to trigger event: ${err}${RESET}`)
  }
}

function handleChannels(server: SocketoServer) {
  const channels = server.getChannelsInfo()
  if (channels.size === 0) {
    console.log(`${DIM}No active channels.${RESET}`)
    return
  }

  console.log(`${PRIMARY_BOLD}Active Channels (${channels.size}):${RESET}`)
  for (const [name, info] of channels) {
    if (name.startsWith('presence-')) {
      console.log(`  👥 ${name} (${info.user_count} member(s))`)
    } else if (name.startsWith('private-')) {
      console.log(`  🔒 ${name} (${info.subscription_count} subscriber(s))`)
    } else {
      console.log(`  📡 ${name} (${info.subscription_count} subscriber(s))`)
    }
  }
}

function handlePresence(server: SocketoServer, channel: string | undefined) {
  if (!channel) {
    console.log(`${RED}Usage: /presence <channel_name>${RESET}`)
    return
  }
  if (!channel.startsWith('presence-')) {
    console.log(
      `${RED}'${channel}' is not a presence channel (must start with presence-)${RESET}`,
    )
    return
  }

  const users = server.getPresenceUsers(channel)
  if (!users || users.length === 0) {
    console.log(`${DIM}No active members in '${channel}'.${RESET}`)
    return
  }

  console.log(
    `${PRIMARY_BOLD}Presence Members for '${channel}' (${users.length}):${RESET}`,
  )
  for (const u of users) {
    console.log(`  👤 ${u.id}`)
  }
}

function handleSockets(server: SocketoServer) {
  const sockets = server.getSocketsInfo()
  if (sockets.length === 0) {
    console.log(`${DIM}No active sockets.${RESET}`)
    return
  }

  console.log(`${PRIMARY_BOLD}Active Sockets (${sockets.length}):${RESET}`)
  for (const s of sockets) {
    const userStr = s.userId ? ` [user: ${s.userId}]` : ''
    const chList = s.channels.length > 0 ? s.channels.join(', ') : 'none'
    console.log(`  🔌 ${s.id}${userStr} (Channels: ${chList})`)
  }
}

async function handleTerminate(
  server: SocketoServer,
  userId: string | undefined,
) {
  if (!userId) {
    console.log(`${RED}Usage: /terminate <user_id>${RESET}`)
    return
  }

  try {
    await server.terminateUser(userId)
    console.log(
      `${GREEN}✔ Terminated all connections for user '${userId}'${RESET}`,
    )
  } catch (err) {
    console.log(`${RED}Failed to terminate user: ${err}${RESET}`)
  }
}

function completer(line: string): [string[], string] {
  const trimmed = line.trim()
  const canonicalNames = COMMANDS.map((c) => c.name)

  if (!trimmed.startsWith('/')) {
    const rawMatches = canonicalNames
      .map((name) => name.slice(1))
      .filter((name) => name.startsWith(trimmed))
    return [rawMatches.map((m) => `/${m}`), trimmed]
  }

  const hits = canonicalNames.filter((name) => name.startsWith(trimmed))
  return [hits.length ? hits : canonicalNames, trimmed]
}

export function startInteractiveRepl(
  server: SocketoServer,
): readline.Interface {
  let isExecutingCommand = false

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${PRIMARY_BOLD}socketo > ${RESET}`,
    completer,
  })

  const clearGhost = () => {
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[s\x1b[K\x1b[u')
    }
  }

  const renderGhost = () => {
    if (!process.stdout.isTTY) return
    const currentLine = (rl as unknown as { line?: string }).line
    if (!currentLine) {
      clearGhost()
      return
    }

    const trimmed = currentLine.trim()
    if (trimmed.startsWith('/')) {
      const match = COMMANDS.find((c) => c.name.startsWith(trimmed))

      if (match?.name.startsWith(trimmed)) {
        const suffix = match.name.slice(trimmed.length)
        if (suffix.length > 0) {
          // Draw ghost suggestion in dim primary color and restore cursor
          process.stdout.write(
            `\x1b[s\x1b[K${DIM}${PRIMARY}${suffix}${RESET}\x1b[u`,
          )
          return
        }
      }
    }
    clearGhost()
  }

  const writeAbovePrompt = (
    writer: (...args: unknown[]) => void,
    ...args: unknown[]
  ) => {
    const isClosed = (rl as unknown as { closed?: boolean }).closed
    if (process.stdout.isTTY && !isExecutingCommand && !isClosed) {
      const prevRows = (rl as unknown as { prevRows?: number }).prevRows || 0
      if (prevRows > 0) {
        readline.moveCursor(process.stdout, 0, -prevRows)
      }
      readline.cursorTo(process.stdout, 0)
      readline.clearScreenDown(process.stdout)
      writer(...args)
      rl.prompt(true)
      renderGhost()
    } else {
      writer(...args)
    }
  }

  const origLog = console.log
  const origWarn = console.warn
  const origError = console.error

  console.log = (...args: unknown[]) => writeAbovePrompt(origLog, ...args)
  console.warn = (...args: unknown[]) => writeAbovePrompt(origWarn, ...args)
  console.error = (...args: unknown[]) => writeAbovePrompt(origError, ...args)

  const restoreConsole = () => {
    console.log = origLog
    console.warn = origWarn
    console.error = origError
  }

  server.setLogger((...args: unknown[]) => writeAbovePrompt(origLog, ...args))

  rl.prompt()

  // Listen to keypress to display clean inline ghost text suggestion
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin)

    process.stdin.on('keypress', (_str, key) => {
      if (key && (key.name === 'return' || key.name === 'enter')) {
        clearGhost()
        return
      }

      setImmediate(() => {
        renderGhost()
      })
    })
  }

  rl.on('line', async (line) => {
    isExecutingCommand = true
    try {
      // If in interactive TTY, cleanly erase any ghost text on the line above
      if (process.stdout.isTTY) {
        const col = 10 + line.length + 1
        process.stdout.write(`\x1b[1A\x1b[${col}G\x1b[K\x1b[1B\r`)
      }

      const trimmed = line.trim()
      if (!trimmed) {
        return
      }

      const parts = trimmed.startsWith('/')
        ? trimmed.slice(1).split(/\s+/)
        : trimmed.split(/\s+/)
      const cmd = parts[0]?.toLowerCase()
      const args = parts.slice(1)

      switch (cmd) {
        case 'help':
        case 'h':
        case '?':
          printHelp()
          break
        case 'trigger':
        case 't':
        case 'event':
          await handleTrigger(server, args)
          break
        case 'channels':
        case 'c':
        case 'list':
          handleChannels(server)
          break
        case 'presence':
        case 'p':
          handlePresence(server, args[0])
          break
        case 'sockets':
        case 's':
          handleSockets(server)
          break
        case 'terminate':
        case 'kick':
          await handleTerminate(server, args[0])
          break
        case 'verbose':
        case 'v': {
          const isV = server.toggleVerbose()
          console.log(
            `${PRIMARY}ℹ Verbose payload logging is now ${isV ? `${GREEN}enabled${RESET}` : `${YELLOW}disabled${RESET}`}${RESET}`,
          )
          break
        }
        case 'clear':
        case 'cls':
          console.clear()
          server.printBanner()
          break
        case 'quit':
        case 'q':
        case 'exit':
          console.log(`${DIM}Shutting down server...${RESET}`)
          restoreConsole()
          await server.close()
          process.exit(0)
          break
        default:
          console.log(
            `${RED}Unknown command '${trimmed}'. Type /help for available commands.${RESET}`,
          )
          break
      }
    } finally {
      isExecutingCommand = false
      rl.prompt()
    }
  })

  rl.on('close', async () => {
    restoreConsole()
    await server.close()
    process.exit(0)
  })

  return rl
}
