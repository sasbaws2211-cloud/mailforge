# Claros

**The open-source lifecycle email engine.** Your data, your transport, your LLM. AI-native alternative to Customer.io, Loops, and Mautic.

Claros compiles prompt-defined flows into deterministic execution plans and drafts emails with an LLM Brain - giving you Customer.io-class lifecycle automation with a single dependency: Postgres.

---

## Quickstart (30 minutes)

> Commands below are verified at Phase 6 - the compose path works today.

```bash
# 1. Clone and configure
git clone https://github.com/claroshq/claros.git
cd claros
cp .env.example .env
# Edit .env: set your LLM_API_KEY (OpenAI-compatible endpoint)

# 2. Start
docker compose up -d

# 3. Get your login link
docker compose logs app | grep "Login link"
# Or: docker compose exec app claros login-link admin@yourcompany.com
```

That's it. Open the login link, describe your first flow in plain language, and Claros handles the rest.

**No transport configured?** Login links print to the server console. You can add SES, Resend, or any SMTP provider later from Settings.

---

## Architecture

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

Single Docker image with role selection:

```bash
docker run ghcr.io/claroshq/claros:latest --role=all    # Everything in one process
docker run ghcr.io/claroshq/claros:latest --role=api    # HTTP API only
docker run ghcr.io/claroshq/claros:latest --role=worker # Background processing
docker run ghcr.io/claroshq/claros:latest --role=scheduler # Scheduling
```

Only dependency: **Postgres** (with pgvector for knowledge base embeddings).

---

## Editions

| | Community (this repo, MIT) | Cloud (useclaros.com) |
|---|---|---|
| **Engine** | Full lifecycle engine, all workers | Same engine |
| **Brain** | BYO LLM key (OpenAI-compatible or local/Ollama) | BYO key at MVP + optimized hosted prompts |
| **Flows** | Prompt-defined, 3 business model templates | + Curated flow library |
| **Transport** | SES, Resend, SMTP (bring your own) | + Zero-config hosted sending |
| **Contacts** | Unlimited (your hardware) | Unlimited on all plans |
| **Compliance** | Full (RFC 8058 one-click unsub, suppression, footer) | Full + managed deliverability |
| **Deploy** | Single image, one dependency (Postgres), 30-min setup | Fully hosted, zero-ops |
| **Support** | Community, no SLA | Real support |
| **Cost** | Free forever (MIT) | Pay for what you send |

Community is a full product - not a demo, not a teaser.

---

## Project Structure

```
packages/
  core/         Pure logic - domain types, state machines, business rules
  adapters/     I/O layer - database, transport, external services
  api/          HTTP API (Fastify routes, middleware)
  worker/       Background jobs (scan, drain, reap)
  scheduler/    Cron-like scheduling (flow timing, window evaluation)
  brain-oss/    Brain interface + community implementation
apps/
  server/       Entrypoint - Fastify server with role selection
  dashboard/    React SPA (Vite)
drizzle/        Database schema and migrations
docker/         Dockerfile + docker-compose.yml
```

---

## Development

```bash
pnpm install
pnpm dev          # Start all roles against local Postgres
pnpm test         # Run all tests
pnpm build        # Build all packages
pnpm db:generate  # Generate migration from schema changes
pnpm db:migrate   # Apply migrations (local only)
```

---

## License

MIT - see [LICENSE](./LICENSE).

---

## Links

- Website: [claros.org](https://claros.org)
- Cloud: [useclaros.com](https://useclaros.com)
- Issues: [GitHub Issues](https://github.com/claroshq/claros/issues)
