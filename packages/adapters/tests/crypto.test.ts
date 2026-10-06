import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, parseEncryptionKey, type EncryptedEnvelope } from "../src/crypto.js";

describe("@mailforge/adapters crypto", () => {
  const validKey = randomBytes(32);
  const validKeyBase64 = validKey.toString("base64");

  describe("encrypt / decrypt roundtrip", () => {
    it("encrypts and decrypts a simple string", () => {
      const plaintext = "hello world";
      const envelope = encrypt(plaintext, validKey);
      const decrypted = decrypt(envelope, validKey);
      expect(decrypted).toBe(plaintext);
    });

    it("encrypts and decrypts a JSON credentials object", () => {
      const creds = JSON.stringify({
        apiKey: "test-key-not-real-0123456789abcdef",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o",
      });
      const envelope = encrypt(creds, validKey);
      const decrypted = decrypt(envelope, validKey);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(creds));
    });

    it("produces different ciphertext each call (random IV)", () => {
      const plaintext = "same input";
      const e1 = encrypt(plaintext, validKey);
      const e2 = encrypt(plaintext, validKey);
      expect(e1).not.toBe(e2);
      // Both decrypt to the same value
      expect(decrypt(e1, validKey)).toBe(plaintext);
      expect(decrypt(e2, validKey)).toBe(plaintext);
    });

    it("handles empty string", () => {
      const plaintext = "";
      const envelope = encrypt(plaintext, validKey);
      expect(decrypt(envelope, validKey)).toBe("");
    });

    it("handles unicode content", () => {
      const plaintext = JSON.stringify({ name: "Test key with special chars" });
      const envelope = encrypt(plaintext, validKey);
      expect(decrypt(envelope, validKey)).toBe(plaintext);
    });
  });

  describe("versioned envelope format", () => {
    it("produces a valid JSON envelope with v=1, alg=aes-256-gcm", () => {
      const envelope = encrypt("test", validKey);
      const parsed = JSON.parse(envelope) as EncryptedEnvelope;
      expect(parsed.v).toBe(1);
      expect(parsed.alg).toBe("aes-256-gcm");
      expect(typeof parsed.iv).toBe("string");
      expect(typeof parsed.tag).toBe("string");
      expect(typeof parsed.data).toBe("string");
      // IV is 12 bytes = 24 hex chars
      expect(parsed.iv.length).toBe(24);
      // Auth tag is 16 bytes = 32 hex chars
      expect(parsed.tag.length).toBe(32);
    });
  });

  describe("error cases", () => {
    it("throws on wrong key (auth tag verification fails)", () => {
      const envelope = encrypt("secret", validKey);
      const wrongKey = randomBytes(32);
      expect(() => decrypt(envelope, wrongKey)).toThrow();
    });

    it("throws on invalid key length (encrypt)", () => {
      expect(() => encrypt("test", Buffer.from("short"))).toThrow(/32-byte/);
    });

    it("throws on invalid key length (decrypt)", () => {
      const envelope = encrypt("test", validKey);
      expect(() => decrypt(envelope, Buffer.from("short"))).toThrow(/32-byte/);
    });

    it("throws on non-JSON envelope", () => {
      expect(() => decrypt("not json", validKey)).toThrow(/not valid JSON/);
    });

    it("throws on invalid envelope shape", () => {
      const bad = JSON.stringify({ v: 2, alg: "other", iv: "", tag: "", data: "" });
      expect(() => decrypt(bad, validKey)).toThrow(/invalid or unsupported/);
    });

    it("throws on tampered ciphertext", () => {
      const envelope = encrypt("secret", validKey);
      const parsed = JSON.parse(envelope) as EncryptedEnvelope;
      // XOR the last byte of the hex-encoded ciphertext with 0x01. This is always
      // a real change: 0x01 XOR any byte != that byte for every possible input, so
      // the tamper can never be a no-op regardless of what the random IV produces.
      const lastByte = parseInt(parsed.data.slice(-2), 16);
      const flippedByte = (lastByte ^ 0x01).toString(16).padStart(2, "0");
      const tampered = parsed.data.slice(0, -2) + flippedByte;
      // Confirm the tamper actually changed the data before calling decrypt.
      // If this assertion fails the test itself is broken, not the production code.
      expect(tampered).not.toBe(parsed.data);
      const bad = JSON.stringify({ ...parsed, data: tampered });
      expect(() => decrypt(bad, validKey)).toThrow();
    });
  });

  describe("parseEncryptionKey", () => {
    it("parses a valid base64-encoded 32-byte key", () => {
      const buf = parseEncryptionKey(validKeyBase64);
      expect(buf.length).toBe(32);
      expect(buf.equals(validKey)).toBe(true);
    });

    it("throws on too-short key", () => {
      const short = randomBytes(16).toString("base64");
      expect(() => parseEncryptionKey(short)).toThrow(/32 bytes/);
    });

    it("throws on too-long key", () => {
      const long = randomBytes(64).toString("base64");
      expect(() => parseEncryptionKey(long)).toThrow(/32 bytes/);
    });
  });
});
