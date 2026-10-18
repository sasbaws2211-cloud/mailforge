/**
 * The in-app assistant: a read-only helper that answers questions about Loomail from its documentation and a few facts about the
 * asking workspace.
 *
 *   GET  /v1/assistant/status   is it available, and how many questions a trial workspace has left today
 *   POST /v1/assistant/chat     one question (with the conversation so far) and its answer
 *
 * Read-only by design: it has no tools, changes nothing, and sees no contact data. The operator pays for it (their provider, never a
 * workspace's own key); a trial workspace has a daily number of questions, everyone has a short-burst limit, and the operator's monthly
 * dollar budget pauses it for all. Nothing is stored: the conversation lives in the person's browser, and only token counts are
 * logged. Not available to a suspended workspace or one waiting for deletion (the app's gate in app.ts turns those away).
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { recordLlmUsage } from "@loomail/db/llm";
import type { LlmProvider } from "@loomail/brain-oss";
import type { Db } from "../plugins/db.js";
import { createLimiter } from "../marketing/signup-logic.js";
import { cleanPagePath } from "../support/logic.js";
import { pageInfo, retrieve } from "../assistant/index.js";
import { loadTenantRow, loadWorkspaceFacts } from "../assistant/context.js";
import { dailyDecision, limitsFromEnv, planKind, questionsToday, startOfNextUtcDay, type AssistantLimits } from "../assistant/limits.js";
import { MAX_MESSAGE_CHARS, buildMessages, parseAnswer, searchQuery } from "../assistant/prompt.js";
import { assistantAvailable, resolveAssistantProvider, ASSISTANT_UNAVAILABLE } from "../assistant/provider.js";

export interface AssistantRouteOptions {
  /** Tests only: a stand-in for the operator's provider. The route records its usage itself. */
  provider?: LlmProvider;
  /** Tests only: override the limits that otherwise come from the environment. */
  limits?: Partial<AssistantLimits>;
  /** Tests only: how long to wait for the provider. */
  timeoutMs?: number;
}

const MAX_TURNS = 20;
/** The provider retries by itself; this is the most a person waits for an answer in all. */
export const ANSWER_TIMEOUT_MS = 40_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The assistant took too long to answer.")), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
const chatSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().transform((s) => s.trim()).pipe(z.string().min(1, "A message cannot be empty.").max(MAX_MESSAGE_CHARS, `A message is too long (at most ${MAX_MESSAGE_CHARS} characters).`)),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TURNS),
    page: z.unknown().optional(),
  })
  .strict()
  .refine((b) => b.messages.at(-1)?.role === "user", { message: "The last message must be from the user.", path: ["messages"] });

const assistantRoutes: FastifyPluginAsync<AssistantRouteOptions> = async (app, opts) => {
  const limits = (): AssistantLimits => ({ ...limitsFromEnv(), ...(opts.limits ?? {}) });
  const burst = () => {
    const l = limits();
    return { windowMs: l.burstWindowMs, max: l.burstMax };
  };
  let burstLimiter: ReturnType<typeof createLimiter> | null = null;
  const limiter = () => (burstLimiter ??= createLimiter(burst()));

  app.get("/status", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenant = request.tenant!;
    const now = new Date();
    const available = opts.provider ? true : await assistantAvailable(db, now);
    const row = await loadTenantRow(db, tenant.id);
    const kind = row ? planKind(row, now) : "paid";
    const decision = dailyDecision(kind, kind === "paid" ? 0 : await questionsToday(db, tenant.id, now), limits());
    return { available, daily: decision.limit === null ? null : { limit: decision.limit, remaining: decision.remaining } };
  });

  app.post<{ Body: unknown }>("/chat", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenant = request.tenant!;
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "Validation failed", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    }
    const now = new Date();

    const row = await loadTenantRow(db, tenant.id);
    if (!row) {
      reply.status(404);
      return { error: "Workspace not found." };
    }
    const kind = planKind(row, now);
    const decision = dailyDecision(kind, kind === "paid" ? 0 : await questionsToday(db, tenant.id, now), limits());
    if (!decision.allowed) {
      reply.status(429);
      return {
        error: `You have used today's ${decision.limit} assistant questions for your trial. They reset at midnight UTC. You can still send a request to Support.`,
        code: "assistant_daily_limit",
        limit: decision.limit,
        resets_at: startOfNextUtcDay(now).toISOString(),
      };
    }
    const hit = limiter().hit(`assistant:${tenant.userId}`);
    if (!hit.allowed) {
      reply.status(429).header("Retry-After", String(hit.retryAfterSec));
      return { error: "You are asking quickly. Please wait a moment and try again.", code: "assistant_burst" };
    }

    const resolved = opts.provider ? ({ ok: true, provider: opts.provider, metered: false } as const) : await resolveAssistantProvider(db, tenant.id, now);
    if (!resolved.ok) {
      reply.status(resolved.status);
      return { error: resolved.error, code: resolved.code };
    }

    const messages = parsed.data.messages;
    const page = pageInfo(cleanPagePath(parsed.data.page));
    const { chunks, scored } = retrieve(searchQuery(messages, page), page);
    const facts = await loadWorkspaceFacts(db, tenant.id, row, now);
    const built = buildMessages({ messages, chunks, facts, page });

    let content: string;
    try {
      const result = await withTimeout(resolved.provider.complete({ messages: built.messages, temperature: 0.2, max_tokens: 1200 }), opts.timeoutMs ?? ANSWER_TIMEOUT_MS);
      content = result.content;
      if (!resolved.metered) {
        await recordLlmUsage(db, {
          tenantId: tenant.id,
          feature: "assistant",
          source: "platform",
          provider: "test",
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          totalTokens: result.usage?.total_tokens,
          ok: true,
        });
      }
    } catch (err) {
      request.log.warn({ err: err instanceof Error ? err.message : String(err) }, "assistant provider failed");
      reply.status(502);
      return { error: "The assistant could not answer just now. Please try again, or send your question to Support.", code: "assistant_error" };
    }

    const { answer, suggestSupport } = parseAnswer(content);
    if (answer === "") {
      reply.status(502);
      return { error: "The assistant could not answer just now. Please try again, or send your question to Support.", code: "assistant_error" };
    }
    // Sources are what the model was actually shown, never what it claims to have used: the three best, with the page's own entry first.
    const sources = built.used.slice(0, 3).map((c) => ({ id: c.id, source: c.source, heading: c.heading, ...(c.path ? { path: c.path } : {}) }));
    const remaining = decision.remaining === null ? null : Math.max(0, decision.remaining - 1);
    return { answer, sources, suggest_support: suggestSupport || scored.length === 0, remaining };
  });
};

export default assistantRoutes;
export { ASSISTANT_UNAVAILABLE };
