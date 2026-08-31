---
"@socketo/cli": patch
---

### Core Protocol and Engine
- **Shared Pusher v7 Protocol Engine:** Consolidated multi-channel event triggering, batch events, presence tracking, and REST queries into `@socketo/core`.
- **Full REST API Support:** Added complete support for `/apps/:id/events`, `/apps/:id/batch_events`, `/apps/:id/channels`, `/apps/:id/channels/:name`, `/apps/:id/channels/:name/users`, and `/apps/:id/users/:user_id/terminate_connections`.
- **Accurate Subscription & User Counts:** Implemented Pusher-compliant `info=subscription_count,user_count` query attribute resolution for channel listing, single channel queries, and batch triggers.
- **Robust Auth & Signin Verification:** Synchronous HMAC-SHA256 verification for private channels, presence channels, and `pusher:signin` connection authentication.

### Interactive CLI and Local Dev Server
- **Interactive TUI REPL:** Added live terminal REPL console with interactive slash commands (`/trigger`, `/channels`, `/presence`, `/sockets`, `/terminate`, `/verbose`, `/clear`, `/help`, `/quit`) and shorthand aliases (`/t`, `/c`, `/p`, `/s`, `/v`, `/q`, `/kick`, `/cls`).
- **Smart Autocomplete & Ghost Text:** Added non-intrusive inline suggestions and Tab completion for commands and subcommands.
- **Stream-Safe Event Logging:** Real-time lifecycle and socket event logs cleanly render above the active interactive prompt without interrupting user input.
- **Custom Bindings & Credentials:** Added support for `-H, --host` (LAN/Docker binding), `-p, --port`, `-i, --app-id`, `-k, --app-key`, `-s, --app-secret`, and `-v, --verbose` live payload logging.
- **Standalone Packaging:** Built as a self-contained zero-dependency bundle via Rolldown with executable bin shebang.

### Quality and Architecture
- **Type Safety & Linting:** Enforced strict type guards, Biome formatting, and Oxlint safety rules across the entire codebase.
- **Automated Test Coverage:** Added unit test suites covering CLI server logging, REPL command registry, and core protocol methods.
