/** The per-framework integration guides: every one is complete, uses the right key, and never leaks a secret. */
import { describe, it, expect } from "vitest";
import { FRAMEWORKS, KEY_PLACEHOLDER, PACKAGE_NAME, buildGuide, buildSnippet, needsPackage, type FrameworkId } from "../src/integration-snippets.js";

const origin = "https://loomail.example.com/";
const key = "mf_pub_abc123";
const ids = FRAMEWORKS.map((f) => f.id);
const allCode = (id: FrameworkId, k: string | null) => buildGuide(id, { origin, key: k }).steps.map((s) => s.code).join("\n");

describe("buildGuide", () => {
  it("has a guide for every tab, with steps, a title and code in each", () => {
    expect(ids).toEqual(["html", "react", "nextjs", "vue", "nuxt", "svelte", "angular", "javascript", "gtm"]);
    for (const id of ids) {
      const g = buildGuide(id, { origin, key });
      expect(g.id).toBe(id);
      expect(g.label).toBe(FRAMEWORKS.find((f) => f.id === id)!.label);
      expect(g.summary.length).toBeGreaterThan(10);
      expect(g.steps.length).toBeGreaterThan(0);
      for (const s of g.steps) {
        expect(s.title.length).toBeGreaterThan(2);
        expect(s.code.trim().length).toBeGreaterThan(5);
      }
    }
  });

  it("puts the address in every guide (without a trailing slash) and the key where it is known", () => {
    for (const id of ids) {
      const code = allCode(id, key);
      expect(code, id).toContain("https://loomail.example.com");
      expect(code, id).not.toContain("loomail.example.com/\n");
      expect(code, id).not.toContain("loomail.example.com//");
      expect(code, id).toContain(key);
      expect(code, id).not.toContain(KEY_PLACEHOLDER);
    }
  });

  it("shows a placeholder when the key is not known, and never anything that looks like a secret key", () => {
    for (const id of ids) {
      const code = allCode(id, null);
      expect(code, id).toContain(KEY_PLACEHOLDER);
      expect(code, id).not.toMatch(/mf_live_[A-Za-z0-9]/); // only ever mentioned as a warning, never as a value
    }
  });

  it("warns against a secret key wherever the key is shown in browser code", () => {
    for (const id of ["react", "nextjs", "vue", "nuxt", "svelte", "angular", "javascript"] as FrameworkId[]) {
      const g = buildGuide(id, { origin, key });
      expect(g.steps.map((s) => s.note ?? "").join(" ") + g.summary, id).toMatch(/secret key|publishable/i);
    }
  });

  it("installs the package in every guide that imports it, and nowhere else", () => {
    for (const id of ids) {
      const code = allCode(id, key);
      const imports = code.includes(PACKAGE_NAME);
      expect(needsPackage(id), id).toBe(imports);
      if (imports) expect(code, id).toContain(`npm install ${PACKAGE_NAME}`);
    }
  });

  it("keeps the key in each framework's own public environment variables", () => {
    expect(allCode("react", key)).toMatch(/VITE_LOOMAIL_KEY=mf_pub_abc123/);
    expect(allCode("react", key)).toContain("import.meta.env.VITE_LOOMAIL_KEY");
    expect(allCode("nextjs", key)).toMatch(/NEXT_PUBLIC_LOOMAIL_KEY=mf_pub_abc123/);
    expect(allCode("nextjs", key)).toContain("process.env.NEXT_PUBLIC_LOOMAIL_KEY");
    expect(allCode("nextjs", key)).toContain('"use client"');
    expect(allCode("vue", key)).toContain("import.meta.env.VITE_LOOMAIL_KEY");
    expect(allCode("svelte", key)).toMatch(/PUBLIC_LOOMAIL_KEY=mf_pub_abc123/);
    expect(allCode("svelte", key)).toContain("$env/static/public");
    expect(allCode("nuxt", key)).toContain("runtimeConfig");
    expect(allCode("nuxt", key)).toContain("defineNuxtPlugin");
  });

  it("imports from the entry point that exists in the package", () => {
    const entries = new Set<string>();
    for (const id of ids) for (const m of allCode(id, key).matchAll(/from "(@loomail\/browser[^"]*)"/g)) entries.add(m[1]!);
    expect([...entries].sort()).toEqual(["@loomail/browser", "@loomail/browser/react", "@loomail/browser/vue"]);
  });

  it("teaches identify on sign-in and reset on sign-out", () => {
    for (const id of ["react", "nextjs", "vue", "nuxt", "svelte", "angular", "javascript"] as FrameworkId[]) {
      const code = allCode(id, key);
      expect(code, id).toMatch(/identify|user=\{/);
      expect(code, id).toMatch(/reset|null/);
    }
  });
});

describe("buildSnippet", () => {
  it("is the two-line stub, the hosted script and an init call", () => {
    const s = buildSnippet("https://loomail.example.com", key);
    expect(s).toContain('<script async src="https://loomail.example.com/loomail.js"></script>');
    expect(s).toContain('loomail("init", "mf_pub_abc123", { endpoint: "https://loomail.example.com", autoPage: true });');
    expect(s).toContain("window.loomail.q");
    expect(buildSnippet("https://x.test", null)).toContain(`"${KEY_PLACEHOLDER}"`);
  });
});
