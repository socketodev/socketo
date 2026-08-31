# @socketo/cli

Local Pusher-compatible WebSocket server. Drop-in replacement for Pusher Channels during development — same protocol, zero config, no API key needed.

Built on [Node.js](https://nodejs.org/) and [ws](https://github.com/websockets/ws) for native HTTP + WebSocket support with persistent in-memory state.

```bash
npx @socketo/cli start
```

Server listens at `ws://localhost:8787`.

## Usage

```
npx @socketo/cli <command> [options]

Commands:
  start [options]              Start the local Pusher-compatible server
  subscribe <channel>          Subscribe to a channel and watch live events
  trigger <ch> <event> [data]  Trigger an event on a channel
  info                         Show server status and active channels
  generate                     Generate client/server code with prefilled keys
  help                         Show this help message

Start Options:
  -p, --port <port>            Port (default: 8787)
  --app-secret <secret>        Secret for auth signature validation
```

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

### `socketo generate`

Generate client/server boilerplate code with prefilled keys:

```bash
socketo generate
```

## Supported

**WebSocket Protocol**
- `pusher:connection_established` handshake (with `socket_id` and `activity_timeout: 120`)
- Subscribe / unsubscribe (public, private, presence)
- Client events (`client-*`)
- Ping / pong
- User signin (`pusher:signin` / `pusher:signin_success`)
- Auth signature validation (when `--app-secret` is set)

**Presence Channels**
- `channel_data` with `user_id` and `user_info`
- `pusher_internal:subscription_succeeded` with member list (`ids`, `hash`, `count`)
- `member_added` / `member_removed` events (with `user_id` in client events)

**REST API**

| Method | Path | Description |
|---|---|---|
| `GET` | `/apps/local/sockets` | Active socket count |
| `POST` | `/apps/local/events` | Trigger events (single or multi-channel) |
| `POST` | `/apps/local/batch_events` | Batch trigger (max 10 events) |
| `POST` | `/apps/local/auth` | Auth endpoint for private/presence channels |
| `GET` | `/apps/local/channels` | List channels |
| `GET` | `/apps/local/channels/{name}` | Channel info |
| `GET` | `/apps/local/channels/{name}/users` | Presence users |
| `POST` | `/apps/local/users/{id}/terminate_connections` | Disconnect user |

Query params: `?filter_by_prefix=` and `?info=user_count,subscription_count`.

**State**

Connection state survives indefinitely (no hibernation). Channels, members, and user data persist across requests.

**CORS**

All HTTP endpoints return `Access-Control-Allow-Origin: *`.

## Not Supported

- Cache channels (`cache-*`, `private-cache-*`)
- TLS / WSS termination (local plain HTTP/WS development only)
- Watchlist events
- Server-initiated ping (client-initiated ping/pong is supported)
