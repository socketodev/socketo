# Socketo

Pusher-compatible realtime WebSocket server, built on Cloudflare Durable Objects.

## Monorepo Overview

| Package / App | Path | Description |
|---|---|---|
| **`@socketo/server`** | [`apps/server/`](./apps/server/) | Self-hosted Cloudflare Worker server backed by `ServerDO` and `DatabaseDO` (SQLite) |
| **`@socketo/cli`** | [`packages/cli/`](./packages/cli/) | Local standalone Pusher server + CLI tool for development (`npx @socketo/cli start`) |
| **`@socketo/core`** | [`packages/core/`](./packages/core/) | Shared, runtime-agnostic Pusher Channels Protocol v7 state machine and authentication core |

## Table of Contents

- [Deploy](#deploy)
- [Stack](#stack)
- [Architecture](#architecture)
- [API Endpoints](#api-endpoints)
- [Channel Types](#channel-types)
- [Usage](#usage)
- [Development](#development)
- [Known Limitations](#known-limitations)

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/socketodev/socketo/tree/main/apps/server)

Click the button above to deploy to Cloudflare Workers. After deployment, create an app record manually:

1. Go to **Cloudflare Dashboard**
2. Navigate to **Compute** > **Durable Objects** > `DatabaseDO`
3. Open **Data Studio** > Choose `By Name` method > Enter `default` in the input
4. Select the `apps` table > **Add Row**

Fill in the row with your own key/secret pair:

| Column | Value |
|---|---|
| `id` | Your app id |
| `key` | Your app key |
| `secret` | Your app secret |
| `max_connections` | Recommended `10000` (or `-1` for unlimited) |
| `enable_client_events` | `1` (must be integer) |
| `location_hint` | Optional (full list: [Supported locations](https://developers.cloudflare.com/durable-objects/reference/data-location/#supported-locations-1)) |

> **Note:** `location_hint` controls the initial geographic placement of the `ServerDO` Durable Object instance. If omitted, Cloudflare automatically selects the optimal data center based on the origin of the initial `get()` request.

## Stack

- **Runtime:** Cloudflare Workers (Hibernatable WebSockets)
- **State:** Durable Objects with SQLite storage
- **Framework:** Hono + Kysely ORM
- **Protocol:** Pusher Channels Protocol (compatible with all official Pusher SDKs)

## Architecture

Two Durable Objects power the server:

| DO | Purpose |
|---|---|
| `ServerDO` | WebSocket lifecycle, channel subscriptions, message broadcasting |
| `DatabaseDO` | App registration and auth (key/secret pairs, persisted in SQLite) |

Each app is identified by a unique key/secret pair. The server verifies HMAC-signed requests for server-to-client broadcasts.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/app/:key` | WebSocket upgrade. Requires `Upgrade: websocket` header and `?protocol=7` query param |
| `GET` | `/apps/:key/sockets` | Active socket count |
| `GET` | `/apps/:key/channels` | Occupied channel list with optional `info` attributes and `filter_by_prefix` (e.g. `?filter_by_prefix=presence-&info=user_count`) |
| `GET` | `/apps/:key/channels/:channel_name` | Single channel info (`occupied`, with optional `user_count` or `subscription_count`) |
| `GET` | `/apps/:key/channels/:channel_name/users` | List of user IDs subscribed to a presence channel |
| `POST` | `/apps/:key/events` | Trigger a single event |
| `POST` | `/apps/:key/batch_events` | Trigger multiple events |
| `POST` | `/apps/:key/users/:user_id/terminate_connections` | Terminate all connections for a specific user |

## Channel Types

| Type | Prefix | Auth Required | Description |
|---|---|---|---|
| Public | _(none)_ | No | Anyone can subscribe |
| Private | `private-` | Yes (HMAC signature) | Server-authorised subscriptions |
| Presence | `presence-` | Yes (HMAC + signin) | Private channels with user identity and member events |

### Private Channels

Subscribe with an `auth` signature generated server-side using your app secret:

```
pusher:subscribe → { "channel": "private-orders", "auth": "<APP_KEY>:<signature>" }
```

### Presence Channels

Requires user signin first, then subscribe with `auth` and `channel_data`:

```js
// 1. Sign in
pusher.signin({ auth: "<signature>", user_data: JSON.stringify({ id: "123", user_info: { name: "Alice" } }) })

// 2. Subscribe
pusher.subscribe("presence-chat")
```

Member lifecycle events are broadcast automatically:

- `pusher_internal:subscription_succeeded` — presence data (`ids`, `hash`, `count`)
- `pusher_internal:member_added` — new member joined
- `pusher_internal:member_removed` — member left

## Usage

### Client (Pusher JS SDK)

```javascript
import Pusher from "pusher-js"

const pusher = new Pusher("APP_KEY", {
  wsHost: "your-worker.workers.dev",
  wssPort: 443,
  forceTLS: true,
  enabledTransports: ["ws"],
  cluster: "socketo",
});

const channel = pusher.subscribe("my-channel").bind("my-event", (message) => {
  console.log(message);
})
```

### Client events

```js
channel.trigger("client-my-event", { message: "Hello from client" });
```

### Server-to-client broadcast

Trigger events from your backend via Pusher:

```javascript
import Pusher from "pusher"

const pusher = new Pusher({
  appId: "APP_ID",
  key: "APP_KEY",
  secret: "APP_SECRET",
  host: "your-worker.workers.dev",
  useTLS: true,
});

// Trigger an event named 'my-event' on a channel called 'my-channel'
await pusher.trigger("my-channel", "my-event", {
  message: "Hello from server",
});
```

## Development

```bash
bun install
```

### Setup

1. Start the server locally:
   ```bash
   bun run dev                          # all apps
   bun run --filter=@socketo/server dev # server only
   ```

2. Run database migrations:
   ```bash
   curl -X POST \
     -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
     http://localhost:8787/migrate
   ```

   For local development, create `apps/server/.dev.vars` from `apps/server/.dev.vars.example` and set `ADMIN_API_TOKEN`. For a deployed Worker, configure it with `wrangler secret put ADMIN_API_TOKEN`.

3. Add your app record via [Local Explorer](https://developers.cloudflare.com/workers/development-testing/local-explorer/):
   - Go to [http://localhost:8787/cdn-cgi/explorer](http://localhost:8787/cdn-cgi/explorer/do/DatabaseDO/default?table=apps)
   - Click **Add Row**
   - Fill and save.

Deploy to Cloudflare Workers:

```bash
bun run --filter=@socketo/server deploy
```

## Releases

Add a changeset for each releasable change:

```bash
bun run changeset
```

The release workflow creates a version pull request and, after it is merged, creates Git tags without GitHub Releases. `@socketo/server` is versioned and tagged as a private package but is never published to npm. `@socketo/cli` is versioned, tagged, and published to npm. `@socketo/core` is not independently versioned; include the affected server or CLI package in a changeset when a core change requires a release.

## Known Limitations

- **In-memory config caching:** `AppHandler` caches the app config (key/secret, `enable_client_events`, `max_connections`, etc.) in memory after the first database read. If you update an app's configuration via Data Studio / Local Explorer while the `ServerDO` instance is still active (i.e., hasn't been evicted or hibernated), the running instance will continue using the **old cached values** until it restarts. To force a refresh, you must trigger a `ServerDO` restart (e.g., by deploying a new version or causing the Durable Object to hibernate and wake up).

- **Unconstrained event size:** Server-side event payloads are not capped to 10 KB by default in the self-hosted edition, allowing larger custom payloads. Large WebSocket messages may still hit Cloudflare platform frame limits.
