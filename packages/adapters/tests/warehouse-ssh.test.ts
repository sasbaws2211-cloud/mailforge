/**
 * SSH tunnels for databases that are not on the internet.
 *
 * An in-process SSH server stands in for the customer's bastion: it checks keys for real, allows forwarding only to the
 * addresses the test lists (and connects them to a real target), and records what it saw. The "database" behind it is the
 * test Postgres when DATABASE_URL is set, so a real query goes through a real tunnel.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import ssh2 from "ssh2";
import { createPostgresClient } from "../src/warehouse/postgres.js";
import { fingerprintOf, normalizeFingerprint, openTunnel } from "../src/warehouse/ssh-tunnel.js";
import { WarehouseError } from "../src/warehouse/types.js";
import { HOST_FP, clientKey, fpOf, hostKey, lockedKey, otherHostKey, rsaClientKey, startBastion, strangerKey, type Bastion } from "./helpers/ssh-bastion.js";

const { utils } = ssh2;

const policy = { restrict: false, allowedHosts: [] as string[] };
const ssh = (b: Bastion, over: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port: b.port, user: "tunnel", host_fingerprint: HOST_FP, ...over });
const open = (b: Bastion, key = clientKey.private, target = { host: "db.internal", port: 5432 }, over: Record<string, unknown> = {}, secretOver: Record<string, unknown> = {}) =>
  openTunnel(ssh(b, over), { private_key: key, ...secretOver }, target, { policy, timeoutMs: 5000 });
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as WarehouseError);

describe("fingerprints", () => {
  it("accepts what ssh-keygen prints, with or without padding, and refuses the rest", () => {
    const bare = HOST_FP.slice("SHA256:".length);
    expect(normalizeFingerprint(HOST_FP)).toBe(bare);
    expect(normalizeFingerprint(`  ${HOST_FP}= `)).toBe(bare);
    for (const bad of ["", "SHA256:short", "MD5:aa:bb", bare, "SHA256:" + "!".repeat(43), "sha256:" + bare]) expect(normalizeFingerprint(bad), bad).toBeNull();
  });
  it("matches the fingerprint of the server's real key", () => {
    const k = utils.parseKey(hostKey.public);
    if (k instanceof Error) throw k;
    expect("SHA256:" + fingerprintOf(k.getPublicSSH())).toBe(HOST_FP);
  });
});

describe("the tunnel", () => {
  let echo: net.Server;
  let echoPort = 0;
  beforeAll(async () => {
    echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    echoPort = (echo.address() as AddressInfo).port;
  });
  afterAll(() => new Promise((r) => echo.close(r)));

  const roundTrip = (port: number) =>
    new Promise<string>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("hello through ssh"));
      s.once("data", (d) => {
        s.destroy();
        resolve(d.toString());
      });
      s.once("error", reject);
      s.once("close", () => reject(new Error("closed without an answer")));
    });

  it("carries bytes to an address only the SSH server knows, and listens on loopback only", async () => {
    const b = await startBastion({ allow: [clientKey.public] });
    b.routes.set("db.internal:5432", { host: "127.0.0.1", port: echoPort });
    const t = await open(b);
    try {
      expect(await roundTrip(t.localPort)).toBe("hello through ssh");
      expect(b.forwards).toEqual(["db.internal:5432"]); // the name went to the bastion; our side never resolved it
    } finally {
      t.close();
      await b.stop();
    }
  });

  it("works with an RSA key, and with a passphrase-protected key", async () => {
    const b = await startBastion({ allow: [rsaClientKey.public, lockedKey.public] });
    b.routes.set("db.internal:5432", { host: "127.0.0.1", port: echoPort });
    const rsa = await open(b, rsaClientKey.private);
    expect(await roundTrip(rsa.localPort)).toBe("hello through ssh");
    rsa.close();
    const locked = await open(b, lockedKey.private, undefined, {}, { passphrase: "correct horse" });
    expect(await roundTrip(locked.localPort)).toBe("hello through ssh");
    locked.close();
    await b.stop();
  });

  it("serves one connection, then closes the local port and the SSH connection", async () => {
    const b = await startBastion({ allow: [clientKey.public] });
    b.routes.set("db.internal:5432", { host: "127.0.0.1", port: echoPort });
    const t = await open(b);
    expect(await roundTrip(t.localPort)).toBe("hello through ssh");
    // the one connection has been used: a second visitor is refused
    await expect(roundTrip(t.localPort)).rejects.toBeDefined();
    t.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(b.closed).toBe(1);
    await expect(roundTrip(t.localPort)).rejects.toBeDefined();
    await b.stop();
  });

  it("refuses a server whose host key is not the pinned one, and says what it saw", async () => {
    const b = await startBastion({ allow: [clientKey.public], hostKeyPrivate: otherHostKey.private });
    const e = await failure(open(b));
    expect(e).toBeInstanceOf(WarehouseError);
    expect(e!.message).toMatch(/not the one you pinned/);
    expect(e!.message).toContain(fpOf(otherHostKey.public));
    expect(e!.retryable).toBe(false);
    expect(b.seenAuth).toEqual([]); // it never got as far as offering a key
    await b.stop();
  });

  it("refuses a badly written fingerprint before connecting at all", async () => {
    const b = await startBastion({ allow: [clientKey.public] });
    const e = await failure(open(b, clientKey.private, undefined, { host_fingerprint: "SHA256:nope" }));
    expect(e!.message).toMatch(/SHA256:/);
    expect(b.seenAuth).toEqual([]);
    await b.stop();
  });

  it("says plainly when the key is not accepted, or cannot be read", async () => {
    const b = await startBastion({ allow: [clientKey.public] });
    const stranger = await failure(open(b, strangerKey.private));
    expect(stranger!.message).toMatch(/refused the key for user tunnel/);
    expect(stranger!.retryable).toBe(false);
    const junk = await failure(open(b, "not a key"));
    expect(junk!.message).toMatch(/private key could not be read/);
    const noPass = await failure(open(b, lockedKey.private));
    expect(noPass!.message).toMatch(/private key could not be read/);
    const wrongPass = await failure(open(b, lockedKey.private, undefined, {}, { passphrase: "wrong" }));
    expect(wrongPass!.message).toMatch(/private key could not be read/);
    await b.stop();
  });

  it("only ever offers a key, never a password", async () => {
    const b = await startBastion({ allow: [], passwordOnly: true });
    const e = await failure(open(b));
    expect(e!.message).toMatch(/refused the key/);
    expect(b.seenAuth).not.toContain("password");
    await b.stop();
  });

  it("reports a destination the SSH server cannot reach, not a mysterious driver error", async () => {
    const b = await startBastion({ allow: [clientKey.public] });
    const t = await open(b, clientKey.private, { host: "db.internal", port: 9999 });
    await expect(roundTrip(t.localPort)).rejects.toBeDefined();
    expect(t.forwardError()).toMatch(/could not reach db\.internal:9999/);
    t.close();
    await b.stop();
  });

  it("treats an unreachable SSH server as a network problem worth retrying", async () => {
    const dead = await new Promise<number>((r) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => r(p));
      });
    });
    const e = await failure(openTunnel({ host: "127.0.0.1", port: dead, user: "u", host_fingerprint: HOST_FP }, { private_key: clientKey.private }, { host: "db", port: 5432 }, { policy, timeoutMs: 2000 }));
    expect(e!.message).toMatch(/Could not connect to the SSH server/);
    expect(e!.retryable).toBe(true);
  });

  it("gives up on a server that never answers, and does not leave the connection open", async () => {
    let opened = 0;
    let closed = 0;
    const silent = net.createServer((sock) => {
      opened++;
      sock.on("close", () => closed++);
      sock.resume(); // read (and ignore) what the client sends, so its closing is noticed
    });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const e = await failure(openTunnel({ host: "127.0.0.1", port: (silent.address() as AddressInfo).port, user: "u", host_fingerprint: HOST_FP }, { private_key: clientKey.private }, { host: "db", port: 5432 }, { policy, timeoutMs: 400 }));
    expect(e!.message).toMatch(/did not answer in time/);
    expect(e!.retryable).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect([opened, closed]).toEqual([1, 1]);
    await new Promise((r) => silent.close(r));
  });

  it("applies the private-address guard to the SSH server, not to the database behind it", async () => {
    const hosted = { restrict: true, allowedHosts: [] as string[] };
    const e = await failure(openTunnel({ host: "127.0.0.1", port: 22, user: "u", host_fingerprint: HOST_FP }, { private_key: clientKey.private }, { host: "10.0.0.5", port: 5432 }, { policy: hosted, timeoutMs: 1000 }));
    expect(e!.message).toMatch(/^SSH server: .*not allowed/);
    // a bastion on an operator-trusted address may be used, and a private database address behind it is fine
    const b = await startBastion({ allow: [clientKey.public] });
    b.routes.set("10.0.0.5:5432", { host: "127.0.0.1", port: echoPort });
    const t = await openTunnel(ssh(b), { private_key: clientKey.private }, { host: "10.0.0.5", port: 5432 }, { policy: { restrict: true, allowedHosts: ["127.0.0.1"] }, timeoutMs: 3000 });
    expect(await roundTrip(t.localPort)).toBe("hello through ssh");
    t.close();
    await b.stop();
  });
});

const dbUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const withDb = dbUrl ? describe : describe.skip;

withDb("Postgres through a tunnel (a real database)", () => {
  const admin = dbUrl ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : (null as never);
  let b: Bastion;
  const q = { sql: "SELECT id, email, plan, updated_at FROM wh_ssh_users WHERE updated_at >= :cursor::timestamptz", cursor: "1970-01-01T00:00:00.000Z", cursorColumn: "updated_at", maxRows: 100, timeoutMs: 8000 };

  beforeAll(async () => {
    await admin.query("DROP TABLE IF EXISTS wh_ssh_users");
    await admin.query("CREATE TABLE wh_ssh_users (id int, email text, plan text, updated_at timestamptz)");
    await admin.query("INSERT INTO wh_ssh_users VALUES (1,'a@x.test','pro','2026-01-01T00:00:00Z'),(2,'b@x.test','free','2026-01-02T00:00:00Z')");
    b = await startBastion({ allow: [clientKey.public] });
    // "the private database" is only a name the bastion knows
    b.routes.set("private-db.corp.internal:5432", { host: dbUrl!.hostname, port: Number(dbUrl!.port || 5432) });
  });
  afterAll(async () => {
    await admin.query("DROP TABLE IF EXISTS wh_ssh_users");
    await admin.end();
    await b.stop();
  });

  const client = (over: Record<string, unknown> = {}, secretOver: Record<string, unknown> = {}) =>
    createPostgresClient(
      {
        host: "private-db.corp.internal",
        port: 5432,
        database: decodeURIComponent(dbUrl!.pathname.slice(1)),
        user: decodeURIComponent(dbUrl!.username),
        ssl_mode: "disable",
        ssh: ssh(b),
        ...over,
      } as never,
      { password: decodeURIComponent(dbUrl!.password), ssh_private_key: clientKey.private, ...secretOver },
      { policy },
    );

  it("runs a real query to a database whose name only the SSH server can resolve", async () => {
    const out = await client().query(q);
    expect(out.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(out.rows[0]).toMatchObject({ email: "a@x.test", plan: "pro", updated_at: "2026-01-01T00:00:00.000Z" });
    expect(b.forwards).toContain("private-db.corp.internal:5432");
  });

  it("closes the tunnel when the query is done, every time", async () => {
    await new Promise((r) => setTimeout(r, 300)); // earlier tests' connections finish closing
    const before = b.closed;
    await client().query(q);
    await client().query(q);
    await new Promise((r) => setTimeout(r, 150));
    expect(b.closed).toBe(before + 2);
  });

  it("closes the tunnel even when the query fails", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const before = b.closed;
    await expect(client().query({ ...q, sql: "SELECT nope FROM wh_ssh_users" })).rejects.toThrow(/query failed/);
    await new Promise((r) => setTimeout(r, 150));
    expect(b.closed).toBe(before + 1);
  });

  it("is still read-only through the tunnel", async () => {
    await admin.query("CREATE OR REPLACE FUNCTION wh_ssh_sneaky() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ INSERT INTO wh_ssh_users(id) VALUES (99) RETURNING now() $$");
    await expect(client().query({ ...q, sql: "SELECT wh_ssh_sneaky() AS updated_at" })).rejects.toThrow(/read-only transaction/);
    await admin.query("DROP FUNCTION wh_ssh_sneaky()");
    expect((await admin.query("SELECT count(*)::int AS n FROM wh_ssh_users")).rows[0].n).toBe(2);
  });

  it("names the real problem when the database address is wrong as the SSH server sees it", async () => {
    const e = await failure(client({ host: "no-such-db.corp.internal" }).query(q));
    expect(e!.message).toMatch(/could not reach no-such-db\.corp\.internal:5432/);
  });

  it("a wrong database password is a database error, not an SSH one", async () => {
    const e = await failure(client({}, { password: "nope" }).query(q));
    expect(e!.message).toMatch(/Could not connect to the database/);
  });

  it("needs the SSH key when a tunnel is configured", async () => {
    const e = await failure(client({}, { ssh_private_key: undefined }).query(q));
    expect(e!.message).toMatch(/needs its private key/);
  });
});
