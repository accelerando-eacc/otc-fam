// Plays round 1's five scenes (the brief's "What users see") with an entry's page, on a local chain, with
// the checks' tokens and wallet. At each step it prints the text a person reads and saves a screenshot at
// phone width. From the repository's root, after "npm ci" and "npx playwright install chromium":
//   node .launchpad/checks/round-1/play.mjs [folder for the screenshots, screens/ by default]
// It is not a check: nothing here passes or fails an entry.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { offered, pressUntil, serve, until, wallet, withPage } from "./page.mjs";
import { STATUS, world } from "./world.mjs";

const folder = resolve(process.argv[2] ?? "screens");
mkdirSync(folder, { recursive: true });

/** Prints what the page shows now, and saves it as `<folder>/<name>.png`. */
async function look(page, name) {
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: true });
  const text = (await page.locator("body").innerText()).trim();
  console.log(`\n--- ${name} (${name}.png)\n${text.split("\n").map((l) => `    ${l}`).join("\n")}`);
}
/** Plays one scene; a scene that breaks says so and the next one still plays. */
async function scene(title, play) {
  console.log(`\n=== ${title}`);
  await play().catch((e) => console.log(`    (this scene stopped: ${e.message.split("\n")[0]})`));
}

const w = await world();
const expiry = Math.max(await w.chain.now(), Math.floor(Date.now() / 1000)) + 4;
const expired = await w.offer({ expiry });
const open = await w.offer(), filled = await w.offer(), cancelled = await w.offer(), reserved = await w.offer({ taker: w.taker });
await w.accept(filled);
await w.deals.as(w.maker).cancel(cancelled);
const site = await serve(w);
const isFilled = async (id) => (await w.deals.read.getDeal(id)).status === STATUS.Filled;

await scene("1. An open deal's link, in a browser with no wallet", () => withPage(site, `#/d/${open}`, null, async (page) => {
  await page.getByTestId("deal-status").waitFor();
  await look(page, "1-open-deal-no-wallet");
}));

await scene("2. The same link with a wallet that holds the tokens: each press until the deal is filled", () => withPage(site, `#/d/${open}`, wallet(w, w.taker), async (page) => {
  await pressUntil(page, () => isFilled(open), "the deal filled", (presses) => look(page, `2-fill-after-${presses}-presses`));
  await page.waitForTimeout(1000);
  await look(page, "2-fill-the-end");
}));

await scene("3. A filled deal, a cancelled deal, an expired deal, an id no deal has", async () => {
  await until(() => Date.now() / 1000 > expiry + 1, "waiting for the deal to expire", 15_000);
  await w.chain.mine();
  for (const [id, name] of [[filled, "filled"], [cancelled, "cancelled"], [expired, "expired"], [999, "not-found"]]) {
    await withPage(site, `#/d/${id}`, null, async (page) => {
      await page.getByTestId("deal-status").waitFor();
      await look(page, `3-${name}`);
    });
  }
});

await scene("4. A deal reserved for one address, opened with another wallet", () => withPage(site, `#/d/${reserved}`, wallet(w, w.other), async (page) => {
  const told = async () => Boolean(await page.getByTestId("notice").innerText().catch(() => "")) && !(await offered(page));
  await pressUntil(page, told, "a notice, and nothing left to press", (presses) => look(page, `4-not-for-you-after-${presses}-presses`)).catch(() => {});
  await page.waitForTimeout(1000);
  await look(page, "4-not-for-you-the-end");
}));

await scene("5. /#/new with a wallet: the form, each press, and the link at the end", () => withPage(site, "#/new", wallet(w, w.maker), async (page) => {
  const entered = { "sell-token": w.alfa.address, "sell-amount": "250.5", "buy-token": w.bravo.address, "buy-amount": "0.125", taker: "", "expiry-hours": "48" };
  for (const [id, value] of Object.entries(entered)) await page.getByTestId(id).fill(value);
  await pressUntil(page, async () => (await page.getByTestId("deal-link").count()) === 1, "the deal's link", (presses) => look(page, `5-new-deal-after-${presses}-presses`));
}));

await site.close();
console.log(`\nScreenshots are in ${folder}`);
process.exit(0);
