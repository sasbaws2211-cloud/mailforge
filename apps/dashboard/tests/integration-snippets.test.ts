/** The per-framework and per-language integration guides: every one is complete, uses the right key, and never leaks a secret. */
import { describe, it, expect } from "vitest";
import {
  FRAMEWORKS,
  FRAMEWORK_GROUPS,
  KEY_PLACEHOLDER,
  PACKAGE_NAME,
  SECRET_PLACEHOLDER,
  buildGuide,
  buildSnippet,
  groupOf,
  needsPackage,
  type FrameworkId,
} from "../src/integration-snippets.js";

const origin = "https://loomail.example.com/";
const key = "mf_pub_abc123";
const ids = FRAMEWORKS.map((f) => f.id);
const browserIds = FRAMEWORKS.filter((f) => f.group === "browser").map((f) => f.id);
const serverIds = FRAMEWORKS.filter((f) => f.group === "server").map((f) => f.id);
const allCode = (id: FrameworkId, k: string | null) => buildGuide(id, { origin, key: k }).steps.map((s) => s.code).join("\n");
const allText = (id: FrameworkId) => {
  const g = buildGuide(id, { origin, key });
  return [g.summary, ...g.steps.map((s) => `${s.title} ${s.note ?? ""} ${s.code}`)].join("\n");
};

describe("the tabs", () => {
  it("are two groups, browser first, and every tab belongs to one", () => {
    expect(FRAMEWORK_GROUPS.map((g) => g.id)).toEqual(["browser", "server"]);
    expect(browserIds).toEqual(["html", "react", "nextjs", "vue", "nuxt", "svelte", "angular", "javascript", "gtm"]);
    expect(serverIds).toEqual(["node", "python", "php", "ruby", "go", "java"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(groupOf(id)).toBe(FRAMEWORKS.find((f) => f.id === id)!.group);
  });
});

describe("buildGuide, every tab", () => {
  it("has steps with a title and code in each", () => {
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

  it("puts the address in every guide, without a trailing slash", () => {
    for (const id of ids) {
      const code = allCode(id, key);
      expect(code, id).toContain("https://loomail.example.com");
      expect(code, id).not.toContain("loomail.example.com/\n");
      expect(code, id).not.toContain("loomail.example.com//");
    }
  });
});

describe("buildGuide, in the browser", () => {
  it("puts the publishable key where it is known, and a placeholder where it is not", () => {
    for (const id of browserIds) {
      expect(allCode(id, key), id).toContain(key);
      expect(allCode(id, key), id).not.toContain(KEY_PLACEHOLDER);
      expect(allCode(id, null), id).toContain(KEY_PLACEHOLDER);
    }
  });

  it("never shows anything that looks like a secret key, and warns against one", () => {
    for (const id of browserIds) {
      expect(allCode(id, null), id).not.toMatch(/mf_live_[A-Za-z0-9]/); // only ever mentioned as a warning, never as a value
      expect(allCode(id, key), id).not.toMatch(/mf_live_[A-Za-z0-9]/);
    }
    for (const id of ["react", "nextjs", "vue", "nuxt", "svelte", "angular", "javascript"] as FrameworkId[]) {
      expect(allText(id), id).toMatch(/secret key|publishable/i);
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
    for (const id of browserIds) for (const m of allCode(id, key).matchAll(/from "(@loomail\/browser[^"]*)"/g)) entries.add(m[1]!);
    expect([...entries].sort()).toEqual(["@loomail/browser", "@loomail/browser/react", "@loomail/browser/vue"]);
  });

  it("teaches identify on sign-in and reset on sign-out", () => {
    for (const id of ["react", "nextjs", "vue", "nuxt", "svelte", "angular", "javascript"] as FrameworkId[]) {
      const code = allCode(id, key);
      expect(code, id).toMatch(/identify|user=\{/);
      expect(code, id).toMatch(/reset|null/);
    }
  });

  it("Angular: creates the environment files and fills in BOTH, which ng serve needs (found by running it)", () => {
    const g = buildGuide("angular", { origin, key });
    const code = g.steps.map((s) => s.code).join("\n");
    expect(code).toContain("ng generate environments");
    const filled = g.steps.find((s) => s.code.includes("loomailKey"))!;
    expect(filled.file).toMatch(/environment\.ts and environment\.development\.ts/);
    expect(filled.note).toMatch(/both files/i);
    // the current CLI's root component, and the older name
    const start = g.steps.at(-1)!;
    expect(start.code).toContain("inject(LoomailService)");
    expect(start.file).toBe("src/app/app.ts");
    expect(start.note).toMatch(/app\.component\.ts/);
  });
});

describe("buildGuide, from your server", () => {
  const install: Record<string, string> = {
    node: "npm install @loomail/node",
    python: "pip install loomail",
    php: "composer require loomail/loomail",
    ruby: "bundle add loomail",
    go: "go get github.com/sasbaws2211-cloud/mailforge/packages/sdk-go",
    java: "<artifactId>loomail</artifactId>",
  };

  it("installs the right package for each language", () => {
    for (const id of serverIds) expect(allCode(id, key), id).toContain(install[id]!);
    expect(allCode("java", key)).toContain("<groupId>site.loomail</groupId>");
  });

  it("names the secret key and the host as environment variables, and never fills in a key", () => {
    for (const id of serverIds) {
      const code = allCode(id, key);
      expect(code, id).toContain("LOOMAIL_SECRET_KEY=" + SECRET_PLACEHOLDER);
      expect(code, id).toContain("LOOMAIL_HOST=https://loomail.example.com");
      expect(code, id).not.toContain(key); // the publishable key is for the browser
      expect(code, id).not.toMatch(/mf_live_[A-Za-z0-9]/);
      expect(code, id).not.toContain(KEY_PLACEHOLDER);
    }
  });

  it("explains that it is a secret key for the server only, and that the SDK refuses a publishable key", () => {
    for (const id of serverIds) {
      const env = buildGuide(id, { origin, key }).steps.find((s) => s.code.includes("LOOMAIL_SECRET_KEY"))!;
      expect(env.note, id).toMatch(/secret key/i);
      expect(env.note, id).toMatch(/never in browser code/i);
      expect(env.note, id).toMatch(/refuses a publishable key/i);
    }
  });

  it("each shows identify and track, and teaches the message id for idempotent calls", () => {
    for (const id of serverIds) {
      const code = allCode(id, key);
      expect(code, id).toMatch(/identify/i);
      expect(code, id).toMatch(/track/i);
      expect(code, id).toMatch(/message_?id|MessageID|messageId/i);
      expect(allText(id), id).toMatch(/never double-counts/i);
    }
  });

  it("uses each SDK's real names (checked against the SDKs)", () => {
    expect(allCode("node", key)).toContain('import { Loomail } from "@loomail/node"');
    expect(allCode("python", key)).toContain("from loomail import Loomail");
    expect(allCode("php", key)).toContain("Loomail\\Laravel\\Facades\\Loomail");
    expect(allCode("php", key)).toContain("new \\Loomail\\Client()");
    expect(allCode("ruby", key)).toContain("Loomail.track_later");
    expect(allCode("ruby", key)).toContain("Loomail::Client.new");
    expect(allCode("go", key)).toContain("loomail.New()");
    expect(allCode("go", key)).toContain("loomail.WithMessageID");
    expect(allCode("java", key)).toContain("Loomail.fromEnvironment()");
    expect(allCode("java", key)).toContain("CallOptions.builder().messageId");
  });

  it("does not need the browser package", () => {
    for (const id of serverIds) {
      expect(needsPackage(id), id).toBe(false);
      expect(allCode(id, key), id).not.toContain(PACKAGE_NAME);
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
