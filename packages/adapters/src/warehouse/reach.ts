/**
 * Getting from our server to a customer's database: directly (through the private-address guard) or through an SSH
 * tunnel. Shared by every connector that takes a host and port (Postgres, MySQL, SQL Server).
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { resolveWarehouseHost, type WarehouseHostPolicy } from "./guard.js";
import { openTunnel, type SshTunnelConfig, type Tunnel } from "./ssh-tunnel.js";
import { WarehouseError } from "./types.js";

/** The settings every host-and-port database shares. */
export interface NetworkDbConfig {
  host: string;
  port: number;
  /**
   * Reach the database through this SSH server. `host` and `port` are then the database's address as the SSH server
   * sees it (often a private name or address), not something our server connects to.
   */
  ssh?: SshTunnelConfig;
}

/** The credential part the network layer needs. */
export interface NetworkDbSecret {
  /** The private key for the SSH tunnel, when `ssh` is set. */
  ssh_private_key?: string;
  ssh_passphrase?: string;
}

export interface Reached {
  /** Where the driver connects. */
  host: string;
  port: number;
  /** The name the server's certificate must match: always the host the customer typed, tunnel or not. */
  identity: string;
  /** Close it when the query is done. */
  tunnel: Tunnel | null;
}

/** Open the route to the database. Rejects with a WarehouseError that says what to check. */
export async function reachDatabase(
  config: NetworkDbConfig,
  secret: NetworkDbSecret,
  policy: WarehouseHostPolicy,
  timeoutMs: number,
): Promise<Reached> {
  if (config.ssh) {
    if (!secret.ssh_private_key) throw new WarehouseError("The SSH tunnel needs its private key.");
    // The guard applies to the SSH server (inside openTunnel), not to the database, which the SSH server resolves.
    const tunnel = await openTunnel(
      config.ssh,
      { private_key: secret.ssh_private_key, ...(secret.ssh_passphrase ? { passphrase: secret.ssh_passphrase } : {}) },
      { host: config.host, port: config.port },
      { policy, timeoutMs: Math.min(timeoutMs, 15_000) },
    );
    return { host: "127.0.0.1", port: tunnel.localPort, identity: config.host, tunnel };
  }
  const target = await resolveWarehouseHost(config.host, policy);
  if (!target.ok) throw new WarehouseError(target.error);
  return { host: target.address.replace(/^\[|\]$/g, ""), port: config.port, identity: config.host, tunnel: null };
}
