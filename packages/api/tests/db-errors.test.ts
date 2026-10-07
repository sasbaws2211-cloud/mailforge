/**
 * An id in a URL that is not a UUID must answer 404, not 500, while every other error keeps
 * behaving as before. No database: the Postgres errors are built by hand, in the shapes the
 * driver and drizzle produce.
 */
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { installDbErrorHandler, isInvalidUuidError } from "../src/db-errors.js";

/** What node-postgres throws for a bad uuid. */
const pgUuidError = (): Error =>
  Object.assign(new Error('invalid input syntax for type uuid: "undefined"'), { code: "22P02", severity: "ERROR" });

/** What drizzle throws: a "Failed query" error with the driver error as its cause. */
const drizzleWrapped = (cause: Error): Error => Object.assign(new Error('Failed query: select "id" from "flows" where "id" = $1'), { cause });

describe("isInvalidUuidError", () => {
  it("recognises the driver error, and the same error wrapped by drizzle (one or more levels)", () => {
    expect(isInvalidUuidError(pgUuidError())).toBe(true);
    expect(isInvalidUuidError(drizzleWrapped(pgUuidError()))).toBe(true);
    expect(isInvalidUuidError(drizzleWrapped(drizzleWrapped(pgUuidError())))).toBe(true);
  });

  it("does not claim other Postgres errors, even with the same code for another type", () => {
    const badInteger = Object.assign(new Error('invalid input syntax for type integer: "abc"'), { code: "22P02" });
    const badEnum = Object.assign(new Error('invalid input value for enum plan: "x"'), { code: "22P02" });
    const notFoundColumn = Object.assign(new Error('column "x" does not exist'), { code: "42703" });
    const uuidWrongCode = Object.assign(new Error("something about type uuid"), { code: "23505" });
    for (const e of [badInteger, badEnum, notFoundColumn, uuidWrongCode, drizzleWrapped(badInteger)]) expect(isInvalidUuidError(e)).toBe(false);
  });

  it("is false for anything that is not an error object, and cannot loop on a cycle", () => {
    for (const v of [undefined, null, "22P02 type uuid", 5, {}, new Error("plain")]) expect(isInvalidUuidError(v)).toBe(false);
    const a: { cause?: unknown; message: string } = { message: "a" };
    a.cause = a;
    expect(isInvalidUuidError(a)).toBe(false);
  });
});

describe("installDbErrorHandler", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  async function build(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    installDbErrorHandler(app);
    // Routes in a child plugin, as the real ones are, so inheritance is part of what is tested.
    await app.register(async (child) => {
      child.get("/bad-uuid", async () => {
        throw drizzleWrapped(pgUuidError());
      });
      child.get("/bad-integer", async () => {
        throw drizzleWrapped(Object.assign(new Error('invalid input syntax for type integer: "x"'), { code: "22P02" }));
      });
      child.get("/boom", async () => {
        throw new Error("database exploded");
      });
      child.get("/teapot", async () => {
        throw Object.assign(new Error("short and stout"), { statusCode: 418 });
      });
      child.get("/ok", async () => ({ ok: true }));
      child.post("/json", async (req) => req.body);
    });
    apps.push(app);
    return app;
  }

  it("answers 404 with a plain body for an invalid id, and does not leak the SQL", async () => {
    const app = await build();
    const res = await app.inject({ url: "/bad-uuid" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
    expect(res.body).not.toMatch(/select|Failed query|uuid/i);
  });

  it("every other error is untouched: a real failure is still a 500", async () => {
    const app = await build();
    const boom = await app.inject({ url: "/boom" });
    expect(boom.statusCode).toBe(500);
    const integer = await app.inject({ url: "/bad-integer" });
    expect(integer.statusCode).toBe(500);
  });

  it("errors that carry their own status keep it", async () => {
    const app = await build();
    expect((await app.inject({ url: "/teapot" })).statusCode).toBe(418);
  });

  it("a malformed JSON body is still a 400, and normal requests are unaffected", async () => {
    const app = await build();
    const bad = await app.inject({ method: "POST", url: "/json", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ url: "/ok" })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "POST", url: "/json", headers: { "content-type": "application/json" }, payload: '{"a":1}' })).json()).toEqual({ a: 1 });
  });

  it("an unknown route is still the ordinary 404", async () => {
    const app = await build();
    expect((await app.inject({ url: "/nope" })).statusCode).toBe(404);
  });
});
