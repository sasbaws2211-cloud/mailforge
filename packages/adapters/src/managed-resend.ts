/**
 * Managed Resend adapter: sends a workspace's email through the operator's Resend
 * account, as the sender the platform chose for that workspace.
 *
 * Differences from the plain Resend adapter:
 *   - the From address, display name and Reply-To are fixed by the platform when the
 *     adapter is built (a verified customer domain, or the shared operator address),
 *     and whatever the drain passes in is ignored, so a workspace can never choose to
 *     send as someone else;
 *   - problems with the OPERATOR's account (bad key, account-level refusal) are reported
 *     as not permanent. They are not the customer's message's fault, and failing a
 *     customer's mail for the operator's misconfiguration would lose it for good. The
 *     message stays queued and goes out once the operator fixes the account.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { ResendTransportAdapter } from "./resend.js";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "./transport-types.js";

export interface ManagedResendConfig {
  apiKey: string;
  baseUrl?: string;
  fromEmail: string;
  fromName: string;
  replyTo?: string | null;
}

/** HTTP statuses that mean the operator's account (not this message) is the problem. */
const ACCOUNT_LEVEL_STATUSES = new Set([401, 403, 404, 405]);

export class ManagedResendAdapter implements TransportAdapter {
  private readonly inner: ResendTransportAdapter;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly replyTo: string | null;

  constructor(config: ManagedResendConfig) {
    this.inner = new ResendTransportAdapter({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    this.fromEmail = config.fromEmail;
    this.fromName = config.fromName;
    this.replyTo = config.replyTo ?? null;
  }

  async send(params: TransportSendParams): Promise<TransportSendResult> {
    const result = await this.inner.send({
      ...params,
      from: this.fromEmail,
      fromName: this.fromName,
      replyTo: this.replyTo ?? undefined,
    });
    if (result.success || !result.permanent) return result;
    const status = Number(/^Resend error (\d{3})/.exec(result.error ?? "")?.[1]);
    if (ACCOUNT_LEVEL_STATUSES.has(status)) {
      return { ...result, permanent: false, error: `Managed sending is unavailable (${result.error ?? "account error"}). The message will be retried.` };
    }
    return result;
  }
}
