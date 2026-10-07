/**
 * Turns a database "this is not a valid UUID" error into a plain 404.
 *
 * Routes take ids from the URL (/v1/flows/:id, /v1/contacts/:id, ...) and pass them to queries on
 * uuid columns. An id that is not a UUID at all ("undefined", "abc", a typo) makes Postgres refuse
 * the query ("invalid input syntax for type uuid"), which used to surface as a 500 Internal Server
 * Error and a logged stack trace. Such an id cannot match anything, so the honest answer is the same
 * as for an id that does not exist: 404 Not Found.
 *
 * Done once here rather than per route because not every :id is a UUID (business-model templates are
 * looked up by name), so a blanket "ids must be UUIDs" rule would break routes that work today.
 * Only this one Postgres error is translated; every other error takes Fastify's usual path, so real
 * failures are still 500s and still logged.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyInstance } from "fastify";

/** Postgres SQLSTATE 22P02: invalid_text_representation. */
const INVALID_TEXT_REPRESENTATION = "22P02";

/** True for the Postgres error raised when a value is not a valid uuid, however deeply it is wrapped. */
export function isInvalidUuidError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === INVALID_TEXT_REPRESENTATION && typeof e.message === "string" && /type uuid/i.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}

/** Register the translation on an app (and so on every route registered under it). */
export function installDbErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (isInvalidUuidError(error)) {
      request.log.info({ url: request.url }, "request used an id that is not a valid UUID: 404");
      return reply.status(404).send({ error: "Not found" });
    }
    // Everything else: Fastify's own handling (status from the error, logging of 5xx).
    return reply.send(error);
  });
}
