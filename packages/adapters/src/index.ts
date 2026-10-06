/**
 * @mailforge/adapters - I/O adapters (database, transport, external services).
 * Depends on @mailforge/core.
 */
export const MAILFORGE_ADAPTERS_VERSION = "0.0.0";

export {
  encrypt,
  decrypt,
  parseEncryptionKey,
  type EncryptedEnvelope,
} from "./crypto.js";

export {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  type UnsubscribeTokenPayload,
  type UnsubscribeTokenError,
} from "./unsubscribe-token.js";

export type {
  TransportAdapter,
  TransportSendParams,
  TransportSendResult,
} from "./transport-types.js";

export {
  ResendTransportAdapter,
  type ResendAdapterConfig,
} from "./resend.js";

export {
  SmtpTransportAdapter,
  type SmtpAdapterConfig,
} from "./smtp.js";

export {
  DEFAULT_ALLOWED_SMTP_PORTS,
  SMTP_HOST_NOT_ALLOWED,
  isBlockedIp,
  normalizeHost,
  resolveSmtpTarget,
  smtpHostPolicyFromEnv,
  type SmtpHostPolicy,
  type SmtpTargetResult,
} from "./smtp-guard.js";

export {
  createResendDomainsClient,
  type DnsRecord,
  type DomainErrorKind,
  type DomainsResult,
  type ResendDomain,
  type ResendDomainsClient,
} from "./resend-domains.js";

export { ManagedResendAdapter, type ManagedResendConfig } from "./managed-resend.js";

export {
  resolveTransportAdapter,
  type ResolvedTransport,
  type TransportResolutionFailure,
  type ResolveTransportResult,
} from "./resolve-transport.js";
