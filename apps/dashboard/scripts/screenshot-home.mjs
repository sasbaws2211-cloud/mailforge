/**
 * Home screen screenshot harness.
 *
 * Captures all four states in both light and dark themes:
 *   90-home-fresh       - completely fresh install (no keys, no settings)
 *   91-home-partial     - partway through setup (keys + transport, but no flow/events)
 *   92-home-attention   - fully set up, things needing attention
 *   93-home-allclear    - fully set up, nothing wrong
 *
 * Run after screenshot.mjs (reuses the same .verify-url).
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const BASE = argValue("--base") ?? "http://localhost:5173";
const OUT = new URL("../.screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const VERIFY_URL_FILE = new URL("../.screenshots/.verify-url", import.meta.url).pathname;
let verifyUrl = argValue("--verify-url");
if (!verifyUrl && existsSync(VERIFY_URL_FILE)) {
  verifyUrl = readFileSync(VERIFY_URL_FILE, "utf8").trim();
}

async function shoot(page, name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: false });
  console.log(`  ${name}.png`);
}

const browser = await chromium.launch();
let sessionCookies = null;

// ---------------------------------------------------------------------------
// Shared stub payloads
// ---------------------------------------------------------------------------

const diagnosticsAllPresent = {
  commit: "abc123",
  edition: "community",
  builtAt: null,
  startedAt: new Date().toISOString(),
  keys: {
    ENCRYPTION_KEY: { present: true, byteLength: 32, fingerprint: "aabbccdd", decodeError: null },
    UNSUBSCRIBE_SIGNING_KEY: { present: true, byteLength: 32, fingerprint: "11223344", decodeError: null },
  },
};

const diagnosticsMissing = {
  commit: "abc123",
  edition: "community",
  builtAt: null,
  startedAt: new Date().toISOString(),
  keys: {
    ENCRYPTION_KEY: { present: false, byteLength: null, fingerprint: null, decodeError: null },
    UNSUBSCRIBE_SIGNING_KEY: { present: false, byteLength: null, fingerprint: null, decodeError: null },
  },
};

const transportNull = { transport: null };
const llmNull = { llm: null };
const tenantNoPostal = {
  tenant: { id: "t", name: "Acme", slug: "acme", plan: "free", postal_address: null, created_at: new Date().toISOString() },
};

const transportConfigured = {
  transport: {
    id: "tr1",
    provider: "resend",
    from_email: "hello@acme.com",
    from_name: "Acme",
    daily_limit: 5000,
    dkim_verified: true,
    is_active: true,
    created_at: new Date().toISOString(),
  },
};

const llmConfigured = {
  llm: { id: "lm1", provider: "openai", model: "gpt-4o", base_url: null, embedding_model: "text-embedding-3-small", is_active: true, created_at: new Date().toISOString() },
};

const tenantWithPostal = {
  tenant: { id: "t", name: "Acme", slug: "acme", plan: "free", postal_address: "1 Main St, Springfield, IL 62701", created_at: new Date().toISOString() },
};

const ingestKeysEmpty = { keys: [] };
const ingestKeysPresent = {
  keys: [{ id: "k1", kind: "publishable", prefix: "mf_pub_", label: "Production", allowed_origins: [], last_used_at: new Date().toISOString(), created_at: new Date().toISOString(), revoked_at: null }],
};

const ingestStatusNoEvents = { last_event: null, events_last_24h: 0 };
const ingestStatusWithEvents = {
  last_event: { type: "track", event_name: "signed_up", user_id: "usr_01", received_at: new Date(Date.now() - 120000).toISOString() },
  events_last_24h: 347,
};

// A flow list with one active library flow (compile_status ready)
const activeLibraryFlow = {
  id: "fl-lib-01",
  tenant_id: "t",
  name: "Welcome Onboarding",
  description: "3-email welcome sequence",
  priority: 10,
  trigger_type: "event",
  trigger_config: { event: "signed_up" },
  steps: [],
  source: "library",
  status: "active",
  approval_mode: "auto",
  flow_class: "nurture",
  reentry_policy: "once",
  reentry_cooldown_days: 0,
  prompt_source: null,
  compiled_plan: { trigger: { type: "event", condition: { event: "signed_up" } }, steps: [], exit_conditions: [] },
  compiled_at: new Date().toISOString(),
  compile_status: "ready",
  compile_error: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// A flow with a compile failure
const failedCompileFlow = {
  id: "fl-fail-01",
  tenant_id: "t",
  name: "Re-engagement Nurture",
  description: null,
  priority: 5,
  trigger_type: "lifecycle_transition",
  trigger_config: { from: "engaged", to: "at_risk" },
  steps: [],
  source: "manual",
  status: "draft",
  approval_mode: "require",
  flow_class: "nurture",
  reentry_policy: "cooldown",
  reentry_cooldown_days: 30,
  prompt_source: "Send a short check-in at day 14, a value reminder at day 21.",
  compiled_plan: null,
  compiled_at: null,
  compile_status: "failed",
  compile_error: "No LLM configuration found. Add an LLM provider in Settings.",
  created_at: new Date(Date.now() - 86400000 * 3).toISOString(),
  updated_at: new Date(Date.now() - 3600000).toISOString(),
};

const flowsEmpty = { flows: [] };
const flowsActiveOnly = { flows: [activeLibraryFlow] };
const flowsWithCompileError = { flows: [activeLibraryFlow, failedCompileFlow] };

const messagesEmpty = { messages: [], next_cursor: null };

const pendingMessages = {
  messages: [
    {
      id: "msg-1",
      tenant_id: "t",
      contact_id: "c1",
      flow_id: "fl-lib-01",
      flow_step_order: 2,
      status: "pending_approval",
      subject: "Still getting value from Acme?",
      body_html: null,
      body_text: "Hi,\n\nJust checking in - are you still finding Acme useful?\n\nAcme",
      brain_reasoning: "Contact has been quiet for 12 days. Low-pressure check-in.",
      brain_action_type: "send_email",
      created_at: new Date(Date.now() - 3600000).toISOString(),
      updated_at: new Date(Date.now() - 3600000).toISOString(),
      contact: { email: "alice@example.com", name: "Alice", external_id: "usr_alice" },
    },
    {
      id: "msg-2",
      tenant_id: "t",
      contact_id: "c2",
      flow_id: "fl-lib-01",
      flow_step_order: 3,
      status: "pending_approval",
      subject: "One thing before you go",
      body_html: null,
      body_text: "Hi,\n\nA single question: what nearly stopped you from upgrading?\n\nAcme",
      brain_reasoning: "Final step before contact exits. Question-led to gather signal.",
      brain_action_type: "send_email",
      created_at: new Date(Date.now() - 7200000).toISOString(),
      updated_at: new Date(Date.now() - 7200000).toISOString(),
      contact: { email: "bob@example.com", name: "Bob", external_id: "usr_bob" },
    },
  ],
  next_cursor: null,
};

const failedMessages = {
  messages: [
    {
      id: "msg-fail-1",
      tenant_id: "t",
      contact_id: "c3",
      flow_id: "fl-fail-01",
      flow_step_order: 1,
      status: "failed",
      subject: null,
      body_html: null,
      body_text: null,
      brain_reasoning: "No LLM configuration found. Add an LLM provider in Settings.",
      brain_action_type: null,
      created_at: new Date(Date.now() - 1800000).toISOString(),
      updated_at: new Date(Date.now() - 1800000).toISOString(),
      contact: { email: "carol@example.com", name: "Carol", external_id: "usr_carol" },
    },
  ],
  next_cursor: null,
};

const sendingClean = {
  range_days: 7,
  days: [],
  totals: { sent: 89, opened: 51, clicked: 12, bounced: 0, complained: 0, suppressed: 2, failed: 0 },
  per_flow: [],
};

const sendingCleanPrior = {
  range_days: 14,
  days: [],
  totals: { sent: 162, opened: 95, clicked: 24, bounced: 0, complained: 0, suppressed: 3, failed: 0 },
  per_flow: [],
};

const lifecycleClean = {
  range_days: 7,
  contacts_total: 248,
  distribution: [
    { state: "signed_up", total: 34, power: 0, regular: 0, casual: 10, minimal: 24, unset: 0 },
    { state: "activated", total: 89, power: 5, regular: 31, casual: 40, minimal: 13, unset: 0 },
    { state: "engaged", total: 98, power: 22, regular: 44, casual: 32, minimal: 0, unset: 0 },
    { state: "at_risk", total: 18, power: 0, regular: 4, casual: 8, minimal: 6, unset: 0 },
    { state: "dormant", total: 9, power: 0, regular: 1, casual: 3, minimal: 5, unset: 0 },
  ],
  movement: {
    per_state: [
      { state: "signed_up", entered: 12, exited: 8 },
      { state: "activated", entered: 8, exited: 3 },
      { state: "engaged", entered: 3, exited: 1 },
      { state: "at_risk", entered: 1, exited: 2 },
    ],
    edges: [],
    days: [],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubAll(context, { diagnostics, transport, llm, tenant, ingestKeys, ingestStatus, flows, messages, failedMsgs, sending7, sending14, lifecycle }) {
  if (diagnostics) context.route("**/v1/diagnostics", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(diagnostics) }));
  if (transport) context.route("**/v1/settings/transport", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(transport) }));
  if (llm) context.route("**/v1/settings/llm", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(llm) }));
  if (tenant) context.route("**/v1/settings/tenant", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(tenant) }));
  if (ingestKeys) context.route("**/v1/ingestion/keys", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ingestKeys) }));
  if (ingestStatus) context.route("**/v1/ingestion/status", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ingestStatus) }));
  if (flows) context.route("**/v1/flows", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(flows) }));
  if (messages !== undefined) {
    // stub both pending and failed status queries
    context.route("**/v1/messages*", r => {
      const url = r.request().url();
      if (url.includes("status=failed")) {
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(failedMsgs ?? messagesEmpty) });
      }
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(messages) });
    });
  }
  if (sending7 || sending14) {
    context.route("**/v1/analytics/sending*", r => {
      const url = r.request().url();
      if (url.includes("days=14")) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sending14 ?? sending7) });
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sending7) });
    });
  }
  if (lifecycle) context.route("**/v1/analytics/lifecycle*", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(lifecycle) }));
}

async function unstubAll(context) {
  await context.unroute("**/v1/diagnostics");
  await context.unroute("**/v1/settings/transport");
  await context.unroute("**/v1/settings/llm");
  await context.unroute("**/v1/settings/tenant");
  await context.unroute("**/v1/ingestion/keys");
  await context.unroute("**/v1/ingestion/status");
  await context.unroute("**/v1/flows");
  await context.unroute("**/v1/messages*");
  await context.unroute("**/v1/analytics/sending*");
  await context.unroute("**/v1/analytics/lifecycle*");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Authenticate
  if (sessionCookies) {
    await context.addCookies(sessionCookies);
  } else if (verifyUrl) {
    const token = new URL(verifyUrl).searchParams.get("token") ?? "";
    const resp = await context.request.post(`${new URL(verifyUrl).origin}/auth/verify`, {
      form: { token },
      maxRedirects: 0,
    }).catch(() => null);
    const location = resp?.headers()["location"] ?? "";
    if (location.includes("error=")) {
      console.log("verify FAILED - home shots will show login page");
    } else {
      console.log(`verify: status=${resp?.status()}`);
      sessionCookies = await context.cookies("http://localhost");
      await context.addCookies(sessionCookies);
    }
  } else {
    console.log("no verify URL - home shots will show login page");
  }

  // -------------------------------------------------------------------------
  // STATE 90: Fresh install
  // No keys, no transport, no LLM, no postal address, no flows, no ingest key,
  // no events. Shows setup mode in worst state.
  // -------------------------------------------------------------------------
  stubAll(context, {
    diagnostics: diagnosticsMissing,
    transport: transportNull,
    llm: llmNull,
    tenant: tenantNoPostal,
    ingestKeys: ingestKeysEmpty,
    ingestStatus: ingestStatusNoEvents,
    flows: flowsEmpty,
  });
  await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-90-home-fresh`);
  await unstubAll(context);

  // -------------------------------------------------------------------------
  // STATE 91: Partway through setup
  // Keys present, transport configured, but no LLM, postal address missing,
  // no active flow, no ingest key, no events.
  // Tier A is 2/4; Tier B 0/1; Tier C 0/3.
  // -------------------------------------------------------------------------
  stubAll(context, {
    diagnostics: diagnosticsAllPresent,
    transport: transportConfigured,
    llm: llmNull,
    tenant: tenantNoPostal,
    ingestKeys: ingestKeysEmpty,
    ingestStatus: ingestStatusNoEvents,
    flows: flowsEmpty,
  });
  await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-91-home-partial`);
  await unstubAll(context);

  // -------------------------------------------------------------------------
  // STATE 92: Fully set up, things needing attention
  // All green: keys, transport, LLM, postal, ingest key, events arriving,
  // active flow. But: 2 pending approvals, 1 failed message, 1 compile error.
  // Operational mode, attention items visible.
  // -------------------------------------------------------------------------

  // Clear any localStorage dismissal so we land in operational mode
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("mailforge-home-setup-dismissed"));

  stubAll(context, {
    diagnostics: diagnosticsAllPresent,
    transport: transportConfigured,
    llm: llmConfigured,
    tenant: tenantWithPostal,
    ingestKeys: ingestKeysPresent,
    ingestStatus: ingestStatusWithEvents,
    flows: flowsWithCompileError,
    messages: pendingMessages,
    failedMsgs: failedMessages,
    sending7: sendingClean,
    sending14: sendingCleanPrior,
    lifecycle: lifecycleClean,
  });
  await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-92-home-attention`);
  await unstubAll(context);

  // -------------------------------------------------------------------------
  // STATE 93: Fully set up, all clear - NOTHING wrong.
  // All green, no pending, no failed, no compile errors, events arriving
  // steadily, clean analytics. This is the hardest state to design.
  // -------------------------------------------------------------------------
  stubAll(context, {
    diagnostics: diagnosticsAllPresent,
    transport: transportConfigured,
    llm: llmConfigured,
    tenant: tenantWithPostal,
    ingestKeys: ingestKeysPresent,
    ingestStatus: ingestStatusWithEvents,
    flows: flowsActiveOnly,
    messages: messagesEmpty,
    failedMsgs: messagesEmpty,
    sending7: sendingClean,
    sending14: sendingCleanPrior,
    lifecycle: lifecycleClean,
  });
  await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-93-home-allclear`);
  await unstubAll(context);

  await context.close();
}

await browser.close();
console.log(`done -> ${OUT}`);
