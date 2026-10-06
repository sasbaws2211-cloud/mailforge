/**
 * A software WebAuthn authenticator for tests: it makes real key pairs and builds the
 * same byte-level messages a phone or laptop would (CBOR attestation object, authenticator
 * data, ES256 signatures), so the server's genuine verification runs against them. Options
 * let a test produce the faulty and hostile variants: wrong origin, wrong site, no user
 * verification, a counter that goes backwards, a tampered signature.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64 = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | Buffer | string) => createHash("sha256").update(b).digest();

// ---- the smallest CBOR encoder that does the job -------------------------------------
type Cbor = number | string | Uint8Array | Buffer | Cbor[] | Map<Cbor, Cbor>;
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

export interface Faults {
  /** Report this origin instead of the real one. */
  origin?: string;
  /** Bind to this site name instead of the real one. */
  rpId?: string;
  /** Do not set the user-verified flag (a bare tap, no PIN or biometric). */
  noUserVerification?: boolean;
  /** Do not set the user-present flag. */
  noUserPresence?: boolean;
  /** Report this signature counter. */
  counter?: number;
  /** Flip a byte of the signature. */
  tamperSignature?: boolean;
  /** Sign with a different key than the registered one. */
  wrongKey?: boolean;
  /** Answer a different challenge than the one the server issued. */
  challenge?: string;
  /** Use this client-data type instead of the correct one. */
  type?: string;
}

export class VirtualAuthenticator {
  readonly credentialId = randomBytes(32);
  private privateKey: KeyObject;
  private publicJwk: { x: string; y: string };
  /** The user handle the server gave at registration, echoed back at sign-in. */
  userHandle: string | undefined;
  counter = 0;

  constructor(
    private readonly origin: string,
    private readonly rpId: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.publicJwk = jwk;
  }

  get id(): string {
    return b64(this.credentialId);
  }

  private coseKey(): Buffer {
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(this.publicJwk.x, "base64url")],
        [-3, Buffer.from(this.publicJwk.y, "base64url")],
      ]),
    );
  }

  private flags(f: Faults, attested: boolean): number {
    let flags = 0;
    if (!f.noUserPresence) flags |= 0x01;
    if (!f.noUserVerification) flags |= 0x04;
    if (attested) flags |= 0x40;
    return flags;
  }

  private counterBytes(f: Faults): Buffer {
    const c = f.counter ?? this.counter;
    const b = Buffer.alloc(4);
    b.writeUInt32BE(c);
    return b;
  }

  /** What navigator.credentials.create() would return for the options the server sent. */
  create(options: { challenge: string; user: { id: string } }, f: Faults = {}) {
    this.userHandle = options.user.id;
    const rpHash = sha256(f.rpId ?? this.rpId);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([rpHash, Buffer.from([this.flags(f, true)]), this.counterBytes(f), Buffer.alloc(16), credLen, this.credentialId, this.coseKey()]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: f.type ?? "webauthn.create", challenge: f.challenge ?? options.challenge, origin: f.origin ?? this.origin, crossOrigin: false }));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }

  /** What navigator.credentials.get() would return. Advances the counter unless told otherwise. */
  get(options: { challenge: string }, f: Faults = {}) {
    if (f.counter === undefined) this.counter += 1;
    const authData = Buffer.concat([sha256(f.rpId ?? this.rpId), Buffer.from([this.flags(f, false)]), this.counterBytes(f)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: f.type ?? "webauthn.get", challenge: f.challenge ?? options.challenge, origin: f.origin ?? this.origin, crossOrigin: false }));
    const key = f.wrongKey ? generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey : this.privateKey;
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), key);
    if (f.tamperSignature) signature[signature.length - 1] = signature[signature.length - 1]! ^ 0xff;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authData), signature: b64(signature), userHandle: this.userHandle },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }
}
