/**
 * Edition loader - dynamic binding of private packages behind LOOMAIL_EDITION.
 *
 * This is the ONLY place where private packages are loaded.
 * The non-literal specifier defeats static resolution so bundlers/typecheckers
 * in community mode never see the private packages.
 */
import { createOssBrain } from "@loomail/brain-oss";
import type { Brain, BrainConfig } from "@loomail/brain-oss";

const EDITION = process.env.LOOMAIL_EDITION ?? "community";

export async function loadBrain(cfg: BrainConfig): Promise<Brain> {
  if (EDITION === "cloud") {
    const pkg = "@loomail/" + "brain-cloud"; // defeats static resolution
    const mod = await import(pkg);
    return mod.createBrain(cfg);
  }
  return createOssBrain(cfg);
}

// billing: same pattern, registered as an optional Fastify plugin
export async function loadBilling(): Promise<unknown> {
  if (EDITION === "cloud") {
    const pkg = "@loomail/" + "billing"; // defeats static resolution
    const mod = await import(pkg);
    return mod;
  }
  return null;
}

export { EDITION };
