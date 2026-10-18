/**
 * An in-process SSH server that stands in for a customer's bastion: it checks keys for real, forwards only to addresses
 * a test lists, and records what it saw. Shared by the tunnel tests for every database.
 */
import net from "node:net";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;

export const hostKey = utils.generateKeyPairSync("ed25519");
export const otherHostKey = utils.generateKeyPairSync("ed25519");
export const clientKey = utils.generateKeyPairSync("ed25519");
export const rsaClientKey = utils.generateKeyPairSync("rsa", { bits: 2048 });
export const lockedKey = utils.generateKeyPairSync("ed25519", { passphrase: "correct horse", cipher: "aes256-ctr", rounds: 16 });
export const strangerKey = utils.generateKeyPairSync("ed25519");

export const fpOf = (publicKey: string) => {
  const k = utils.parseKey(publicKey);
  if (k instanceof Error) throw k;
  return "SHA256:" + createHash("sha256").update(k.getPublicSSH()).digest("base64").replace(/=+$/, "");
};
export const HOST_FP = fpOf(hostKey.public);

export interface Bastion {
  port: number;
  /** destination "name:port" the bastion will open -> the real address to connect it to */
  routes: Map<string, { host: string; port: number }>;
  seenAuth: string[];
  forwards: string[];
  closed: number;
  stop(): Promise<void>;
}

export async function startBastion(opts: { hostKeyPrivate?: string; allow: string[]; passwordOnly?: boolean }): Promise<Bastion> {
  const allowed = opts.allow.map((p) => {
    const k = utils.parseKey(p);
    if (k instanceof Error) throw k;
    return k;
  });
  const b: Bastion = { port: 0, routes: new Map(), seenAuth: [], forwards: [], closed: 0, stop: async () => {} };
  const conns = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [opts.hostKeyPrivate ?? hostKey.private] }, (client) => {
    client.on("authentication", (ctx) => {
      b.seenAuth.push(ctx.method);
      if (opts.passwordOnly) return ctx.method === "password" ? ctx.accept() : ctx.reject(["password"]);
      if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
      const match = allowed.find((k) => k.type === ctx.key.algo && Buffer.compare(k.getPublicSSH(), ctx.key.data) === 0);
      if (!match) return ctx.reject(["publickey"]);
      if (ctx.signature && ctx.blob && match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        const dest = `${info.destIP}:${info.destPort}`;
        b.forwards.push(dest);
        const route = b.routes.get(dest);
        if (!route) return reject();
        const sock = net.connect(route.port, route.host);
        sock.once("connect", () => {
          const channel = accept();
          channel.pipe(sock).pipe(channel);
          channel.on("close", () => sock.destroy());
          sock.on("close", () => channel.destroy());
        });
        sock.once("error", () => reject());
      });
    });
    client.on("close", () => b.closed++);
    client.on("error", () => {});
  });
  server.on("connection", (c) => {
    conns.add(c as unknown as { end(): void });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  b.port = (server.address() as AddressInfo).port;
  b.stop = () =>
    new Promise<void>((r) => {
      for (const c of conns) c.end();
      server.close(() => r());
      setTimeout(r, 300).unref(); // do not wait on sockets the other side has already abandoned
    });
  return b;
}
