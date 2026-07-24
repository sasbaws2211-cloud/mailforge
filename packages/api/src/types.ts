/**
 * Shared TypeScript augmentations and types for the API layer.
 */
import type { FastifyRequest } from "fastify";

/**
 * Tenant context attached to every authenticated request.
 * Populated by the tenant resolution plugin (task 3 - auth).
 * Only present after auth middleware runs; routes that require a tenant
 * must be registered under the authenticated scope.
 */
export interface TenantContext {
  id: string;
  slug: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Resolved tenant for this request.
     * Null on public/unauthenticated routes (e.g. /health, /unsubscribe).
     * Auth middleware (task 3) sets this via request.tenant = { id, slug }.
     */
    tenant: TenantContext | null;
  }
}
