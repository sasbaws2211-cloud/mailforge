/**
 * Minimal screenshot script for the current task: captures the flows list,
 * library flow editor, prompt-defined flow editor, and the sidebar (no Templates).
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5175";
const OUT = new URL("../.screenshots/task/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const VERIFY_URL = process.argv[2];
if (!VERIFY_URL) {
  console.error("Usage: node screenshot-task.mjs <verify-url>");
  process.exit(1);
}

async function shoot(page, name) {
  await page.waitForTimeout(500);
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

  // Authenticate
  if (sessionCookies) {
    await context.addCookies(sessionCookies);
  } else {
    const token = new URL(VERIFY_URL).searchParams.get("token") ?? "";
    const resp = await context.request.post(`${new URL(VERIFY_URL).origin}/auth/verify`, {
      form: { token },
      maxRedirects: 0,
    }).catch(() => null);
    const location = resp?.headers()["location"] ?? "";
    if (location.includes("error=")) {
      console.log("verify FAILED; exiting");
      process.exit(1);
    }
    console.log(`verify: status=${resp?.status()}`);
    sessionCookies = await context.cookies("http://localhost");
    await context.addCookies(sessionCookies);
  }

  // 1. Flows list
  await page.goto(`${BASE}/flows`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-flows-list`);

  // Find the library flow and a prompt-defined flow
  const listResp = await context.request.get(`${BASE}/v1/flows`);
  const list = await listResp.json().catch(() => ({ flows: [] }));
  const allFlows = Array.isArray(list.flows) ? list.flows : [];

  const libraryFlow = allFlows.find((f) => f.source === "library");
  const promptFlow = allFlows.find((f) => f.source !== "library" && f.prompt_source);

  // 2. Library flow editor
  if (libraryFlow) {
    await page.goto(`${BASE}/flows/${libraryFlow.id}/edit`, { waitUntil: "networkidle" });
    await shoot(page, `${scheme}-library-flow-editor`);
  } else {
    console.log(`  (no library flow found; skipped)`);
  }

  // 3. Prompt-defined flow editor
  if (promptFlow) {
    await page.goto(`${BASE}/flows/${promptFlow.id}/edit`, { waitUntil: "networkidle" });
    await shoot(page, `${scheme}-prompt-flow-editor`);
  } else {
    console.log(`  (no prompt flow found; skipped)`);
  }

  // 4. New flow editor
  await page.goto(`${BASE}/flows/new`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-new-flow`);

  // 5. Sidebar check (flows page shows nav)
  // Already captured in flows-list

  await context.close();
}

await browser.close();
console.log(`done -> ${OUT}`);
