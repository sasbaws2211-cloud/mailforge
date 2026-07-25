# Claros

**The open-source lifecycle email engine.** Your data, your transport, your LLM.

An AI-native alternative to Customer.io, Loops, and Mautic where flows are defined in plain language, compiled once by an LLM into a deterministic execution plan, and executed by a pure Postgres-backed engine.

---

## What works today

- **Full database schema** - all core tables (Drizzle ORM + pgvector), migrations included
- **Fastify API server** - `--role=all|api|worker|scheduler` flag, `/health` endpoint
- **Magic-link auth** - request/verify/logout/session endpoints, HTTP-only cookie
- **Console login fallback** - when no transport is configured, the login link is printed to the server console (`docker compose logs app`)
- **Bootstrap seed** - first boot creates a default tenant and owner from `SEED_ADMIN_EMAIL`
- **Event ingestion** - `POST /v1/track` and `POST /v1/identify`, Segment-compatible (track and identify calls only - see [Segment-compatible API](#segment-compatible-api)). Contact upsert, trait merge, messageId deduplication, lifecycle state transitions applied on ingest.
- **Lifecycle state machine** - 7 contact states (`new`, `activated`, `engaged`, `at_risk`, `dormant`, `resurrected`, `churned`) with a payment overlay. Event-driven and time-driven transitions, CAS writes, full audit log.
- **Flow CRUD** - create, read, update, delete, and archive flows via `/v1/flows`. Flows hold a trigger, steps, class, reentry policy, and window policy.
- **Flow compilation** - `POST /v1/flows/:id/compile` kicks off an LLM compile job. `compile()` in `brain-oss` makes real LLM calls (OpenAI-compatible endpoint) and writes the compiled execution plan back to the flow. `decide()` and `draft()` are still stubs - no content generation or approval flow yet.
- **Execution engine** - four scan phases running every 15 minutes:
  1. Time-driven lifecycle transitions
  2. Flow enrollment (event triggers, lifecycle transitions)
  3. Step advancement (condition evaluation, delay handling, message creation)
  4. Engagement depth computation
- **Throttle gate** - per-tenant send-window and rate-limit checks run before any message leaves the step-advancement phase
- **Drain worker** - claims approved messages via `FOR UPDATE SKIP LOCKED`, evaluates suppression and throttle, and prepares sends. **No email leaves the system today.** The transport resolver returns null in all deployments until Phase 4 (real SES/Resend/SMTP adapters). Messages are created, throttled, and queued; delivery does not happen yet.
- **Reap worker** - recovers messages stuck in `sending` or `generating` beyond timeout, with retry logic and terminal `failed` marking
- **pg-boss job queue** - seven queues registered with real handlers: SCAN, COMPILE, TRIGGER_CHECK, DRAIN, REAP, COUNTER_ROLLOVER, PARTITION_MAINTENANCE
- **Knowledge base schema** - `kb_entries` table with `vector(1536)` column; compile worker reads KB entry titles as context for LLM prompts. No upload, crawl, or search API exists yet.
- **Templates schema** - `templates` table exists. No pre-seeded templates and no management API yet.
- **Docker + docker-compose** - single image, one Postgres dependency, `docker compose up` starts the server and applies migrations automatically

### Not yet built

- Transport adapters (SES, Resend, SMTP) - interface and seam exist; no concrete adapter is wired
- Brain `decide()` and `draft()` - stubs returning no-ops; no content generation or approvals
- Webhook ingestion (bounce, complaint, open, click)
- Unsubscribe compliance (RFC 8058 headers, hosted unsubscribe page, footer) - planned for the same phase as transport adapters
- Knowledge base API (upload, crawl, pgvector search)
- Business model templates (pre-seeded content and management API)
- Dashboard (React SPA - placeholder package only)

---

## Quickstart

```bash
# 1. Clone and configure
git clone https://github.com/claroshq/claros.git
cd claros
cp .env.example .env
# Edit .env: set SEED_ADMIN_EMAIL and DATABASE_URL (or leave DATABASE_URL
# for docker-compose to manage via its internal Postgres service).
# Set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL if you want flow compilation to work.

# 2. Start
docker compose up -d

# 3. Get your login link (printed to the console when no email transport is configured)
docker compose logs app | grep -A2 "MAGIC LINK LOGIN"

# 4. Open the login link. You receive a session cookie valid for subsequent API calls.
```

Once you have a session cookie you can exercise ingestion and flows directly:

```bash
# Ingest events (write_key from your tenant - visible in the seed output or /auth/me)
curl -X POST http://localhost:3000/v1/track \
  -H "Authorization: Bearer <write_key>" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "event": "signed_up"}'

curl -X POST http://localhost:3000/v1/identify \
  -H "Authorization: Bearer <write_key>" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "traits": {"email": "user@example.com", "payment_status": "trial"}}'

# Create a flow (session cookie required - use --cookie from your browser or /auth/verify)
curl -X POST http://localhost:3000/v1/flows \
  -H "Content-Type: application/json" \
  --cookie "claros_session=<token>" \
  -d '{
    "name": "Trial onboarding",
    "trigger_type": "lifecycle_transition",
    "trigger_config": {},
    "steps": []
  }'
# Returns the full flow object including its id.

# Compile a flow (requires LLM_BASE_URL + LLM_API_KEY + prompt_source on the flow)
curl -X POST http://localhost:3000/v1/flows/<flow_id>/compile \
  --cookie "claros_session=<token>"
```

Note: the drain worker runs on schedule but no email is sent until transport adapters are built (Phase 4). The execution machinery runs; nothing leaves the system.

---

## Segment-compatible API

Claros accepts the Segment wire format for `track` and `identify` calls, plus `/batch`. Fields honored: `messageId` (dedup key), `timestamp` (client time, server records `receivedAt`), `traits` (shallow merge on identify, explicit `null` clears a key).

Not implemented: `page`, `screen`, `group`, `alias`. `anonymousId` is not yet accepted - contacts key on `userId` (`external_id`). Deferred identity stitching for anonymous pre-signup events is planned (expansion project); it is not available now.

---

## Intended architecture

```
Event Ingestion (track / identify - Segment-compatible subset)
        |
        v
  Lifecycle State Machine (7 states + engagement depth + payment overlay)
        |
        v
  Flow Engine (prompt-compiled, deterministically executed)
        |
        v
  Brain: compile() [live] + decide() + draft() [stubs - not yet implemented]
        |
        v
  Transport Adapters (SES / Resend / SMTP - not yet implemented)
```

Single Docker image, role selection via `--role` flag:

```
docker run --rm \
  -e DATABASE_URL=postgres://user:pass@host:5432/claros \
  -e NODE_ENV=production \
  -e SEED_ADMIN_EMAIL=admin@yourcompany.com \
  -p 3000:3000 \
  ghcr.io/claroshq/claros:latest \
  --role=all

# Variants:
#   --role=api        HTTP API only
#   --role=worker     Background workers only
#   --role=scheduler  Scheduler only
```

> The GHCR image is private until the public launch. Build from source or use `docker compose up`.

Only runtime dependency: **Postgres** (pgvector extension, included in the compose image).

---

## Planned editions

Both editions share the same engine and schema. The distinction is how the product is operated and which private packages (`brain-cloud`, `billing`) are loaded.

| | Community (this repo, MIT) | Cloud |
|---|---|---|
| **Engine** | Full lifecycle engine, all workers | Same engine |
| **Brain** | BYO LLM key (OpenAI-compatible or local/Ollama) | BYO key at launch; optimized hosted prompts via `brain-cloud` |
| **Flows** | Prompt-defined, business model templates (planned) | + Pre-built flow library via `brain-cloud` |
| **Transport** | SES, Resend, SMTP (bring your own) | + Zero-config hosted sending (paid tiers) |
| **Contacts** | Unlimited (your hardware) | Unlimited on all plans |
| **Compliance** | RFC 8058 one-click unsub, suppression list, footer (planned) | Same + managed deliverability |
| **Auth** | Magic link; console fallback when no transport | Magic link; links sent via Claros SES |
| **Team** | Invites + 2 roles (owner, member) | Same |
| **Knowledge base** | Manual upload, site crawl, pgvector search (planned) | Same |
| **Deploy** | Self-host: single image, Postgres only, 30-min quickstart | Fully hosted, zero-ops |
| **Support** | Community, no SLA | Paid support |
| **Cost** | Free (MIT) | Pay per email sent |

Items marked "planned" are not available today. Cloud adds zero-ops hosting, zero-config sending, a pre-built flow library, and managed deliverability - not a better engine. The engine is identical.

---

## Project structure

```
packages/
  core/         Lifecycle state machine, flow types, throttle gate, enrollment guards,
                engagement depth computation. Queue contract (QUEUE names, job payload types).
  adapters/     AES-256-GCM credential encryption (used by compile worker).
                Transport adapters (SES/Resend/SMTP) not yet implemented.
  api/          Fastify app factory. Routes: /health, /auth/*, /v1/track, /v1/identify,
                /v1/flows (CRUD + compile).
  worker/       Scan (4 phases), drain, reap, compile, trigger-check, counter-rollover,
                partition-maintenance handlers. Transport resolver is a null stub until
                Phase 4.
  scheduler/    Registers cron schedules: scan every 15 min, drain, reap, counter-rollover,
                partition-maintenance.
  brain-oss/    compile() - real LLM calls with retry (OpenAI-compatible).
                decide() and draft() - stubs, not yet implemented.
apps/
  server/       Entrypoint - role parsing, bootstrap seed, wires api/worker/scheduler.
  dashboard/    Placeholder. React SPA not yet built.
drizzle/        Schema (19 tables), migrations.
docker/         Dockerfile + docker-compose.yml
```

---

## Development

```bash
pnpm install
pnpm build        # Build all packages
pnpm test         # Run tests (unit tests pass without a database; integration tests
                  # require DATABASE_URL in .env pointing to a running Postgres)
pnpm db:generate  # Generate migration from schema changes
pnpm db:migrate   # Apply migrations (local only; uses DATABASE_URL from .env)
```

`pnpm dev` starts all packages in watch mode (`tsx watch`), defaulting to `--role=all`. Copy `.env.example` to `.env`, set `DATABASE_URL` to your local Postgres, then run `pnpm dev`. The server exits immediately if `DATABASE_URL` is unreachable.

---

## License

MIT - see [LICENSE](./LICENSE).

---

## Issues

[GitHub Issues](https://github.com/claroshq/claros/issues)
