/**
 * Postgres connector, TLS: how it treats the certificates of managed services.
 *
 * Amazon RDS and Supabase sign with their own certificate authority, which is not in Node's trust list, so "verify"
 * needs that CA handed to it (ssl_ca). Neon, Redshift and most others use public CAs and need nothing. These tests run
 * a server that speaks just enough of the Postgres protocol to do the TLS handshake and then refuses the login: an
 * error about the password means the TLS step passed, an error about the certificate means it did not.
 *
 * The certificates in tests/fixtures/tls are throwaway test certificates (a test CA, a server certificate for localhost
 * and 127.0.0.1, and an unrelated CA). They protect nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createPostgresClient } from "../src/warehouse/postgres.js";

const dir = resolve(process.cwd(), "tests/fixtures/tls");
const read = (f: string) => readFileSync(resolve(dir, f), "utf8");
const CA = read("ca.crt");
const OTHER_CA = read("other-ca.crt");

let server: net.Server;
let port = 0;
let sniSeen: Array<string | undefined> = [];

function errorResponse(message: string): Buffer {
  const field = (code: string, text: string) => Buffer.concat([Buffer.from(code), Buffer.from(text + "\0")]);
  const body = Buffer.concat([field("S", "FATAL"), field("C", "28P01"), field("M", message), Buffer.from("\0")]);
  const head = Buffer.alloc(5);
  head.write("E", 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

beforeAll(async () => {
  const context = tls.createSecureContext({ key: read("server.key"), cert: read("server.crt") });
  server = net.createServer((raw) => {
    raw.once("data", (first) => {
      // SSLRequest: length 8, code 80877103. Say yes, then do TLS on the same socket.
      if (first.length === 8 && first.readInt32BE(4) === 80877103) {
        raw.write("S");
        const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: context, SNICallback: (name, cb) => (sniSeen.push(name), cb(null, context)) });
        secure.once("data", () => {
          secure.write(errorResponse("password authentication failed for user \"loomail\""));
          secure.end();
        });
        secure.on("error", () => {});
      } else {
        raw.write(errorResponse("this test server only speaks TLS"));
        raw.end();
      }
    });
    raw.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const policy = { restrict: false, allowedHosts: [] };
const q = { sql: "SELECT 1 AS n", cursor: "", cursorColumn: "n", maxRows: 1, timeoutMs: 5000 };
const connect = (cfg: Record<string, unknown>) =>
  createPostgresClient({ host: "127.0.0.1", port, database: "d", user: "loomail", ssl_mode: "verify", ...cfg } as never, { password: "pw" }, { policy })
    .query(q)
    .then(() => "connected", (e: Error) => e.message);

const certificateProblem = /self[- ]signed|unable to verify|unable to get (local )?issuer|certificate|not in the cert/i;

describe("TLS to a server whose certificate comes from a private CA", () => {
  it("refuses it in verify mode when it does not know the CA", async () => {
    const msg = await connect({});
    expect(msg).toMatch(/Could not connect/);
    expect(msg).toMatch(certificateProblem);
    expect(msg).not.toMatch(/password authentication/);
  });

  it("accepts it in verify mode once given the CA that signed it (the RDS / Supabase case)", async () => {
    expect(await connect({ ssl_ca: CA })).toMatch(/password authentication failed/);
  });

  it("still refuses a certificate the given CA did not sign", async () => {
    const msg = await connect({ ssl_ca: OTHER_CA });
    expect(msg).toMatch(certificateProblem);
    expect(msg).not.toMatch(/password authentication/);
  });

  it("still checks the host name when given the CA", async () => {
    // The certificate is for localhost and 127.0.0.1, not 127.0.0.2.
    const msg = await connect({ host: "127.0.0.2", ssl_ca: CA });
    expect(msg).toMatch(certificateProblem);
    expect(msg).not.toMatch(/password authentication/);
  });

  it("no-verify gets through without a CA, and disable does not speak TLS at all", async () => {
    expect(await connect({ ssl_mode: "no-verify" })).toMatch(/password authentication failed/);
    const plain = await connect({ ssl_mode: "disable" });
    expect(plain).toMatch(/only speaks TLS/);
  });

  it("sends the host name for SNI (Neon routes on it), not the address it connected to", async () => {
    sniSeen = [];
    await connect({ host: "localhost", ssl_ca: CA });
    expect(sniSeen).toContain("localhost");
    sniSeen = [];
    await connect({ host: "127.0.0.1", ssl_ca: CA });
    expect(sniSeen.filter((n) => n)).toEqual([]); // an address is not a name
  });
});
