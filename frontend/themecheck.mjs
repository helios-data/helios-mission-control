import { chromium } from "playwright-core";
const base = process.argv[2] || "http://127.0.0.1:8090";
const theme = process.argv[3] || "light";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.addInitScript((t) => localStorage.setItem("hmc-theme", t), theme);
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
for (const [name, path, wait] of [["admin", "/admin", 9000], ["overlay", "/overlay", 4000]]) {
  await p.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
  await p.waitForTimeout(wait);
  await p.screenshot({ path: `../${name}_${theme}.png` });
}
console.log(`theme=${theme} errors:`, errs.length ? errs.join(" | ") : "none");
await b.close();
