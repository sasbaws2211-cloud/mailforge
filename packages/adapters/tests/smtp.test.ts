/**
 * Unit tests for the SMTP transport adapter.
 *
 * No real SMTP connections. Nodemailer's sendMail and verify are mocked.
 *
 * Coverage:
 *   - Successful send returns provider message ID
 *   - Permanent failure (5xx SMTP response) marks permanent=true
 *   - Transient failure (4xx SMTP response) marks permanent=false
 *   - Network error returns transient failure
 *   - verify() success path
 *   - verify() failure path
 *   - Credentials do NOT appear in any error message
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TransportSendParams } from "../src/transport-types.js";

// ---------------------------------------------------------------------------
// Mock nodemailer before importing the adapter
// ---------------------------------------------------------------------------

const mockSendMail = vi.fn();
const mockVerify = vi.fn();
const mockClose = vi.fn();

vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({
    sendMail: mockSendMail,
    verify: mockVerify,
    close: mockClose,
  })),
}));

// Import after mock
import { SmtpTransportAdapter } from "../src/smtp.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PASSWORD = "super_secret_smtp_pass_123";

function makeConfig() {
  return {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "user@example.com",
    password: TEST_PASSWORD,
  };
}

function makeParams(overrides: Partial<TransportSendParams> = {}): TransportSendParams {
  return {
    to: "recipient@example.com",
    from: "noreply@example.com",
    fromName: "Claros",
    subject: "Test subject",
    bodyHtml: "<p>Test body HTML</p>",
    bodyText: "Test body text",
    messageId: "00000000-0000-0000-0000-000000000001",
    headers: {
      "List-Unsubscribe": "<https://mail.example.com/unsubscribe/one-click?token=test>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SmtpTransportAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Successful send
  // -------------------------------------------------------------------------

  describe("successful send", () => {
    it("returns success=true and the server-assigned message ID", async () => {
      mockSendMail.mockResolvedValue({
        messageId: "<abc123@smtp.example.com>",
        response: "250 2.0.0 OK",
      });

      const adapter = new SmtpTransportAdapter(makeConfig());
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(true);
      expect(result.providerMessageId).toBe("<abc123@smtp.example.com>");
      expect(result.error).toBeUndefined();
      expect(result.permanent).toBeUndefined();
    });

    it("passes from with display name when fromName is provided", async () => {
      mockSendMail.mockResolvedValue({ messageId: "<x@y>", response: "250 OK" });

      const adapter = new SmtpTransportAdapter(makeConfig());
      await adapter.send(makeParams({ fromName: "Notifications", from: "no-reply@example.com" }));

      const call = mockSendMail.mock.calls[0]![0];
      expect(call.from).toBe("Notifications <no-reply@example.com>");
    });

    it("uses plain from address when fromName is not provided", async () => {
      mockSendMail.mockResolvedValue({ messageId: "<x@y>", response: "250 OK" });

      const adapter = new SmtpTransportAdapter(makeConfig());
      await adapter.send(makeParams({ fromName: undefined, from: "no-reply@example.com" }));

      const call = mockSendMail.mock.calls[0]![0];
      expect(call.from).toBe("no-reply@example.com");
    });

    it("sets messageId as the SMTP Message-ID header", async () => {
      mockSendMail.mockResolvedValue({ messageId: "<x@y>", response: "250 OK" });

      const messageId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const adapter = new SmtpTransportAdapter(makeConfig());
      await adapter.send(makeParams({ messageId }));

      const call = mockSendMail.mock.calls[0]![0];
      expect(call.messageId).toBe(`${messageId}@claros`);
    });
  });

  // -------------------------------------------------------------------------
  // Permanent failures (5xx)
  // -------------------------------------------------------------------------

  describe("permanent failures", () => {
    const permanentCases = [
      { code: 550, description: "mailbox not found" },
      { code: 553, description: "invalid sender" },
      { code: 554, description: "message refused" },
      { code: 535, description: "authentication failed" },
    ];

    for (const { code, description } of permanentCases) {
      it(`returns permanent=true for SMTP ${code} (${description})`, async () => {
        const error = Object.assign(new Error(`${code} ${description}`), {
          responseCode: code,
        });
        mockSendMail.mockRejectedValue(error);

        const adapter = new SmtpTransportAdapter(makeConfig());
        const result = await adapter.send(makeParams());

        expect(result.success).toBe(false);
        expect(result.permanent).toBe(true);
        expect(result.error).toContain(String(code));
      });
    }
  });

  // -------------------------------------------------------------------------
  // Transient failures (4xx)
  // -------------------------------------------------------------------------

  describe("transient failures", () => {
    const transientCases = [
      { code: 421, description: "service not available" },
      { code: 450, description: "mailbox unavailable (greylisting)" },
      { code: 451, description: "local error in processing" },
      { code: 452, description: "insufficient system storage" },
    ];

    for (const { code, description } of transientCases) {
      it(`returns permanent=false for SMTP ${code} (${description})`, async () => {
        const error = Object.assign(new Error(`${code} ${description}`), {
          responseCode: code,
        });
        mockSendMail.mockRejectedValue(error);

        const adapter = new SmtpTransportAdapter(makeConfig());
        const result = await adapter.send(makeParams());

        expect(result.success).toBe(false);
        expect(result.permanent).toBe(false);
        expect(result.error).toContain(String(code));
      });
    }
  });

  // -------------------------------------------------------------------------
  // Network errors
  // -------------------------------------------------------------------------

  describe("network errors", () => {
    it("returns transient failure for ECONNREFUSED", async () => {
      const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      mockSendMail.mockRejectedValue(error);

      const adapter = new SmtpTransportAdapter(makeConfig());
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(false);
      expect(result.permanent).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
    });

    it("returns transient failure for ETIMEDOUT", async () => {
      const error = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
      mockSendMail.mockRejectedValue(error);

      const adapter = new SmtpTransportAdapter(makeConfig());
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(false);
      expect(result.permanent).toBe(false);
      expect(result.error).toContain("ETIMEDOUT");
    });

    it("returns transient failure for TLS handshake errors", async () => {
      const error = Object.assign(new Error("self-signed certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
      mockSendMail.mockRejectedValue(error);

      const adapter = new SmtpTransportAdapter(makeConfig());
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(false);
      expect(result.permanent).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // verify()
  // -------------------------------------------------------------------------

  describe("verify", () => {
    it("returns ok=true when server responds to EHLO+AUTH", async () => {
      mockVerify.mockResolvedValue(true);

      const adapter = new SmtpTransportAdapter(makeConfig());
      const result = await adapter.verify();

      expect(result.ok).toBe(true);
    });

    it("returns ok=false with error message on auth failure", async () => {
      mockVerify.mockRejectedValue(new Error("Invalid login: 535 Authentication failed"));

      const adapter = new SmtpTransportAdapter(makeConfig());
      const result = await adapter.verify();

      expect(result.ok).toBe(false);
      expect("error" in result && result.error).toContain("Authentication failed");
    });

    it("returns ok=false with error message on connection refused", async () => {
      mockVerify.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:587"));

      const adapter = new SmtpTransportAdapter(makeConfig());
      const result = await adapter.verify();

      expect(result.ok).toBe(false);
      expect("error" in result && result.error).toContain("ECONNREFUSED");
    });
  });

  // -------------------------------------------------------------------------
  // Security: credentials must NOT appear in error messages
  // -------------------------------------------------------------------------

  describe("credential leakage prevention", () => {
    it("does not include the password in the error message on auth failure", async () => {
      const error = Object.assign(
        new Error(`535 Authentication failed for user=user@example.com pass=${TEST_PASSWORD}`),
        { responseCode: 535 },
      );
      mockSendMail.mockRejectedValue(error);

      const adapter = new SmtpTransportAdapter(makeConfig());
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(false);
      expect(result.error).not.toContain(TEST_PASSWORD);
    });

    it("does not include the password in verify error message", async () => {
      mockVerify.mockRejectedValue(
        new Error(`Invalid login: pass=${TEST_PASSWORD} rejected`),
      );

      const adapter = new SmtpTransportAdapter(makeConfig());
      const result = await adapter.verify();

      expect(result.ok).toBe(false);
      expect("error" in result && result.error).not.toContain(TEST_PASSWORD);
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe("close", () => {
    it("closes the underlying transporter", () => {
      const adapter = new SmtpTransportAdapter(makeConfig());
      adapter.close();
      expect(mockClose).toHaveBeenCalledOnce();
    });
  });
});
