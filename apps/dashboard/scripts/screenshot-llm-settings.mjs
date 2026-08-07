/**
 * Screenshot harness for the LLM provider settings section.
 *
 * Captures the six states of the simplified form in both color schemes:
 *   unconfigured, filled, verifying, verification failed, configured,
 *   advanced disclosure open.
 *
 * Usage:
 *   node scripts/screenshot-llm-settings.mjs --base http://localhost:5173 --verify-url '<url>'
 *
 * The verify URL may point at the dashboard origin; /auth is proxied to the
 * API. "Verifying" and "unconfigured" are produced by intercepting requests;
 * "verification failed" is a real submit against the running API (a bad key
 * stores nothing, so the run leaves no trace). The configured shot reads
 * whatever the local tenant actually has.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const BASE = argValue("--base") ?? "http://localhost:5173";
const OUT = new URL("../.screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const VERIFY_URL_FILE = new URL("../.screenshots/.verify-url", import.meta.url).pathname;
let verifyUrl = argValue("--verify-url");
if (!verifyUrl && existsSync(VERIFY_URL_FILE)) {
  verifyUrl = readFileSync(VERIFY_URL_FILE, "utf8").trim();
}

async function shoot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: false });
  console.log(`  ${name}.png`);
}

const browser = await chromium.launch();
let sessionCookies = null;

for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  if (sessionCookies) {
    await context.addCookies(sessionCookies);
  } else if (verifyUrl) {
    const token = new URL(verifyUrl).searchParams.get("token") ?? "";
    const resp = await context.request.post(`${BASE}/auth/verify`, {
      form: { token },
      maxRedirects: 0,
    }).catch(() => null);
    const location = resp?.headers()["location"] ?? "";
    if (location.includes("error=")) {
      console.log("verify FAILED (spent or expired link)");
    } else {
      sessionCookies = await context.cookies("http://localhost");
      await context.addCookies(sessionCookies);
    }
  }

  // configured (real): whatever the local tenant has active
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-llm-1-configured`);

  // advanced disclosure open (real): open the Replace form, then Advanced
  const replaceBtn = page.locator("button", { hasText: "Replace" }).first();
  if (await replaceBtn.count()) {
    await replaceBtn.click();
    await page.locator("summary", { hasText: "Advanced" }).click();
    await shoot(page, `${scheme}-llm-2-advanced-open`);
    await page.locator("button", { hasText: "Cancel" }).first().click();
  }

  // unconfigured (stubbed GET): form shows provider + key only
  await context.route("**/v1/settings/llm", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ llm: null }),
      });
    }
    return route.continue();
  });
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-llm-3-unconfigured`);

  // filled
  await page.fill("#llm-api-key", "sk-live-example-key");
  await shoot(page, `${scheme}-llm-4-filled`);

  // verifying (stubbed slow PUT): hold the response past the shot window
  await context.route("**/v1/settings/llm", async (route) => {
    if (route.request().method() === "PUT") {
      await new Promise((r) => setTimeout(r, 3000));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          llm: {
            id: "11111111-1111-1111-1111-111111111111",
            provider: "openai",
            model: "gpt-4o-mini",
            base_url: "https://api.openai.com/v1",
            embedding_model: "text-embedding-3-small",
            is_active: true,
            created_at: new Date().toISOString(),
          },
          verification: { ok: true },
        }),
      });
    }
    return route.continue();
  });
  await page.locator("button", { hasText: "Verify and save" }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}${scheme}-llm-5-verifying.png` });
  console.log(`  ${scheme}-llm-5-verifying.png`);
  await page.waitForTimeout(3000);
  await context.unroute("**/v1/settings/llm");

  // verification failed (real): custom provider against an unreachable
  // endpoint; a failed verification stores nothing.
  await context.route("**/v1/settings/llm", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ llm: null }),
      });
    }
    return route.continue();
  });
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.selectOption("#llm-provider", "custom");
  await page.fill("#llm-base-url", "http://127.0.0.1:1/v1");
  await page.fill("#llm-model", "demo-llm-1");
  await page.fill("#llm-api-key", "sk-bad-example-key");
  await page.locator("button", { hasText: "Verify and save" }).click();
  await page.waitForSelector("text=Nothing was stored", { timeout: 15000 });
  await shoot(page, `${scheme}-llm-6-verification-failed`);
  await context.unroute("**/v1/settings/llm");

  await context.close();
}

await browser.close();
console.log(`done -> ${OUT}`);
