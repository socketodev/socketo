# Socketo

Pusher-compatible realtime WebSocket server, built on Cloudflare Durable Objects.

All server code lives in [`apps/server/`](./apps/server/).

## Table of Contents

- [Deploy](#deploy)
- [Stack](#stack)
- [Architecture](#architecture)
- [API Endpoints](#api-endpoints)
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

**NOTE**: A Dashboard could be built in the future to improve this experience and track live statistics!

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
| `GET` | `/:key/sockets` | Active socket count |
| `GET` | `/:key/channels` | Channel subscription counts |
| `POST` | `/:key/events` | Trigger a single event |
| `POST` | `/:key/batch_events` | Trigger multiple events |

## Usage

### Client (Pusher JS SDK)

```javascript
import Pusher from "pusher-js"

const pusher = new Pusher("APP_KEY", {
  wsHost: "your-worker.workers.dev",
  wssPort: 443,
  forceTLS: true,
  disableStats: true,
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
   bun run dev                        # all apps
   bun run --filter=@apps/server dev  # server only
   ```

2. Run database migrations:
   ```bash
   curl -X POST http://localhost:8787/migrate
   ```

3. Add your app record via [Local Explorer](https://developers.cloudflare.com/workers/development-testing/local-explorer/):
   - Go to [http://localhost:8787/cdn-cgi/explorer](http://localhost:8787/cdn-cgi/explorer/do/DatabaseDO/default?table=apps)
   - Click **Add Row**
   - Fill and save.

Deploy manually:

```bash
bun run --filter=@apps/server deploy
```

## Known Limitations

- **In-memory config caching:** `AppHandler` caches the app config (key/secret, `enable_client_events`, `max_connections`, etc.) in memory after the first database read. If you update an app's configuration via Data Studio / Local Explorer while the `ServerDO` instance is still active (i.e., hasn't been evicted or hibernated), the running instance will continue using the **old cached values** until it restarts. To force a refresh, you must trigger a `ServerDO` restart (e.g., by deploying a new version or causing the Durable Object to hibernate and wake up).
