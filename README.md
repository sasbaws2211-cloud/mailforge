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
- **Lifecycle state machine** - 7 contact states (`signed_up`, `activated`, `engaged`, `at_risk`, `dormant`, `churned`, `resurrected`) with a payment overlay. Event-driven and time-driven transitions, CAS writes, full audit log.
- **Flow CRUD** - create, read, update, delete, and archive flows via `/v1/flows`. Flows hold a trigger, steps, class, reentry policy, and window policy.
- **Flow compilation** - `POST /v1/flows/:id/compile` kicks off an LLM compile job. `compile()` in `brain-oss` makes real LLM calls (OpenAI-compatible endpoint) and writes the compiled execution plan back to the flow.
- **Execution engine** - four scan phases running every 15 minutes:
  1. Time-driven lifecycle transitions
  2. Flow enrollment (event triggers, lifecycle transitions)
  3. Step advancement (condition evaluation, delay handling, message creation)
  4. Engagement depth computation
- **Throttle gate** - per-tenant send-window and rate-limit checks run before any message leaves the step-advancement phase
- **Drain worker** - claims approved messages via `FOR UPDATE SKIP LOCKED`, evaluates suppression and throttle, injects RFC 8058 compliance headers and CAN-SPAM footer, and sends via the configured transport adapter
- **Reap worker** - recovers messages stuck in `sending` or `generating` beyond timeout, with retry logic and terminal `failed` marking
- **pg-boss job queue** - nine queues registered with real handlers: SCAN, COMPILE, TRIGGER_CHECK, DRAIN, REAP, COUNTER_ROLLOVER, PARTITION_MAINTENANCE, CONTENT_GENERATION, KB_EMBED
- **Email compliance** - RFC 8058 one-click unsubscribe (HTTPS), hosted unsubscribe page, CAN-SPAM footer (unsubscribe link + postal address), suppression list
- **Transport adapters** - Resend, with SES and SMTP adapters pending
- **Operator CLI** (`claros`) - login links, guided setup, transport/LLM/postal-address configuration; see [CLI reference](#cli-reference)
- **Knowledge base API** - CRUD for KB entries (`POST /v1/kb`, `GET /v1/kb`, `GET /v1/kb/:id`, `PATCH /v1/kb/:id`, `DELETE /v1/kb/:id`, `POST /v1/kb/re-embed`). `kb_entries` table with `vector(1536)` column. Creating or updating an entry enqueues an embedding job. Compile worker reads KB entry titles as context for LLM prompts. No file upload, site crawl, or search (similarity query) endpoint yet.
- **Business model templates** - `GET /v1/templates` lists the three built-in templates (preview_free, freemium, time_limited_trial). `POST /v1/templates/:id/apply` applies a template to the calling tenant: writes lifecycle and throttle settings, sets brain_context, and creates the suggested flows as drafts (uncompiled).
- **Message approvals** - `GET /v1/messages` lists messages pending approval. `POST /v1/messages/:id/approve` and `POST /v1/messages/:id/reject` advance the message state with CAS guarantees.
- **Webhook ingestion** - `POST /webhooks/resend/:tenantId` receives Resend event notifications (bounces, complaints, opens, clicks, deliveries). Verifies Svix HMAC-SHA256 signatures, advances the feedback column with advance-only CAS transitions, suppresses on permanent bounces and complaints. Requires `webhook_secret` in the tenant's transport configuration. No other provider webhook yet.
- **Docker + docker-compose** - single image, one Postgres dependency, `docker compose up` starts the server and applies migrations automatically

### Not yet built

- **Content generation** - `decide()` and `draft()` in `brain-oss` make real LLM calls. The content worker runs the full pipeline: `pending_generation -> generating -> awaiting_content -> pending_approval`. `decide()` picks the action and decides whether to contact, skip, or wait. `draft()` produces subject + body_markdown. `assess()` gates the draft for value before writing to `pending_approval`. Requires an LLM configuration (set via `claros llm set`).
- Knowledge base file upload, site crawl, and pgvector similarity search endpoint
- SES and SMTP transport adapters (only Resend is implemented)
- Webhook ingestion for providers other than Resend
- Dashboard (React SPA - placeholder package only)

---

## Quickstart

```bash
# 1. Clone and configure
git clone https://github.com/claroshq/claros.git
cd claros
cp .env.example .env
# Edit .env: set SEED_ADMIN_EMAIL (default: admin@example.com)

# 2. Start
docker compose up -d

# 3. Complete setup: postal address, LLM, and transport (guided wizard)
docker compose exec app claros setup

# 4. Get a login link
docker compose exec app claros login-link admin@example.com

# 5. Open the URL printed by step 4. You receive a session cookie.
```

If you prefer to configure each step separately rather than using the wizard, see [CLI reference](#cli-reference).

Once you have a session cookie you can exercise ingestion and flows directly:

```bash
# Generate an API write key for ingestion (cl_live_... prefix).
# Run this from inside the container (or from source with pnpm build):
docker compose exec app node -e "
import { randomBytes, createHash } from 'crypto';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const tenant = await pool.query(\"SELECT id FROM tenants WHERE slug = 'default'\");
const raw = 'cl_live_' + randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(raw).digest('hex');
await pool.query('INSERT INTO api_keys(tenant_id, key_hash, prefix) VALUES(\$1,\$2,\$3)',
  [tenant.rows[0].id, hash, raw.slice(0,8)]);
console.log(raw);
await pool.end();
" --input-type=module 2>/dev/null
# The raw key is printed once. Record it - it cannot be retrieved later.

# Ingest events (use the write key above as the Bearer token)
curl -X POST http://localhost:3000/v1/identify \
  -H "Authorization: Bearer <write_key>" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "traits": {"email": "user@example.com", "payment_status": "trial"}}'

curl -X POST http://localhost:3000/v1/track \
  -H "Authorization: Bearer <write_key>" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "event": "signed_up"}'

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

# Compile the flow (requires LLM config above and a prompt_source on the flow)
curl -X POST http://localhost:3000/v1/flows/<flow_id>/compile \
  --cookie "claros_session=<token>"
# Poll GET /v1/flows/<flow_id> until compile_status = "ready".

# Activate the flow (required - flows are created in draft status and
# enroll no contacts until explicitly set to active)
curl -X PATCH http://localhost:3000/v1/flows/<flow_id> \
  -H "Content-Type: application/json" \
  --cookie "claros_session=<token>" \
  -d '{"status": "active"}'
```

---

## CLI reference

Claros ships one operator CLI: `claros`. All operator tasks go through it.

### Invocation

**Docker Compose** (app container running):
```bash
docker compose exec app claros <command>
```

**Docker one-shot** (starts a fresh container, runs the command, exits):
```bash
docker compose run --rm --entrypoint claros app <command>
```

**Local checkout** (after `pnpm install && pnpm build`):
```bash
node apps/server/bin/claros.mjs <command>
```

### Commands

```
claros                               Show help listing all commands
claros help [command]                Show detailed help for a specific command

claros doctor                        Read-only deployment diagnostic (see below)
claros login-link <email>            Generate a one-time login URL
claros setup [tenant_slug]           Guided first-run wizard (postal address, LLM, transport)

claros transport set <tenant_slug>   Write transport credentials
claros transport show <tenant_slug>  Show active transport config (no credentials shown)

claros llm set <tenant_slug>         Write LLM provider credentials
claros llm show <tenant_slug>        Show active LLM config (no credentials shown)

claros postal-address set <slug>     Set the CAN-SPAM physical mailing address
claros postal-address show <slug>    Show the current postal address
```

Default `tenant_slug` for `setup` is `default`. All other commands require an explicit slug.

### `claros doctor`

Read-only deployment diagnostic. Run this after every deploy and after any secret rotation. It never writes to the database.

```bash
# Local checkout (after pnpm build), no environment comparison:
node apps/server/bin/claros.mjs doctor

# With environment key comparison (requires a session token):
# The session token is a live 30-day credential. Do not paste it into
# shared terminals, CI logs, or chat. Use the environment variable form:
CLAROS_DOCTOR_SESSION=<claros_session_cookie_value> \
  node apps/server/bin/claros.mjs doctor

# Docker Compose (app container running):
docker compose exec app claros doctor
CLAROS_DOCTOR_SESSION=<claros_session_cookie_value> \
  docker compose exec app claros doctor
```

To get a session token: run `node apps/server/bin/claros.mjs login-link <email>`, visit the printed URL in a browser, then copy the `claros_session` cookie value from your browser's dev tools (Application > Cookies).

Output covers four sections:

- **Deployment** - the local HEAD commit versus the commit the running image reports via `GET /version`. Prints `PROVENANCE: OK` when they match, or an unmissable `MISMATCH` block when they differ. A mismatch means the container is running different code than your local checkout.
- **Database** - connection host, database name, SSL in use, applied migration count, and the name of the latest applied migration.
- **Transport** - active and inactive resend row counts. For the active row: whether decryption succeeded, which credential keys are present, and a fingerprint (first 8 hex chars of SHA-256) of the webhook secret. No secret value is ever printed.
- **Environment** - for `ENCRYPTION_KEY` and `UNSUBSCRIBE_SIGNING_KEY`: the LOCAL fingerprint (the value in the operator's local shell) compared against the CONTAINER fingerprint (the value the running container loaded from its own environment, retrieved via `GET /v1/diagnostics`). MATCH means both have the same value. MISMATCH means they differ - the most common cause after a secret rotation is that the container was not restarted. Without `--session`, the CONTAINER column shows "no session token" and only the LOCAL values are printed.

Example output with `CLAROS_DOCTOR_SESSION` set (fingerprints are illustrative placeholders):

```
╔══════════════════════════════════════════════════════════╗
║            claros doctor - deployment diagnostic          ║
╚══════════════════════════════════════════════════════════╝

  Deployment
  ──────────
    local HEAD:      a1b2c3d4e5f6...
    version URL:     https://api.example.com/version
    deployed commit: a1b2c3d4e5f6...

    PROVENANCE:  OK - local HEAD matches deployed commit

  Database
  ────────
    host/db:    db.host.example/claros
    type:       remote (unknown)
    SSL:        yes
    migrations: 18 applied
    latest:     0017_loud_black_tarantula

  Transport
  ─────────
    resend rows:  active=1  inactive=0
    active row:   decryption OK
    cred keys:    apiKey, webhookSecret
    webhookSecret fingerprint: xxxxxxxx... (first 8 hex chars of SHA-256)

  Environment
  ───────────
    ENCRYPTION_KEY:
      LOCAL:     present  44 bytes  fingerprint=xxxxxxxx...
      CONTAINER: present  44 bytes  fingerprint=xxxxxxxx...
      STATUS:    OK - fingerprints match
    UNSUBSCRIBE_SIGNING_KEY:
      LOCAL:     present  64 bytes  fingerprint=xxxxxxxx...
      CONTAINER: present  64 bytes  fingerprint=xxxxxxxx...
      STATUS:    OK - fingerprints match

    CLAROS_EDITION (container): community
    BASE_URL (local):  https://api.example.com  [https: OK]
```

The `GET /version` endpoint used by doctor is also directly accessible:

```bash
curl https://api.example.com/version
# {"commit":"a1b2c3d4...","edition":"community","builtAt":"2026-01-01T00:00:00Z"}
```

`commit` is `"unknown"` when the image was built without the `--build-arg COMMIT_SHA` argument (local builds). `builtAt` is `null` in that case.

**Security note:** doctor reads from your own database and calls your own `/version` and `/v1/diagnostics` endpoints. Do not point it at a deployment you do not control or administer. The session token you supply gives read access to `/v1/diagnostics` on the target server.

### `claros login-link`

Generates a one-time magic link login URL. No running server or email transport is required - the URL is printed directly to stdout and expires in 10 minutes.

```bash
docker compose exec app claros login-link admin@example.com
# Local checkout: node apps/server/bin/claros.mjs login-link admin@example.com
```

The user must already exist in the database. On a fresh install the default owner is `SEED_ADMIN_EMAIL` (default: `admin@example.com`).

### `claros setup`

Guided first-run wizard. Walks through postal address, LLM provider, and transport in the order the system requires them. Shows what is already configured and leaves it alone unless you choose to replace it. Safe to re-run.

When a step is skipped, the wizard prints what would be blocked without it and lists the remaining commands at the end.

```bash
docker compose exec app claros setup

# With a specific tenant
docker compose exec app claros setup my-tenant
```

### `claros transport set`

Writes the email transport configuration. API key is stored encrypted; it is never shown after writing.

Interactive (prompts for each field):
```bash
docker compose exec app claros transport set default
```

Non-interactive (piped JSON, for automation):
```bash
echo '{"provider":"resend","from_email":"hello@acme.com","from_name":"Acme","api_key":"re_..."}' \
  | docker compose exec -T app claros transport set default
```

Fields: `provider` (resend|ses|smtp - note: only resend sends email today; ses and smtp are accepted by the CLI and stored, but the drain skips them with a log message until those adapters are implemented), `from_email` (required), `from_name` (optional),
`api_key` (required), `webhook_secret` (optional), `daily_limit` (optional, integer).

### `claros llm set`

Writes the LLM provider configuration. Required for flow compilation and KB embedding.

Interactive:
```bash
docker compose exec app claros llm set default
```

Non-interactive:
```bash
echo '{"provider":"openai","api_key":"sk-...","base_url":"https://api.openai.com/v1","model":"gpt-4o"}' \
  | docker compose exec -T app claros llm set default
```

Fields: `provider` (openai|anthropic|ollama|custom), `api_key`, `model`,
`base_url` (optional for openai/anthropic/ollama - defaults applied; required for custom),
`embedding_model` (optional, default: `text-embedding-3-small`, must produce `vector(1536)`).

### `claros postal-address set`

Sets the physical mailing address required by CAN-SPAM. The drain blocks all sending until this is set.

Interactive:
```bash
docker compose exec app claros postal-address set default
```

Non-interactive:
```bash
echo '{"postal_address":"123 Main St, City, ST 12345"}' \
  | docker compose exec -T app claros postal-address set default
```

### Complete setup sequence

Every step is possible without a browser session:

```bash
# 1. Start the stack
docker compose up -d

# 2. Guided setup (postal address, LLM, transport in one flow)
docker compose exec app claros setup

# 3. Get your login link
docker compose exec app claros login-link admin@example.com

# 4. Open the URL in a browser
```

Or step by step if you prefer:

```bash
docker compose exec app claros postal-address set default
docker compose exec app claros llm set default
docker compose exec app claros transport set default
docker compose exec app claros login-link admin@example.com
```

---

## Segment-compatible API

Claros accepts the Segment wire format for `track` and `identify` calls. A `/batch` endpoint is planned (see the roadmap) but not implemented. Fields honored: `messageId` (dedup key), `timestamp` (client time, server records `receivedAt`), `traits` (shallow merge on identify, explicit `null` clears a key).

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
   Brain: compile() + decide() + draft() + assess() [all live - require LLM config]
        |
        v
  Transport Adapters (Resend [live], SES + SMTP [pending])
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
| **Transport** | Resend, SES, SMTP (bring your own) | + Zero-config hosted sending (paid tiers) |
| **Contacts** | Unlimited (your hardware) | Unlimited on all plans |
| **Compliance** | RFC 8058 one-click unsub, suppression list, CAN-SPAM footer | Same + managed deliverability |
| **Auth** | Magic link; CLI `claros login-link` always works | Magic link; links sent via Claros SES |
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
  adapters/     AES-256-GCM credential encryption. Transport adapters (Resend; SES/SMTP pending).
  api/          Fastify app factory. Routes: /health, /auth/*, /v1/track, /v1/identify,
                /v1/flows (CRUD + compile), /v1/kb (CRUD + re-embed), /v1/suppressions,
                /v1/templates (list + apply), /v1/messages (list + approve/reject),
                /v1/settings (transport, LLM, tenant),
                /unsubscribe (RFC 8058 one-click + browser), /webhooks/resend/:tenantId.
   worker/       Scan (4 phases), drain, reap, compile, content-generation (decide+draft),
                kb-embed, trigger-check, counter-rollover, partition-maintenance handlers.
  scheduler/    Registers cron schedules: scan every 15 min, drain every 15 min,
                content-generation every 5 min, reap every 60 min,
                counter-rollover every 15 min, partition-maintenance every 15 min.
                kb-embed is triggered on demand (no cron).
   brain-oss/    compile(), decide(), draft(), assess() - all make real LLM calls
                (OpenAI-compatible endpoint). Prompt builders and output schemas.
apps/
  server/       Entrypoint - role parsing, bootstrap seed, wires api/worker/scheduler.
                Operator CLI: apps/server/bin/claros.mjs
  dashboard/    Placeholder. React SPA not yet built.
drizzle/        Schema (19 tables), migrations.
docker/         Dockerfile and initdb scripts
docker-compose.yml  Single-image compose stack (Postgres + app)
```

---

## Development

```bash
pnpm install
pnpm build        # Build all packages (required before running the CLI)
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
