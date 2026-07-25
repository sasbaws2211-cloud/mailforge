/**
 * Transport adapter interface - the seam between the drain worker and email delivery.
 *
 * Phase 4 (tasks 26-28) implements real adapters: SES, Resend, generic SMTP.
 * Until then, the production transport resolver returns null for every tenant
 * (no transport_configs row matches a real adapter). Messages that pass the
 * throttle gate remain at 'approved' and are re-evaluated each tick.
 *
 * The LogTransportAdapter (for tests only) lives in packages/worker/tests/.
 * It is structurally impossible to use in production: it is never registered
 * in any resolver, and cannot be imported from src/ without violating the
 * test/src boundary.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of attempting to send a single message via a transport adapter. */
export interface TransportSendResult {
  success: boolean;
  /** Provider's message ID (for tracking bounces/opens later). */
  providerMessageId?: string;
  /** Human-readable error when success = false. */
  error?: string;
}

/** Parameters passed to the transport adapter's send method. */
export interface TransportSendParams {
  /** Recipient email address. */
  to: string;
  /** Sender address (from transport_configs.from_email). */
  from: string;
  /** Sender display name (from transport_configs.from_name). */
  fromName?: string;
  /** Email subject line. */
  subject: string;
  /** HTML body. */
  bodyHtml: string;
  /** Plain text body (optional fallback). */
  bodyText?: string;
  /** Additional headers (List-Unsubscribe, etc.). Phase 4 / task 32b. */
  headers?: Record<string, string>;
  /** Message ID for idempotency / provider deduplication. */
  messageId: string;
}

/**
 * The contract that Phase 4 transport adapters must fulfill.
 *
 * Implementations:
 *   - SES adapter (task 27)
 *   - Resend adapter (task 28)
 *   - Generic SMTP adapter (task 28)
 *   - LogTransportAdapter (tests only, lives in tests/)
 */
export interface TransportAdapter {
  send(params: TransportSendParams): Promise<TransportSendResult>;
}

// ---------------------------------------------------------------------------
// Resolver type
// ---------------------------------------------------------------------------

/**
 * Resolves a TransportAdapter for a given tenant. Returns null if the tenant
 * has no active transport configured (the message stays approved and is
 * retried next tick).
 *
 * Phase 4 provides the real resolver that reads transport_configs and builds
 * the appropriate adapter. Until then, the production resolver always returns
 * null - meaning no messages are actually sent.
 */
export type TransportResolver = (tenantId: string) => Promise<TransportAdapter | null>;

// ---------------------------------------------------------------------------
// Production resolver (always null until Phase 4)
// ---------------------------------------------------------------------------

/**
 * Default production resolver: always returns null.
 * Phase 4 replaces this with a real resolver that reads transport_configs.
 */
export const nullTransportResolver: TransportResolver = async () => null;
