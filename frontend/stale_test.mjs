import { chromium } from "playwright-core";
const base = process.argv[2] || "http://127.0.0.1:8099";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(base + "/overlay", { waitUntil: "networkidle" }).catch(() => {});
await page.waitForTimeout(3000);
await page.screenshot({ path: "../stale_live.png" });
console.log("captured LIVE at t=3s");
await page.waitForTimeout(12000); // server gets killed during this window
await page.screenshot({ path: "../stale_after.png" });
// Report the visible telemetry-health text so we can assert stale without eyeballing
const health = await page.$$eval(".signal-row", (rows) => rows.map((r) => r.textContent?.trim()));
console.log("HEALTH ROWS:", JSON.stringify(health));
await browser.close();
