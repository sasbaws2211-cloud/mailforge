# Claros

**The open-source lifecycle email engine.** Your data, your transport, your LLM.

The goal: an AI-native alternative to Customer.io, Loops, and Mautic, where flows are defined in plain language, compiled once by an LLM into a deterministic execution plan, and executed by a pure Postgres-backed engine. None of that works yet.

**This is an early pre-release (v0.1.0).** The foundation is in place: schema, API server, magic-link auth, Docker, pg-boss queue. The engine, Brain, transport adapters, and dashboard are not built. See [What works today](#what-works-today).

---

## What works today

- **Full database schema** - all core tables defined (Drizzle ORM + pgvector), initial migration included
- **Fastify API server** - `--role=all|api|worker|scheduler` flag, `/health` endpoint
- **Magic-link auth** - request/verify/logout/session endpoints, HTTP-only cookie
- **Console login fallback** - when no transport is configured, the login link is printed to the server console (`docker compose logs app`)
- **Bootstrap seed** - first boot creates a default tenant and owner from `SEED_ADMIN_EMAIL`
- **pg-boss job queue** - connected, scan queue and cron schedule registered (worker handler is a stub pending Phase 2)
- **Docker + docker-compose** - single image, one Postgres dependency, `docker compose up` starts the server and applies migrations automatically

What works end-to-end: bring the stack up, get a login link from the server console, verify it, receive a session cookie, hit `/health`. Nothing beyond auth is functional yet.

### Not yet built

- Event ingestion (`POST /v1/track`, `POST /v1/identify`)
- Lifecycle state machine (contact state transitions)
- Flow CRUD, prompt compilation, execution engine (scan, drain, reap workers)
- Brain: `decide()` and `draft()` (interface exists, implementation is a stub - no LLM calls)
- Transport adapters (SES, Resend, SMTP)
- Webhook ingestion (bounce, complaint, open, click)
- Unsubscribe compliance (RFC 8058 headers, hosted unsubscribe page, footer)
- Knowledge base (upload, crawl, pgvector search)
- Dashboard (React SPA - placeholder only)
- Business model templates

---

## Quickstart

The steps below work today. Steps that require the engine to be built are noted.

```bash
# 1. Clone and configure
git clone https://github.com/claroshq/claros.git
cd claros
cp .env.example .env
# Edit .env: set SEED_ADMIN_EMAIL to the email you will use to log in.

# 2. Start
docker compose up -d

# 3. Get your login link (printed to the console when no email transport is configured)
docker compose logs app | grep -A2 "MAGIC LINK LOGIN"

# 4. Open the login link in your browser.
#    You will receive a session cookie and can hit /health.
#    That is the extent of what is available in this release.
```

When the engine is built, the quickstart will extend to: describe a flow in plain language, send test events, watch contacts move through the lifecycle, approve Brain-drafted emails.

---

## Intended architecture

The following describes the design - not the current state. None of the layers below (except the server scaffold) are functional yet.

```
Event Ingestion (Segment-compatible track/identify)
        |
        v
  Unified Lifecycle State Machine (7 states + depth + payment overlay)
        |
        v
  Flow Engine (prompt-defined, LLM-compiled, deterministically executed)
        |
        v
  Brain: decide() + draft() (BYO LLM - OpenAI-compatible)
        |
        v
  Transport Adapters (SES / Resend / SMTP)
```

Single Docker image, role selection via `--role` flag:

```
docker run --rm \
  -e DATABASE_URL=postgres://user:pass@host:5432/claros \
  -e NODE_ENV=development \
  -e SEED_ADMIN_EMAIL=admin@yourcompany.com \
  -p 3000:3000 \
  ghcr.io/claroshq/claros:latest \
  --role=all

# Variants:
#   --role=api        HTTP API only
#   --role=worker     Background workers only
#   --role=scheduler  Scheduler only
```

> The GHCR image does not exist yet (no public release has been made). Build from source or use `docker compose up`.

Only runtime dependency: **Postgres** (pgvector extension, included in the compose image).

---

## Planned editions

Both editions share the same engine and schema. The distinction is how the product is operated and which private packages (`brain-cloud`, `billing`) are loaded.

| | Community (this repo, MIT) | Cloud |
|---|---|---|
| **Engine** | Full lifecycle engine, all workers | Same engine |
| **Brain** | BYO LLM key (OpenAI-compatible or local/Ollama) | BYO key at launch; optimized hosted prompts via `brain-cloud` |
| **Flows** | Prompt-defined, 3 business model templates | + Pre-built flow library via `brain-cloud` |
| **Transport** | SES, Resend, SMTP (bring your own) | + Zero-config hosted sending (paid tiers, post AWS approval) |
| **Contacts** | Unlimited (your hardware) | Unlimited on all plans |
| **Compliance** | RFC 8058 one-click unsub, suppression list, footer | Same + managed deliverability |
| **Auth** | Magic link; console fallback when no transport | Magic link; links sent via Claros SES |
| **Team** | Invites + 2 roles (owner, member) | Same |
| **Knowledge base** | Manual upload, site crawl, pgvector search (BYO embedding key) | Same (BYOK at launch) |
| **Deploy** | Self-host: single image, Postgres only, 30-min quickstart | Fully hosted, zero-ops |
| **Support** | Community, no SLA | Paid support |
| **Cost** | Free (MIT) | Pay per email sent |

None of this is available today. The table describes the v1.0 target. Cloud adds zero-ops hosting, zero-config sending, a pre-built flow library, and managed deliverability - not a better engine. The engine is identical.

---

## Project structure

```
packages/
  core/         Queue contract (QUEUE names, job payload types). Domain logic not yet added.
  adapters/     Placeholder. Transport and DB adapters not yet implemented.
  api/          Fastify app factory, /health and /auth/* routes, DB and tenant plugins.
  worker/       pg-boss factory, startWorker. One stub handler: scan (TODO Phase 2).
  scheduler/    startScheduler. One registered cron: scan every 15 min.
  brain-oss/    Brain interface (decide/draft) + stub implementation (no LLM calls yet).
apps/
  server/       Entrypoint - role parsing, bootstrap seed, wires api/worker/scheduler.
  dashboard/    Placeholder only. React SPA not yet built.
drizzle/        Full schema (14 tables), initial migration.
docker/         Dockerfile + docker-compose.yml
```

---

## Development

```bash
pnpm install
pnpm build        # Build all packages
pnpm test         # Run all tests (no database required)
pnpm db:generate  # Generate migration from schema changes
pnpm db:migrate   # Apply migrations (local only; requires DIRECT_DATABASE_URL in .env)
```

`pnpm dev` starts the server in watch mode against a local Postgres instance. Copy `.env.example` to `.env`, set `DATABASE_URL` to your local Postgres, then run `pnpm dev`. The server exits immediately if `DATABASE_URL` is unreachable.

---

## License

MIT - see [LICENSE](./LICENSE).

---

## Issues

[GitHub Issues](https://github.com/claroshq/claros/issues)
