// Screenshots of the app at phone size, one per drop. For reviewing the picture.
//   tsx scripts/shot.ts <url> <outDir> [drop%...]
// For a view with no slider (Cover, Verify), pass `page` for one full-page shot:
//   tsx scripts/shot.ts http://127.0.0.1:5179/#/cover shots page

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [url = "http://127.0.0.1:5179/", out = "shots", ...drops] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
if (drops[0] === "page") {
  // Live views read the chain after load; give the first read time to land.
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/page.png`, fullPage: true });
  console.log(`${out}/page.png`);
  await browser.close();
  process.exit(0);
}
await page.waitForSelector("canvas", { timeout: 120_000 });
await page.waitForTimeout(1500);
for (const d of drops.length ? drops : ["0"]) {
  await page.evaluate((v) => {
    const el = document.querySelector("input[type=range]") as HTMLInputElement;
    el.value = v;
    el.dispatchEvent(new Event("input"));
  }, d);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/drop-${d}.png` });
  console.log(`${out}/drop-${d}.png`);
}
await browser.close();
