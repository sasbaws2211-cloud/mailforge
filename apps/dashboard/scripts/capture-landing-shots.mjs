#!/usr/bin/env node
/**
 * Capture the two product screenshots used on the public landing page
 * ("How it works" section): the flow editor and the lifecycle retention grid.
 *
 * Usage: node scripts/capture-landing-shots.mjs <session-id> [--base http://localhost:3010]
 *
 * <session-id> is a valid loomail_session cookie value for a workspace with
 * data to show. Output: public/landing/flow-editor.png, public/landing/lifecycle-grid.png
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "landing");
mkdirSync(out, { recursive: true });

const session = process.argv[2];
if (!session) throw new Error("Usage: capture-landing-shots.mjs <session-id> [--base URL]");
const bi = process.argv.indexOf("--base");
const base = bi >= 0 ? process.argv[bi + 1] : "http://localhost:3010";

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "msedge" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, colorScheme: "light" });
await ctx.addCookies([{ name: "loomail_session", value: session, url: base }]);
const page = await ctx.newPage();
await page.addInitScript(() => localStorage.setItem("loomail-ui-theme", "light"));

async function shoot(path, file, ready) {
  await page.goto(base + path, { waitUntil: "networkidle" });
  if (ready) await page.waitForSelector(ready, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, file) });
  console.log("captured", file, "from", page.url());
}

// Tidy the app chrome for a marketing shot: no plan-limit banner, a neutral account name.
async function tidy() {
  await page.evaluate(() => {
    document.querySelectorAll('[role="alert"]').forEach((el) => el.remove());
    // The plan-limit banner is not an ARIA alert: find its text and remove the whole box.
    const leaf = [...document.querySelectorAll("p, span, div")].find(
      (el) => el.children.length <= 2 && (el.textContent ?? "").trim().startsWith("You have reached") && (el.textContent ?? "").length < 400,
    );
    if (leaf) {
      let box = leaf;
      while (box.parentElement && (box.parentElement.textContent ?? "").trim().startsWith("You have reached") && (box.parentElement.textContent ?? "").length < 400) {
        box = box.parentElement;
      }
      box.remove();
    }
    document.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0 && /@mailforge\.test|@loomail\.test/.test(el.textContent ?? "")) el.textContent = "you@yourproduct.com";
    });
  });
}

const FLOW_ID = process.env.FLOW_ID;
if (!FLOW_ID) throw new Error("Set FLOW_ID to an existing flow id to open in the editor.");
await page.goto(base + "/flows/" + FLOW_ID + "/edit", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await tidy();
await page.screenshot({ path: join(out, "flow-editor.png") });
console.log("captured flow-editor.png");

await page.goto(base + "/lifecycle", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await tidy();
await page.screenshot({ path: join(out, "lifecycle-grid.png") });
console.log("captured lifecycle-grid.png");
await browser.close();
