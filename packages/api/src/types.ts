/**
 * Shared TypeScript augmentations and types for the API layer.
 */
import type { FastifyRequest } from "fastify";

// ---------------------------------------------------------------------------
// Role system
// ---------------------------------------------------------------------------

/** The two roles in MVP. Order matters: owner > member. */
export type UserRole = "owner" | "member";

/** Numeric weight for comparison. Higher = more privilege. */
const ROLE_WEIGHT: Record<UserRole, number> = { owner: 2, member: 1 };

/** Returns true if `actual` role meets or exceeds `required`. */
export function roleSatisfies(actual: UserRole, required: UserRole): boolean {
  return ROLE_WEIGHT[actual] >= ROLE_WEIGHT[required];
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/**
 * Tenant context attached to every authenticated request.
 * Populated by the tenant resolution plugin.
 * Only present after auth middleware runs; routes that require a tenant
 * must be registered under the authenticated scope.
 */
export interface TenantContext {
  id: string;
  slug: string;
  /** The authenticated user's ID. */
  userId: string;
  /** The authenticated user's role. */
  userRole: UserRole;
  /** The authenticated user's email (used for the platform-admin check). */
  userEmail: string;
  /** True when a platform admin has suspended this workspace. */
  suspended: boolean;
  /** True when the workspace is scheduled for deletion (still inside the grace period). */
  pendingDeletion: boolean;
}

/** A platform admin making a request to the admin console API. */
export interface PlatformAdminActor {
  email: string;
  /** Their user id when they came in through a workspace login; null from the standalone console. */
  id: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the admin routes once the caller is known to be a platform admin. */
    platformAdmin: PlatformAdminActor | null;
    /**
     * Resolved tenant for this request.
     * Null on public/unauthenticated routes (e.g. /health, /unsubscribe).
     * Auth middleware sets this via request.tenant = { id, slug, userId, userRole }.
     */
    tenant: TenantContext | null;
  }
}
