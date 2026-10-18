/**
 * SSH tunnels, for databases that are not reachable from the internet.
 *
 * The customer runs (or already has) an SSH server that can reach the database, usually a bastion host. Loomail connects
 * to it, proves who it is with a private key, and asks it to open a connection to the database; everything the database
 * driver says then travels inside the SSH connection. This is `ssh -L` done in-process.
 *
 * Safety rules:
 *   - The SSH server's host key must be pinned: the customer gives its SHA256 fingerprint and any other key is refused.
 *     Without that a machine in the middle could pose as the bastion and read the database password.
 *   - The SSH server's own address goes through the same private-address guard as any customer-typed host (it is the one
 *     address our server connects to). The database address is NOT checked by that guard: it is resolved by the bastion,
 *     on the customer's network, which is the whole point.
 *   - Key-only authentication: no password logins over SSH.
 *   - The tunnel serves exactly one connection, on 127.0.0.1, for the length of one query, and is closed afterwards.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { createHash } from "node:crypto";
import net from "node:net";
import { Client as SshClient } from "ssh2";
import { resolveWarehouseHost, type WarehouseHostPolicy } from "./guard.js";
import { WarehouseError } from "./types.js";

export interface SshTunnelConfig {
  host: string;
  port: number;
  user: string;
  /** SHA256 fingerprint of the SSH server's host key, as `ssh-keygen -lf` prints it: SHA256:abc... */
  host_fingerprint: string;
}

export interface SshTunnelSecret {
  /** PEM or OpenSSH private key. */
  private_key: string;
  passphrase?: string;
}

/** `SHA256:abc...` (padding optional) to the bare base64 without padding, or null when it is not a SHA256 fingerprint. */
export function normalizeFingerprint(fp: string): string | null {
  const m = /^SHA256:([A-Za-z0-9+/]{43})=?$/.exec(fp.trim());
  return m ? m[1]! : null;
}

/** The fingerprint of a raw SSH host key, in the form normalizeFingerprint returns. */
export function fingerprintOf(hostKey: Buffer): string {
  return createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");
}

export interface OpenTunnelOptions {
  policy: WarehouseHostPolicy;
  /** Time allowed to connect, sign in and open the forward. */
  timeoutMs: number;
}

export interface Tunnel {
  /** Connect the database driver to 127.0.0.1 on this port. */
  localPort: number;
  /** Why the SSH server could not open the connection to the database, when it could not (else null). */
  forwardError(): string | null;
  close(): void;
}

const KEY_UNREADABLE =
  "The SSH private key could not be read. Paste the whole key including the BEGIN and END lines, and give its passphrase if it has one (check it is the right passphrase).";
const looksLikeKeyProblem = (message: string) => /Cannot parse privateKey|passphrase|Encrypted private (OpenSSH )?key|Bad passphrase|Unsupported key format/i.test(message);

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return (code ? `${code}: ` : "") + err.message.slice(0, 200);
  }
  return "unknown error";
}

/**
 * Connect to the SSH server and listen on a local port that forwards to `target` through it.
 * Rejects with a WarehouseError whose message says what to check.
 */
export async function openTunnel(
  ssh: SshTunnelConfig,
  secret: SshTunnelSecret,
  target: { host: string; port: number },
  opts: OpenTunnelOptions,
): Promise<Tunnel> {
  const pinned = normalizeFingerprint(ssh.host_fingerprint);
  if (!pinned) throw new WarehouseError("The SSH host fingerprint must look like SHA256:... (what ssh-keygen -lf prints for the server's key).");

  const where = await resolveWarehouseHost(ssh.host, opts.policy);
  if (!where.ok) throw new WarehouseError(`SSH server: ${where.error}`);

  return new Promise<Tunnel>((resolve, reject) => {
    const conn = new SshClient();
    // Our own TCP connection to the SSH server (to the address the guard checked). Owning it means closing is certain:
    // ssh2's end() leaves the socket open while the handshake is still pending.
    const sock = net.connect({ host: where.address, port: ssh.port });
    sock.setNoDelay(true);
    let server: net.Server | null = null;
    let settled = false;
    let hostKeyProblem: string | null = null;
    let forwardProblem: string | null = null;

    const close = () => {
      try {
        server?.close();
      } catch {
        /* already closed */
      }
      try {
        conn.end();
      } catch {
        /* already closed */
      }
      sock.destroy();
    };
    const fail = (message: string, retryable: boolean) => {
      if (settled) return;
      settled = true;
      close();
      reject(new WarehouseError(message, retryable));
    };

    const timer = setTimeout(() => fail(`The SSH server at ${ssh.host} did not answer in time.`, true), opts.timeoutMs);
    timer.unref();

    sock.on("error", (err) => fail(`Could not connect to the SSH server at ${ssh.host}: ${describe(err)}`, true));
    conn.on("error", (err: Error & { level?: string }) => {
      if (hostKeyProblem) return fail(hostKeyProblem, false);
      if (err.level === "client-authentication") {
        return fail(`The SSH server refused the key for user ${ssh.user}. Check the user name, that the matching public key is in that user's authorized_keys, and the key passphrase.`, false);
      }
      if (looksLikeKeyProblem(err.message)) return fail(KEY_UNREADABLE, false);
      fail(`Could not connect to the SSH server at ${ssh.host}: ${describe(err)}`, true);
    });
    conn.on("close", () => {
      clearTimeout(timer);
      if (!settled) fail(`The SSH connection to ${ssh.host} closed before it was ready.`, true);
    });

    conn.on("ready", () => {
      server = net.createServer((socket) => {
        // One connection only: the database driver's. Anything else that finds the port is turned away.
        server?.close();
        conn.forwardOut("127.0.0.1", 0, target.host, target.port, (err, stream) => {
          if (err) {
            forwardProblem = `Connected to the SSH server, but it could not reach ${target.host}:${target.port} (${err.message}). Check the database host and port as the SSH server sees them, and that the server allows port forwarding to it.`;
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          socket.on("close", () => stream.destroy());
          stream.on("close", () => socket.destroy());
          socket.on("error", () => stream.destroy());
          stream.on("error", () => socket.destroy());
        });
      });
      server.on("error", (err) => fail(`Could not open the local end of the tunnel: ${describe(err)}`, true));
      server.listen(0, "127.0.0.1", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ localPort: (server!.address() as net.AddressInfo).port, forwardError: () => forwardProblem, close });
      });
    });

    try {
      conn.connect({
        sock,
        username: ssh.user,
        privateKey: secret.private_key,
        ...(secret.passphrase ? { passphrase: secret.passphrase } : {}),
        // Key only: never offer a password or the keyboard-interactive prompt.
        authHandler: ["publickey"],
        readyTimeout: opts.timeoutMs,
        keepaliveInterval: 15_000,
        // Pin the server: any key but the one fingerprinted is refused.
        hostVerifier: (key: Buffer) => {
          const got = fingerprintOf(key);
          if (got === pinned) return true;
          hostKeyProblem = `The SSH server's host key is not the one you pinned. It is SHA256:${got}. If you did not expect the change, someone may be intercepting the connection; if the server was rebuilt, give the new fingerprint.`;
          return false;
        },
      });
    } catch (err) {
      // ssh2 reads the key inside connect() and throws at once when it cannot.
      fail(looksLikeKeyProblem(err instanceof Error ? err.message : "") ? KEY_UNREADABLE : `The SSH settings are not usable: ${describe(err)}`, false);
    }
  });
}
