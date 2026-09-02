# @socketo/cli

Local Pusher-compatible WebSocket server. Drop-in replacement for Pusher Channels during development — same protocol, zero config, no API key needed.

Built on [Node.js](https://nodejs.org/) and [ws](https://github.com/websockets/ws) for native HTTP + WebSocket support with persistent in-memory state.

```bash
npx @socketo/cli
# or
npx @socketo/cli start -v -p 8787 -H 0.0.0.0
```

Server listens at `ws://localhost:8787` (zero config).

## Usage

```
npx @socketo/cli [command] [options]

Commands:
  start [options]              Start the server (default when no command given)
  subscribe <channel>          Subscribe to a channel and watch live events
  trigger <ch> <event> [data]  Trigger an event on a channel via REST
  info                         Show server status and active channels
  sockets                      Show active WebSocket connections count
  presence <channel>           Show active users in a presence channel
  terminate <user_id>          Terminate all connections for a user
  generate                     Generate client/server code with prefilled keys
  help                         Show this help message

Options:
  -p, --port <port>            Port (default: 8787)
  -H, --host <host>            Host address to bind (default: localhost)
  -i, --app-id <id>            Pusher App ID (default: matches app-key)
  -k, --app-key <key>          Pusher App Key (default: local)
  -s, --app-secret <secret>    Pusher App Secret for auth validation
  -v, --verbose                Log detailed event payloads and socket activity
  --disable-client-events      Disable client-triggered events (client-*)
  --socket-id <id>             Exclude socket from broadcast (trigger)
  --user-id <id>               User ID for presence channels (subscribe)
  --presence                   Include presence data (subscribe)
  -h, --help                   Show this help message
```

### Environment Variables

You can also configure default credentials via environment variables:

| Variable | Description | Default |
|---|---|---|
| `SOCKETO_APP_ID` | Pusher App ID | Matches `SOCKETO_APP_KEY` |
| `SOCKETO_APP_KEY` | Pusher App Key | `local` |
| `SOCKETO_APP_SECRET` | Pusher App Secret | Matches `SOCKETO_APP_KEY` |

### Client SDK

```ts
import PusherJS from 'pusher-js'

const pusher = new Pusher('local', {
  wsHost: 'localhost',
  wsPort: 8787,
  forceTLS: false,
  enabledTransports: ['ws'],
  cluster: 'local',
})
```

### Server SDK

```ts
import Pusher from 'pusher'

const server = new Pusher({
  appId: 'local',
  key: 'local',
  secret: 'local',
  host: 'localhost:8787',
  useTLS: false,
})

server.trigger('my-channel', 'my-event', { hello: 'world' })
```

## Interactive Console (Live REPL)

When the server is running in an interactive terminal, you can type slash commands directly into the server window without needing a second terminal or `curl`:

```
socketo > /help

Interactive Commands (Type / to filter, Tab to complete):
  /trigger <channel> <event> [data]  (alias: /t, /event)
    Trigger an event to a channel (JSON or raw string)

  /channels                          (alias: /c, /list)
    List all active channels with subscriber counts

  /presence <channel>                (alias: /p)
    Show active users in a presence channel

  /sockets                           (alias: /s)
    Show active WebSocket connections and their channels

  /terminate <user_id>               (alias: /kick)
    Terminate all connections for a user

  /info                              (alias: /status, /i)
    Show server status, active connections, and uptime

  /verbose                           (alias: /v)
    Toggle live verbose payload logging on / off

  /clear                             (alias: /cls)
    Clear the terminal screen

  /help                              (alias: /h, /?)
    Show available interactive commands

  /quit                              (alias: /q)
    Stop server and exit
```

## CLI Commands

### `socketo subscribe <channel>`

Subscribe to a channel and watch events in real-time:

```bash
socketo subscribe my-channel
socketo subscribe presence-chat --user-id alice
```

### `socketo trigger <channel> <event> [data]`

Trigger events from the terminal:

```bash
socketo trigger my-channel my-event '{"hello":"world"}'
```

### `socketo info`

Show server status and active channels:

```bash
socketo info
```

### `socketo sockets`

Show active WebSocket connection count:

```bash
socketo sockets
```

### `socketo presence <channel>`

Show active members in a presence channel:

```bash
socketo presence presence-chat
```

### `socketo terminate <user_id>`

Terminate all active connections for a user:

```bash
socketo terminate user-1
```

### `socketo generate`

Generate client/server boilerplate code with prefilled keys:

```bash
socketo generate
```

## Supported

**Channels**
- Public channels (`<name>`)
- Private channels (`private-<name>`) with HMAC SHA-256 signature verification
- Presence channels (`presence-<name>`) with `user_id` and `user_info` lifecycle

**WebSocket Protocol**
- `pusher:connection_established` handshake (with `socket_id` and `activity_timeout: 120`)
- Subscribe / unsubscribe (public, private, presence)
- Client events (`client-*`)
- Ping / pong with activity timeout
- User signin (`pusher:signin` / `pusher:signin_success`)
- Auth signature validation (when `--app-secret` is set)

**Presence Channels**
- `channel_data` with `user_id` and `user_info`
- `pusher_internal:subscription_succeeded` with member list (`ids`, `hash`, `count`)
- `member_added` / `member_removed` events (with `user_id` in client events)

**REST API**

| Method | Path | Description |
|---|---|---|
| `GET` | `/apps/:id/sockets` | Active socket count |
| `POST` | `/apps/:id/events` | Trigger events (single or multi-channel) |
| `POST` | `/apps/:id/batch_events` | Batch trigger (max 10 events) |
| `POST` | `/apps/:id/auth` | Auth endpoint for private/presence channels |
| `GET` | `/apps/:id/channels` | List channels |
| `GET` | `/apps/:id/channels/:name` | Channel info |
| `GET` | `/apps/:id/channels/:name/users` | Presence users |
| `POST` | `/apps/:id/users/:user_id/terminate_connections` | Disconnect user |
| `POST` | `/apps/:id/users/:user_id/events` | Send event directly to authenticated user |

Query params: `?filter_by_prefix=` and `?info=user_count,subscription_count`.

**State**

Connection state survives indefinitely in-memory. Channels, members, and user data persist across requests.

**CORS**

All HTTP endpoints return `Access-Control-Allow-Origin: *`.

## Not Supported

- Outbound webhooks
- Encrypted channels (`private-encrypted-*`)
- Cache channels (`cache-*`, `private-cache-*`, `presence-cache-*`)
- Watchlist events
- TLS / WSS termination (local plain HTTP/WS development only)
