/**
 * Unit tests for template-renderer.ts.
 *
 * Covers:
 *   - Basic variable interpolation (contact, tenant, flow)
 *   - HTML escaping of interpolated values (XSS prevention)
 *   - Missing variable detection and failure behavior
 *   - Unknown variable paths cause failure
 *   - Nested contact.properties access
 *   - Subject line (no HTML escaping) vs body (HTML escaped)
 *   - body_text fallback from HTML stripping
 */
import { describe, it, expect } from "vitest";
import { renderTemplate, escapeHtml, type TemplateContext } from "../src/template-renderer.js";

// ---------------------------------------------------------------------------
// Fixture context
// ---------------------------------------------------------------------------

const baseCtx: TemplateContext = {
  contact: {
    first_name: "Alice",
    last_name: "Smith",
    email: "alice@example.com",
    external_id: "ext-123",
    properties: { company: "Acme Inc", role: "Engineer" },
  },
  tenant: { name: "TestApp" },
  flow: { name: "Welcome Flow" },
};

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes all dangerous characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#x27;s");
  });

  it("leaves safe strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// renderTemplate - basic interpolation
// ---------------------------------------------------------------------------

describe("renderTemplate", () => {
  it("interpolates contact.first_name in subject and body", () => {
    const result = renderTemplate(
      "Hello {{contact.first_name}}",
      "<p>Hi {{contact.first_name}}</p>",
      null,
      baseCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe("Hello Alice");
    expect(result.bodyHtml).toBe("<p>Hi Alice</p>");
  });

  it("interpolates tenant.name and flow.name", () => {
    const result = renderTemplate(
      "From {{tenant.name}}",
      "<p>Flow: {{flow.name}}</p>",
      null,
      baseCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe("From TestApp");
    expect(result.bodyHtml).toBe("<p>Flow: Welcome Flow</p>");
  });

  it("interpolates contact.properties.* fields", () => {
    const result = renderTemplate(
      "{{contact.properties.company}}",
      "<p>{{contact.properties.role}}</p>",
      null,
      baseCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe("Acme Inc");
    expect(result.bodyHtml).toBe("<p>Engineer</p>");
  });

  it("interpolates contact.email and external_id", () => {
    const result = renderTemplate(
      "{{contact.email}}",
      "<p>ID: {{contact.external_id}}</p>",
      null,
      baseCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe("alice@example.com");
    expect(result.bodyHtml).toBe("<p>ID: ext-123</p>");
  });

  // ---------------------------------------------------------------------------
  // HTML escaping (XSS prevention)
  // ---------------------------------------------------------------------------

  it("escapes HTML in body but not in subject", () => {
    const xssCtx: TemplateContext = {
      ...baseCtx,
      contact: {
        ...baseCtx.contact,
        first_name: '<script>alert("xss")</script>',
      },
    };

    const result = renderTemplate(
      "Hi {{contact.first_name}}",
      "<p>Hi {{contact.first_name}}</p>",
      "Hi {{contact.first_name}}",
      xssCtx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Subject: no escaping (email subjects are plain text, not rendered as HTML)
    expect(result.subject).toBe('Hi <script>alert("xss")</script>');

    // Body HTML: escaped to prevent XSS
    expect(result.bodyHtml).toBe(
      "<p>Hi &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>",
    );

    // Body text: no escaping (plain text)
    expect(result.bodyText).toBe('Hi <script>alert("xss")</script>');
  });

  it("escapes ampersands and quotes in body HTML", () => {
    const ctx: TemplateContext = {
      ...baseCtx,
      contact: {
        ...baseCtx.contact,
        first_name: 'O"Brien & Co',
      },
    };

    const result = renderTemplate(
      "Hi",
      "<p>{{contact.first_name}}</p>",
      null,
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toBe("<p>O&quot;Brien &amp; Co</p>");
  });

  // ---------------------------------------------------------------------------
  // Missing variable handling
  // ---------------------------------------------------------------------------

  it("fails when a referenced variable is missing (null value)", () => {
    const ctx: TemplateContext = {
      ...baseCtx,
      contact: { ...baseCtx.contact, first_name: null },
    };

    const result = renderTemplate(
      "Hi {{contact.first_name}}",
      "<p>Welcome</p>",
      null,
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingVariables).toContain("contact.first_name");
    expect(result.reason).toContain("contact.first_name");
  });

  it("fails when an unknown variable path is used", () => {
    const result = renderTemplate(
      "{{unknown.variable}}",
      "<p>Hi</p>",
      null,
      baseCtx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingVariables).toContain("unknown.variable");
  });

  it("fails when a contact.properties key does not exist", () => {
    const result = renderTemplate(
      "{{contact.properties.nonexistent}}",
      "<p>Hi</p>",
      null,
      baseCtx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingVariables).toContain("contact.properties.nonexistent");
  });

  it("collects all missing variables from all template parts", () => {
    const ctx: TemplateContext = {
      ...baseCtx,
      contact: { ...baseCtx.contact, first_name: null, email: null },
    };

    const result = renderTemplate(
      "{{contact.first_name}}",
      "<p>{{contact.email}}</p>",
      null,
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingVariables).toContain("contact.first_name");
    expect(result.missingVariables).toContain("contact.email");
  });

  // ---------------------------------------------------------------------------
  // body_text fallback
  // ---------------------------------------------------------------------------

  it("derives body_text from HTML when body_text template is null", () => {
    const result = renderTemplate(
      "Subject",
      "<p>Hello {{contact.first_name}}</p><br><p>Goodbye</p>",
      null,
      baseCtx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The derived text should strip tags and convert line breaks
    expect(result.bodyText).toContain("Hello Alice");
    expect(result.bodyText).toContain("Goodbye");
    expect(result.bodyText).not.toContain("<p>");
  });

  it("uses body_text template when provided", () => {
    const result = renderTemplate(
      "Subject",
      "<p>HTML {{contact.first_name}}</p>",
      "Text {{contact.first_name}}",
      baseCtx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyText).toBe("Text Alice");
  });

  // ---------------------------------------------------------------------------
  // Whitespace tolerance in variable syntax
  // ---------------------------------------------------------------------------

  it("handles whitespace around variable names", () => {
    const result = renderTemplate(
      "{{ contact.first_name }}",
      "<p>{{  tenant.name  }}</p>",
      null,
      baseCtx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe("Alice");
    expect(result.bodyHtml).toBe("<p>TestApp</p>");
  });

  // ---------------------------------------------------------------------------
  // Empty properties object
  // ---------------------------------------------------------------------------

  it("handles null properties gracefully", () => {
    const ctx: TemplateContext = {
      ...baseCtx,
      contact: { ...baseCtx.contact, properties: null },
    };

    const result = renderTemplate(
      "{{contact.properties.company}}",
      "<p>Hi</p>",
      null,
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingVariables).toContain("contact.properties.company");
  });

  // ---------------------------------------------------------------------------
  // Pipe-fallback syntax
  // ---------------------------------------------------------------------------

  it("uses fallback value when variable is null (pipe syntax)", () => {
    const ctx: TemplateContext = {
      ...baseCtx,
      contact: { ...baseCtx.contact, first_name: null },
    };

    const result = renderTemplate(
      "Hi {{contact.first_name|there}}",
      "<p>Hi {{contact.first_name|there}}</p>",
      "Hi {{contact.first_name|there}}",
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe("Hi there");
    expect(result.bodyHtml).toBe("<p>Hi there</p>");
    expect(result.bodyText).toBe("Hi there");
  });

  it("uses actual value when present, ignoring fallback", () => {
    const result = renderTemplate(
      "Hi {{contact.first_name|there}}",
      "<p>Hi {{contact.first_name|there}}</p>",
      null,
      baseCtx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe("Hi Alice");
    expect(result.bodyHtml).toBe("<p>Hi Alice</p>");
  });

  it("escapes fallback value in HTML body", () => {
    const ctx: TemplateContext = {
      ...baseCtx,
      contact: { ...baseCtx.contact, first_name: null },
    };

    const result = renderTemplate(
      "Hi",
      "<p>{{contact.first_name|<b>you</b>}}</p>",
      null,
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toBe("<p>&lt;b&gt;you&lt;/b&gt;</p>");
  });

  it("does not treat pipe-fallback variables as missing", () => {
    const ctx: TemplateContext = {
      ...baseCtx,
      contact: { ...baseCtx.contact, first_name: null },
    };

    const result = renderTemplate(
      "{{contact.first_name|Friend}}",
      "<p>{{contact.first_name|Friend}}</p>",
      null,
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No missing variables because fallback was declared
    expect(result.subject).toBe("Friend");
  });
});
