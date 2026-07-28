/**
 * Unit tests for the doctor comparison functions in doctor-compare.mjs.
 *
 * These tests exercise compareCommits() and compareKeyFingerprints() directly.
 * No mocking: the functions are pure and have no I/O.
 *
 * Coverage:
 *   compareCommits:
 *     - OK when local === deployed
 *     - MISMATCH when local !== deployed (the critical case)
 *     - NO_SHA when deployed is "unknown"
 *     - UNREACHABLE when deployed is null
 *     - GIT_UNAVAILABLE when localHead is "UNKNOWN" and deployed is a real SHA
 *
 *   compareKeyFingerprints:
 *     - OK when fingerprints are identical (strict string equality)
 *     - MISMATCH when fingerprints differ (the critical case)
 *     - LOCAL_ABSENT when local key is absent
 *     - CONTAINER_ABSENT when container key is absent
 *     - SKIPPED when containerInfo is null (no session token)
 *     - LOCAL_DECODE_ERROR when local key could not be decoded
 *     - CONTAINER_DECODE_ERROR when container key could not be decoded
 *     - no false OK on missing fingerprint fields (null !== null is false in JS,
 *       so null fingerprints must never reach the equality check)
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { compareCommits, compareKeyFingerprints } = await import(
  resolve(__dirname, "../bin/doctor-compare.mjs")
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function present(fingerprint, byteLength = 32) {
  return { present: true, byteLength, fingerprint, decodeError: null };
}

function absent() {
  return { present: false, byteLength: null, fingerprint: null, decodeError: null };
}

function decodeErr(msg = "bad encoding") {
  return { present: true, byteLength: null, fingerprint: null, decodeError: msg };
}

const SHA_A = "aabbccdd";
const SHA_B = "11223344";
const COMMIT_A = "aabbccdd" + "0".repeat(32);
const COMMIT_B = "11223344" + "0".repeat(32);

// ---------------------------------------------------------------------------
// compareCommits
// ---------------------------------------------------------------------------

describe("compareCommits", () => {
  it("OK when local HEAD equals deployed commit", () => {
    const r = compareCommits(COMMIT_A, COMMIT_A);
    expect(r.verdict).toBe("OK");
  });

  it("MISMATCH when local HEAD differs from deployed commit", () => {
    const r = compareCommits(COMMIT_A, COMMIT_B);
    expect(r.verdict).toBe("MISMATCH");
    expect(r.localHead).toBe(COMMIT_A);
    expect(r.deployedCommit).toBe(COMMIT_B);
  });

  it("NO_SHA when deployed commit is the string 'unknown'", () => {
    const r = compareCommits(COMMIT_A, "unknown");
    expect(r.verdict).toBe("NO_SHA");
  });

  it("UNREACHABLE when deployed commit is null (fetch failed)", () => {
    const r = compareCommits(COMMIT_A, null);
    expect(r.verdict).toBe("UNREACHABLE");
  });

  it("GIT_UNAVAILABLE when localHead is UNKNOWN and deployed is a real SHA", () => {
    const r = compareCommits("UNKNOWN", COMMIT_B);
    expect(r.verdict).toBe("GIT_UNAVAILABLE");
    expect(r.deployedCommit).toBe(COMMIT_B);
  });

  it("does NOT report OK when localHead is UNKNOWN and deployed is a real SHA", () => {
    // This was the gap: previously no STATUS was printed, which could be read as OK.
    const r = compareCommits("UNKNOWN", COMMIT_B);
    expect(r.verdict).not.toBe("OK");
    expect(r.verdict).not.toBe("MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// compareKeyFingerprints
// ---------------------------------------------------------------------------

describe("compareKeyFingerprints", () => {
  it("OK when local and container have identical fingerprints", () => {
    const r = compareKeyFingerprints(present(SHA_A), present(SHA_A));
    expect(r.verdict).toBe("OK");
  });

  it("MISMATCH when fingerprints differ", () => {
    const r = compareKeyFingerprints(present(SHA_A), present(SHA_B));
    expect(r.verdict).toBe("MISMATCH");
    expect(r.localFingerprint).toBe(SHA_A);
    expect(r.containerFingerprint).toBe(SHA_B);
  });

  it("MISMATCH carries both fingerprints for display", () => {
    const r = compareKeyFingerprints(present("aaaaaaaa"), present("bbbbbbbb"));
    expect(r.verdict).toBe("MISMATCH");
    expect(r.localFingerprint).toBeDefined();
    expect(r.containerFingerprint).toBeDefined();
    expect(r.localFingerprint).not.toBe(r.containerFingerprint);
  });

  it("LOCAL_ABSENT when local key is not present", () => {
    const r = compareKeyFingerprints(absent(), present(SHA_A));
    expect(r.verdict).toBe("LOCAL_ABSENT");
  });

  it("CONTAINER_ABSENT when container key is not present", () => {
    const r = compareKeyFingerprints(present(SHA_A), absent());
    expect(r.verdict).toBe("CONTAINER_ABSENT");
  });

  it("SKIPPED when containerInfo is null (no session token)", () => {
    const r = compareKeyFingerprints(present(SHA_A), null);
    expect(r.verdict).toBe("SKIPPED");
  });

  it("LOCAL_DECODE_ERROR when local key failed to decode", () => {
    const r = compareKeyFingerprints(decodeErr(), present(SHA_A));
    expect(r.verdict).toBe("LOCAL_DECODE_ERROR");
  });

  it("CONTAINER_DECODE_ERROR when container key failed to decode", () => {
    const r = compareKeyFingerprints(present(SHA_A), decodeErr());
    expect(r.verdict).toBe("CONTAINER_DECODE_ERROR");
  });

  it("never returns OK when local fingerprint is null", () => {
    // null === null is true in JS, so a bug could falsely match two null fingerprints.
    // Local absent is caught before the equality check, but decode error also has null.
    const r = compareKeyFingerprints(decodeErr(), decodeErr());
    expect(r.verdict).not.toBe("OK");
  });

  it("never returns OK when both sides are absent", () => {
    const r = compareKeyFingerprints(absent(), absent());
    expect(r.verdict).not.toBe("OK");
  });

  it("never returns MISMATCH when containerInfo is null", () => {
    // Missing container info is SKIPPED, not MISMATCH.
    const r = compareKeyFingerprints(present(SHA_A), null);
    expect(r.verdict).not.toBe("MISMATCH");
  });
});
