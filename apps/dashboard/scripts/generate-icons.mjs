#!/usr/bin/env node
/**
 * Generate the raster icons from the Mailforge mark: favicon-16.png,
 * favicon-32.png, favicon.ico (16 + 32 PNG frames) and apple-touch-icon.png.
 *
 * Usage:
 *   node scripts/generate-icons.mjs
 *
 * Outputs into apps/dashboard/public/. Keep the mark path and colors in sync
 * with src/components/brand-mark.tsx and src/index.css.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MARK =
  "M5 5 H19 A3 3 0 0 1 22 8 V16 A3 3 0 0 1 19 19 H5 A3 3 0 0 1 2 16 V8 A3 3 0 0 1 5 5 Z M4.4 8.1 L12 13.7 L19.6 8.1 L19.6 10.7 L12 16.3 L4.4 10.7 Z";
const ACCENT = "#e2702a";
const TOUCH_BG = "#fdf3ea";

const svg = (size, fill, bg, scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
  (bg ? `<rect width="24" height="24" fill="${bg}"/>` : "") +
  `<g transform="translate(12 12) scale(${scale}) translate(-12 -12)"><path d="${MARK}" fill="${fill}" fill-rule="evenodd"/></g></svg>`;

const browser = await chromium.launch();
async function render(size, markup) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${markup}`,
  );
  const buf = await page.screenshot({ omitBackground: true });
  await page.close();
  return buf;
}

const f16 = await render(16, svg(16, ACCENT, null, 1.08));
const f32 = await render(32, svg(32, ACCENT, null, 1.08));
const touch = await render(180, svg(180, ACCENT, TOUCH_BG, 0.72));
await browser.close();

writeFileSync(join(PUBLIC, "favicon-16.png"), f16);
writeFileSync(join(PUBLIC, "favicon-32.png"), f32);
writeFileSync(join(PUBLIC, "apple-touch-icon.png"), touch);

// ICO container holding the two PNG frames.
const frames = [[16, f16], [32, f32]];
const head = Buffer.alloc(6 + 16 * frames.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4);
let offset = head.length;
frames.forEach(([size, buf], i) => {
  const o = 6 + 16 * i;
  head[o] = size; head[o + 1] = size; head[o + 2] = 0; head[o + 3] = 0;
  head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(buf.length, o + 8); head.writeUInt32LE(offset, o + 12);
  offset += buf.length;
});
writeFileSync(join(PUBLIC, "favicon.ico"), Buffer.concat([head, ...frames.map(([, b]) => b)]));
console.log("Icons written to", PUBLIC);
