/**
 * RS256 JSON Web Tokens signed with a private key the customer gave us. Snowflake (key-pair authentication) and
 * Google (service-account sign-in) both use them. Node's own crypto does the work, so there is no dependency.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Read a PEM private key (PKCS#8 or PKCS#1, optionally encrypted). Throws a message safe to show. */
export function readPrivateKey(pem: string, passphrase?: string): KeyObject {
  try {
    return createPrivateKey({ key: pem.replace(/\\n/g, "\n"), ...(passphrase ? { passphrase } : {}) });
  } catch {
    throw new Error("The private key could not be read. Paste the whole PEM text, including the BEGIN and END lines" + (passphrase ? ", and check the passphrase." : "."));
  }
}

export function signJwtRS256(claims: Record<string, unknown>, key: KeyObject, header: Record<string, unknown> = {}): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...header }));
  const body = b64url(JSON.stringify(claims));
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Snowflake's key fingerprint: SHA256: + base64 of the SHA-256 of the DER public key. */
export function publicKeyFingerprint(key: KeyObject): string {
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}
