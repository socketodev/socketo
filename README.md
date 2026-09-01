# Socketo

Pusher-compatible, serverless WebSockets for developers. Built on Cloudflare Durable Objects.

## Monorepo Overview

| Package / App | Path | Description |
|---|---|---|
| **`@socketo/server`** | [`apps/server/`](./apps/server/) | Self-hosted Cloudflare Worker server backed by `ServerDO` and `DatabaseDO` (SQLite) |
| **`@socketo/cli`** | [`packages/cli/`](./packages/cli/) | Local standalone Pusher server + CLI tool for development (`npx @socketo/cli start`) |
| **`@socketo/core`** | [`packages/core/`](./packages/core/) | Shared Pusher Channels Protocol v7 state machine and authentication core (Node.js, Bun, Cloudflare Workers) |

## Table of Contents

- [Deployment](#deployment)
- [Stack](#stack)
- [Architecture](#architecture)
- [API Endpoints](#api-endpoints)
- [Channel Types](#channel-types)
- [Usage](#usage)
- [Development](#development)
- [Known Limitations](#known-limitations)

## Deployment

Deploy `@socketo/server` directly from your local terminal to Cloudflare Workers:

### 1. Prerequisites

Install dependencies and authenticate Wrangler with your Cloudflare account:

```bash
bun install
bunx wrangler login
```

### 2. Set Production Secrets

Configure the `ADMIN_API_TOKEN` secret in Cloudflare for migration authorization:

```bash
cd apps/server && bunx wrangler secret put ADMIN_API_TOKEN
```

### 3. Deploy to Cloudflare

Build and deploy the Worker:

```bash
bun run --filter=@socketo/server deploy
```

### 4. Initialize Production Database

Run the database migrations against your deployed Worker:

```bash
curl -X POST \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
  https://<your-worker-domain>/migrate
```

Confirm the endpoint returns `{ "success": true, "result": {} }`. Run this migration again whenever a deployment includes new database migrations.

### 5. Add App Record

1. Go to [Durable Objects in Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/workers/durable-objects) and select `DatabaseDO`.
2. Open **Data Studio** > Choose `By Name` method > Enter `default` in the input.
3. Select the `apps` table > **Add Row**.

Fill in the row with your key/secret pair:

| Column | Value | Description |
|---|---|---|
| `id` | Your app ID | Unique application identifier |
| `key` | Your app key | Public API key |
| `secret` | Your app secret | Private HMAC secret |
| `max_connections` | `10000` | Max concurrent WebSocket connections (`-1` for unlimited) |
| `enable_client_events` | `1` | Enable client-to-client events (`1` = enabled, `0` = disabled) |
| `location_hint` | Optional | Initial DO data center placement (full list: [Supported locations](https://developers.cloudflare.com/durable-objects/reference/data-location/#supported-locations-1)) |

> **Note:** `location_hint` controls the initial geographic placement of the `ServerDO` Durable Object instance. If omitted, Cloudflare automatically selects the optimal data center based on the origin of the initial `get()` request.

## Stack

- **Runtime:** Cloudflare Workers (Hibernatable WebSockets)
- **State:** Durable Objects with SQLite storage
- **Framework:** Hono + Kysely ORM
- **Protocol:** Pusher Channels Protocol v7 (public, private, and presence channels)

## Architecture

Two Durable Objects power the server:

| DO | Purpose |
|---|---|
| `ServerDO` | WebSocket lifecycle, channel subscriptions, message broadcasting |
| `DatabaseDO` | App registration and auth (key/secret pairs, persisted in SQLite) |

Each app is identified by a unique key/secret pair. The server verifies HMAC-signed requests for server-to-client broadcasts.

## API Endpoints

All endpoints under `/apps/:key/*` require Pusher REST API authentication (HMAC-SHA256 signature). When using official Pusher server SDKs, authentication is handled automatically.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| `POST` | `/migrate` | `Bearer <ADMIN_API_TOKEN>` | Apply `DatabaseDO` schema migrations |
| `GET` | `/app/:key` | None | WebSocket upgrade (requires `Upgrade: websocket` and `?protocol=7`) |
| `GET` | `/apps/:key/sockets` | Pusher REST Auth | Active socket count |
| `GET` | `/apps/:key/channels` | Pusher REST Auth | Occupied channel list with optional `info` attributes and `filter_by_prefix` (e.g. `?filter_by_prefix=presence-&info=user_count`) |
| `GET` | `/apps/:key/channels/:channel_name` | Pusher REST Auth | Single channel info (`occupied`, with optional `user_count` or `subscription_count`) |
| `GET` | `/apps/:key/channels/:channel_name/users` | Pusher REST Auth | List of user IDs subscribed to a presence channel |
| `POST` | `/apps/:key/events` | Pusher REST Auth | Trigger a single event |
| `POST` | `/apps/:key/batch_events` | Pusher REST Auth | Trigger multiple events |
| `POST` | `/apps/:key/users/:user_id/terminate_connections` | Pusher REST Auth | Terminate all connections for a specific user |

### REST API Authentication

Requests to `/apps/:key/*` must include Pusher Channels REST authentication parameters in the query string:

- `auth_key`: Your app key
- `auth_timestamp`: Current Unix timestamp in seconds (must be within ±600 seconds of server time)
- `auth_version`: `1.0`
- `body_md5`: MD5 hex digest of the request body (required for `POST`, `PUT`, `PATCH`)
- `auth_signature`: HMAC-SHA256 signature of `"<METHOD>\n<PATH>\n<SORTED_QUERY_STRING>"` signed with your app secret

## Channel Types

| Type | Prefix | Auth Required | Description |
|---|---|---|---|
| Public | _(none)_ | No | Anyone can subscribe |
| Private | `private-` | Yes (HMAC signature) | Server-authorised subscriptions |
| Presence | `presence-` | Yes (HMAC signature) | Private channels with user identity and member events |

### Private Channels

Subscribe with an `auth` signature generated server-side using your app secret:

```
pusher:subscribe → { "channel": "private-orders", "auth": "<APP_KEY>:<signature>" }
```

### Presence Channels

Subscribe with an `auth` signature and `channel_data` containing user identity:

```
pusher:subscribe → {
  "channel": "presence-chat",
  "auth": "<APP_KEY>:<signature>",
  "channel_data": "{\"user_id\":\"123\",\"user_info\":{\"name\":\"Alice\"}}"
}
```

Member lifecycle events are broadcast automatically:

- `pusher_internal:subscription_succeeded` — presence data (`ids`, `hash`, `count`)
- `pusher_internal:member_added` — new member joined
- `pusher_internal:member_removed` — member left

> **Note on Authorization Endpoints:** Socketo acts solely as the realtime WebSocket server and does not host client authorization endpoints (`/pusher/auth` or `/pusher/user-auth`). Your application backend (which holds your `APP_SECRET` and user session) must implement the authorization endpoint or custom handler using the Pusher server SDK (e.g. `pusher.authorizeChannel(...)` for channel authorization or `pusher.authenticateUser(...)` for user authentication).

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
  // Required for private/presence channels (hosted on your backend):
  channelAuthorization: {
    endpoint: "/api/pusher/auth",
    headers: {
      Authorization: "Bearer <USER_SESSION_TOKEN>",
    },
  },
  // Optional: required if using pusher.signin() for user authentication:
  userAuthentication: {
    endpoint: "/api/pusher/user-auth",
  },
});

// Public channel
const publicChannel = pusher.subscribe("my-channel").bind("my-event", (message) => {
  console.log(message);
});

// Private channel (triggers channelAuthorization request to your backend)
const privateChannel = pusher.subscribe("private-chat");

// Presence channel (triggers channelAuthorization request to your backend)
const presenceChannel = pusher.subscribe("presence-chat");
```

### Client events

Client events allow clients to broadcast directly to other subscribers without going through your backend. They are only allowed on **private** or **presence** channels, event names must be prefixed with `client-`, and `enable_client_events` must be set to `1` in your app configuration. Triggering must occur after subscription succeeds:

```js
// Trigger a client event once subscription is established
privateChannel.bind("pusher:subscription_succeeded", () => {
  privateChannel.trigger("client-typing", { user: "Alice", typing: true });
});

// Listen for client events from other subscribers
privateChannel.bind("client-typing", (data) => {
  console.log(data);
});
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

1. Configure local environment variables:
   ```bash
   cp apps/server/.dev.vars.example apps/server/.dev.vars
   ```
   Set `ADMIN_API_TOKEN` in `apps/server/.dev.vars` for local migration authorization.

2. Start the server locally:
   ```bash
   bun run dev                          # starts local development server
   bun run --filter=@socketo/server dev # server only
   ```

3. Run database migrations:
   ```bash
   curl -X POST \
     -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
     http://localhost:8787/migrate
   ```

4. Add your app record via [Local Explorer](https://developers.cloudflare.com/workers/development-testing/local-explorer/):
   - Go to [http://localhost:8787/cdn-cgi/explorer](http://localhost:8787/cdn-cgi/explorer/do/DatabaseDO/default?table=apps)
   - Click **Add Row**
   - Fill and save.

Deploy to Cloudflare Workers:

```bash
bun run --filter=@socketo/server deploy
```

After deployment, configure `ADMIN_API_TOKEN` and run the production migration steps in [Deployment](#deployment) before accessing `DatabaseDO` through Data Studio.

## Releases

Add a changeset for each releasable change:

```bash
bun run changeset
```

The release workflow creates a version pull request and, after it is merged, creates Git tags without GitHub Releases. `@socketo/server` is versioned and tagged as a private package but is never published to npm. `@socketo/cli` is versioned, tagged, and published to npm. `@socketo/core` is not independently versioned; include the affected server or CLI package in a changeset when a core change requires a release.

## Known Limitations

- **In-memory config caching:** `ServerDO` loads and caches the app config (key/secret, `enable_client_events`, `max_connections`, etc.) in memory during constructor initialization via `blockConcurrencyWhile`. If you update an app's configuration via Data Studio / Local Explorer while the `ServerDO` instance is still active (i.e., hasn't been evicted or hibernated), the running instance will continue using the **old cached values** until it restarts. To force a refresh, you must trigger a `ServerDO` restart (e.g., by deploying a new version or causing the Durable Object to hibernate and wake up).

- **Unconstrained event size:** Server-side event payloads are not capped to 10 KB by default in the self-hosted edition, allowing larger custom payloads. Large WebSocket messages may still hit Cloudflare platform frame limits.

- **Channel Scope:** Only standard **public**, **private** (`private-*`), and **presence** (`presence-*`) channels are supported. Pusher Cache Channels (`cache-*`, `private-cache-*`, `presence-cache-*`) and End-to-End Encrypted Channels (`private-encrypted-*`) are not supported; subscription attempts are rejected with error code `4300`.

- **Outbound Webhooks:** Outbound event webhook dispatching is not supported in the self-hosted edition.

- **User Watchlist:** Pusher user watchlist events (`pusher:watchlist`) for tracking online/offline status outside of presence channels are not supported.
