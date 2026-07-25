/**
 * @claros/adapters - I/O adapters (database, transport, external services).
 * Depends on @claros/core.
 */
export const CLAROS_ADAPTERS_VERSION = "0.0.0";

export {
  encrypt,
  decrypt,
  parseEncryptionKey,
  type EncryptedEnvelope,
} from "./crypto.js";
