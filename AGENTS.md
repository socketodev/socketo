# Agent Instructions

## Repository

- This is a Bun/Turborepo workspace with the deployable package `@socketo/server`, the reusable `@socketo/core` package, and the Node `@socketo/cli` package. Cloudflare application code is under `apps/server/`.
- The Worker entrypoint is `apps/server/src/index.ts`; it exports the `DatabaseDO` and `ServerDO` Durable Object classes and the Hono fetch handler.
- `ServerDO` owns WebSocket lifecycle, subscriptions, presence, and broadcasting per app; `DatabaseDO` is the `default` singleton that stores app credentials/configuration in SQLite.
- The public API is mounted at `/app/:key` for WebSockets and `/apps/:key/*` for authenticated REST operations; protocol version `7` is required for WebSocket upgrades.

## Commands

- Install with `bun install`; this repository is pinned to Bun `1.3.12` and requires Node `>=20`.
- Run all workspace development tasks with `bun run dev`; run only the Worker with `bun run --filter=@socketo/server dev`.
- Build everything with `bun run build`; build only the Worker with `bun run --filter=@socketo/server build`.
- Build the shared core with `bun run --filter=@socketo/core build` and the CLI with `bun run --filter=@socketo/cli build`.
- Run unit tests with `bun test` or `bun run --filter=@socketo/core test` (10 unit tests, 126 assertions).
- Start the local CLI with `bun run --filter=@socketo/cli start`; it is a standalone Node `ws` adapter over `@socketo/core`.
- Deploy only through `bun run --filter=@socketo/server deploy`; this runs `vite build` before `wrangler deploy`.
- Regenerate Cloudflare bindings after changing `apps/server/wrangler.jsonc` with `bun run --filter=@socketo/server cf-typegen`; `apps/server/worker-configuration.d.ts` is generated and should not be edited manually.
- Run `bunx oxlint .` for the configured Oxlint rules; `bunx tsc -p apps/server/tsconfig.json --noEmit` is the focused typecheck.

## Local Worker Setup

- Start the Worker before initializing local data: `bun run --filter=@socketo/server dev`.
- Run `curl -X POST http://localhost:8787/migrate` after startup; `/migrate` is intentionally forbidden when `NODE_ENV=production`.
- Add an app row through Wrangler Local Explorer at `http://localhost:8787/cdn-cgi/explorer/do/DatabaseDO/default?table=apps`; the required fields and defaults are documented in `README.md`.
- Database schema migrations are defined in `apps/server/src/database/migrations.ts` and executed by `DatabaseDO`; Wrangler Durable Object class migrations are separately declared in `apps/server/wrangler.jsonc`.

## Change Constraints

- Preserve the Durable Object class names and existing migration tags in `apps/server/wrangler.jsonc`; changing them can affect deployed object state.
- Socket IDs generated across all WebSocket connections follow the official Pusher Channels standard `<int>.<int>` (`generateSocketId()` from `@socketo/core`).
- REST authentication requires the Pusher auth query parameters (`auth_version=1.0`, `auth_timestamp` within ±600s) and, for POST/PUT/PATCH requests, a matching `body_md5`; see `apps/server/src/api/middlewares/auth-middleware.ts`.
- `AppHandler` caches app configuration in memory. Changes made through Local Explorer may not affect an active `ServerDO` until it restarts, hibernates, or is redeployed.
- Keep Worker/runtime-specific code out of reusable protocol logic. `@socketo/core` owns protocol state, socket ID generation, and validation; the Durable Object and CLI packages provide their respective WebSocket adapters.
- Do not format or lint `apps/server/worker-configuration.d.ts` as ordinary source; regenerate it with Wrangler instead.
