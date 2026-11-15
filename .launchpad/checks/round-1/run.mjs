// Round 1's checks: one deal, one link. Run them yourself from the repository's root, after "npm ci":
//   node .launchpad/checks/round-1/run.mjs        (the page tests also need "npx playwright install chromium")
//
// Each test starts from a fresh world (world.mjs): a new local chain, the entry's contracts/OtcDeals.sol
// compiled and deployed on it, the checks' tokens (tokens/Tokens.sol), and people who hold them. The page
// tests build the entry (npm run build), serve dist/ on 127.0.0.1 and drive it in Chromium (page.mjs).
// The entry's code runs on the chain, in the build's child process and in the browser: never in this process.
import { check, harness } from "./lib/harness.mjs";
import { Reverted } from "./chain.mjs";
import { offered, pressUntil, seen, serve, shows, until, wallet, withPage } from "./page.mjs";
import { Interface, parseUnits } from "./tools.mjs";
import { ANYONE, artifacts, OTC_DEALS, refused, same, STATUS, STATUS_NAME, world } from "./world.mjs";

const { test, done } = harness();
/** The one fill of the default deal: what moves between the maker and `taker`. */
const oneFill = (w, taker = "taker") => ({ maker: { ALFA: -w.SELL, BRAVO: w.BUY }, [taker]: { ALFA: w.SELL, BRAVO: -w.BUY } });

// ---------------------------------------------------------------------------------------------- the contract

await test("Fill: after createDeal then fill, the maker holds buyAmount more of buyToken, the taker holds sellAmount more of sellToken, and the contract holds nothing of either", async () => {
  const w = await world();
  const before = await w.holdings();
  const id = await w.offer();
  await w.accept(id);
  await w.moved(before, oneFill(w), "after createDeal then fill");
});

await test("All or nothing: a fill by a taker who lacks the tokens or the allowance fails and changes no balance", async () => {
  const w = await world();
  const start = await w.holdings();
  const id = await w.offer();
  const open = await w.holdings();
  await w.approve(w.broke, w.bravo, w.BUY);
  await refused(w.deals.as(w.broke).fill(id), "a fill by a taker who approved the contract but holds no buyToken");
  await refused(w.deals.as(w.taker).fill(id), "a fill by a taker who holds the buyToken but has not approved the contract");
  await w.approve(w.taker, w.bravo, w.BUY - 1n);
  await refused(w.deals.as(w.taker).fill(id), "a fill by a taker whose allowance is one unit short");
  await w.moved(open, {}, "after three fills that must fail");
  await w.accept(id); // the same deal fills once the taker can pay: an entry that refuses every fill does not pass
  await w.moved(start, oneFill(w), "after the taker approved the full amount and filled");
});

await test("Private and open: a deal with a taker is filled only by that address; a deal with address(0) is filled by anyone", async () => {
  const w = await world();
  const before = await w.holdings();
  const reserved = await w.offer({ taker: w.taker });
  await w.approve(w.other, w.bravo, 2n * w.BUY);
  await refused(w.deals.as(w.other).fill(reserved), "a fill of a deal reserved for the taker, by another address that holds the tokens");
  await w.accept(reserved);
  const open = await w.offer({ taker: ANYONE });
  await w.deals.as(w.other).fill(open);
  await w.moved(before, { maker: { ALFA: -2n * w.SELL, BRAVO: 2n * w.BUY }, taker: oneFill(w).taker, other: oneFill(w).taker }, "after the taker filled the reserved deal and another address the open one");
});

await test("Once: a deal fills once; a filled or cancelled deal cannot be filled or cancelled again", async () => {
  const w = await world();
  const filled = await w.offer(), cancelled = await w.offer();
  await w.accept(filled);
  await w.deals.as(w.maker).cancel(cancelled);
  await w.stock();
  await w.approve(w.other, w.bravo, 2n * w.BUY); // a second taker, able to pay
  const settled = await w.holdings();
  for (const [id, state] of [[filled, "filled"], [cancelled, "cancelled"]]) {
    await refused(w.deals.as(w.other).fill(id), `a fill of a ${state} deal`);
    await refused(w.deals.as(w.maker).cancel(id), `a cancel of a ${state} deal, by its maker`);
  }
  await w.moved(settled, {}, "after the fills and cancels that must fail");
});

await test("Expiry: a fill at or after the expiry fails; the maker can still cancel and holds every token again", async () => {
  const w = await world();
  const before = await w.holdings();
  const expiry = (await w.chain.now()) + 3600;
  const early = await w.offer({ expiry }), late = await w.offer({ expiry });
  await w.approve(w.taker, w.bravo, 2n * w.BUY);
  await w.chain.setNextTime(expiry - 1);
  await w.deals.as(w.taker).fill(early); // one second before the expiry: it fills
  await w.chain.setNextTime(expiry);
  await refused(w.deals.as(w.taker).fill(late), "a fill in a block whose time is the deal's expiry");
  await refused(w.deals.as(w.taker).fill(late), "a second fill after the deal's expiry");
  await w.deals.as(w.maker).cancel(late);
  await w.moved(before, oneFill(w), "after one deal filled in time, and the other expired then cancelled by its maker");
});

await test("Cancel: only the maker cancels; then the maker holds every token again and a fill fails", async () => {
  const w = await world();
  await w.stock();
  const before = await w.holdings();
  const id = await w.offer({ taker: w.taker });
  await refused(w.deals.as(w.taker).cancel(id), "a cancel by the deal's taker");
  await refused(w.deals.as(w.other).cancel(id), "a cancel by a third address");
  await w.deals.as(w.maker).cancel(id);
  await w.moved(before, {}, "after createDeal then cancel");
  await w.approve(w.maker, w.alfa, w.SELL);
  await w.approve(w.taker, w.bravo, w.BUY);
  await refused(w.deals.as(w.taker).fill(id), "a fill of a cancelled deal");
  await w.moved(before, {}, "after a fill of the cancelled deal that must fail");
});

await test("Refused at creation: a zero amount, the same token on both sides, an expiry that is not in the future", async () => {
  const w = await world();
  await w.approve(w.maker, w.alfa, 10n * w.SELL);
  const later = (await w.chain.now()) + 100;
  const good = await w.terms({ expiry: later + 3600 });
  await w.create(w.maker, good); // good terms go through: an entry that refuses every deal does not pass
  await refused(w.create(w.maker, { ...good, sellAmount: 0n }), "createDeal with a sellAmount of zero");
  await refused(w.create(w.maker, { ...good, buyAmount: 0n }), "createDeal with a buyAmount of zero");
  await refused(w.create(w.maker, { ...good, buyToken: good.sellToken }), "createDeal with the same token on both sides");
  await w.chain.setNextTime(later);
  await refused(w.create(w.maker, { ...good, expiry: later }), "createDeal with an expiry equal to its block's time");
  await refused(w.create(w.maker, { ...good, expiry: later - 60 }), "createDeal with an expiry a minute in the past");
});

await test("Awkward tokens: a token whose transfer returns nothing (as USDT does) works as sellToken and as buyToken", async () => {
  const w = await world();
  const quiet = await w.token("NoReturnToken", "QUIET", 6);
  const before = await w.holdings();
  const hundred = w.units("100", quiet), forty = w.units("40", quiet);
  await w.accept(await w.offer({ sellToken: quiet.address, sellAmount: hundred })); // 100 QUIET for 0.75 BRAVO
  await w.accept(await w.offer({ buyToken: quiet.address, buyAmount: forty })); // 1500.25 ALFA for 40 QUIET
  await w.deals.as(w.maker).cancel(await w.offer({ sellToken: quiet.address, sellAmount: hundred }));
  await w.moved(before, { maker: { QUIET: forty - hundred, BRAVO: w.BUY, ALFA: -w.SELL }, taker: { QUIET: hundred - forty, BRAVO: -w.BUY, ALFA: w.SELL } },
    "after a fill with QUIET sold, a fill with QUIET bought, and a cancel of a deal selling QUIET");
});

await test("Re-entry: a token that calls back into fill or cancel during its transfer cannot make a deal pay twice", async () => {
  // EVIL is a token that, once armed, calls the contract back from inside its next transfer. In each case
  // it is one side of a deal, and sometimes its maker. A bystander's deal sells the same token meanwhile:
  // in a contract that keeps the makers' tokens, a deal paid twice is paid with the bystander's.
  const cases = [
    { what: "a fill during which the buyToken calls fill again", evilMakes: false, sell: "ALFA", buy: "EVIL", start: "fill", callback: "fill" },
    { what: "a fill during which the buyToken, which made the deal, calls cancel", evilMakes: true, sell: "ALFA", buy: "EVIL", start: "fill", callback: "cancel" },
    { what: "a cancel during which the sellToken, which made the deal, calls cancel again", evilMakes: true, sell: "EVIL", buy: "BRAVO", start: "cancel", callback: "cancel" },
  ];
  for (const c of cases) {
    const w = await world();
    const evil = await w.token("ReentrantToken", "EVIL", 18);
    await w.join("EVIL itself", evil.address);
    const maker = c.evilMakes ? evil.address : w.maker, makerName = c.evilMakes ? "EVIL itself" : "maker";
    const sell = w.tokens[c.sell], buy = w.tokens[c.buy], sold = w.units("300", sell), bought = w.units("7", buy);
    const before = await w.holdings();
    const bystanders = await w.offer({ sellToken: sell.address, sellAmount: sold }, w.other);
    const id = await w.offer({ sellToken: sell.address, sellAmount: sold, buyToken: buy.address, buyAmount: bought }, maker);
    await w.approve(maker, sell, 2n * sold); // room for a second payment, should the contract take the maker's tokens only at fill
    await w.approve(evil.address, buy, bought); // EVIL can pay as a second taker
    await w.approve(w.taker, buy, bought);
    await evil.as(w.other).arm(w.deals.address, w.deals.interface.encodeFunctionData(c.callback, [id]));
    // The attack. It may go through once or revert as a whole; it must not pay twice.
    await (c.start === "fill" ? w.deals.as(w.taker).fill(id) : w.deals.as(maker).cancel(id)).catch((e) => { if (!(e instanceof Reverted)) throw e; });
    // Everything still open is cancelled; then each side holds what one fill, or none, leaves it.
    await w.deals.as(w.other).cancel(bystanders).catch((e) => { throw new Error(`after ${c.what}, the bystander cannot cancel their own open deal: ${e.message}`); });
    const deal = await w.deals.read.getDeal(id);
    if (deal.status === STATUS.Open) await w.deals.as(maker).cancel(id);
    const filled = deal.status === STATUS.Filled;
    await w.moved(before, filled ? { [makerName]: { [c.sell]: -sold, [c.buy]: bought }, taker: { [c.sell]: sold, [c.buy]: -bought } } : {},
      `after ${c.what} (the deal ends ${STATUS_NAME[deal.status]}, so ${filled ? "exactly one fill" : "nothing"} must have moved)`);
  }
});

await test("Nobody else: besides createDeal, fill and cancel, no function of the contract changes anything; no constructor argument, no fallback, nothing payable", async () => {
  const { abi } = artifacts().entry;
  const changing = abi.filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure").map((f) => f.name).sort();
  check(changing.join(", ") === "cancel, createDeal, fill", `the functions of OtcDeals that can change state are ${changing.join(", ") || "none"}; expected exactly cancel, createDeal, fill (anything else it offers must be view or pure)`);
  const payable = abi.filter((f) => f.stateMutability === "payable").map((f) => f.name ?? f.type);
  check(!payable.length, `OtcDeals takes ether in ${payable.join(", ")}: nothing in it is payable`);
  for (const type of ["fallback", "receive"]) check(!abi.some((f) => f.type === type), `OtcDeals has a ${type} function: it has none`);
  // A constructor that takes arguments fails this test and every other before it starts: compile.mjs refuses it.
});

await test("Interface: ids count up from 1, getDeal returns each deal's terms and status, an unknown id has status None, and createDeal, fill and cancel emit their events", async () => {
  const fixed = new Interface(OTC_DEALS), entrys = new Interface(artifacts().entry.abi);
  const shape = (f) => f && `${f.format("sighash")} ${f.stateMutability ?? ""} ${(f.outputs ?? f.inputs).map((p) => `${p.format("sighash")}${p.indexed ? " indexed" : ""}`).join(",")}`;
  for (const f of fixed.fragments) {
    const theirs = f.type === "event" ? entrys.getEvent(f.format("sighash")) : entrys.getFunction(f.format("sighash"));
    check(shape(theirs) === shape(f), `OtcDeals must have ${f.format("full")}, exactly as in contracts/IOtcDeals.sol; ${theirs ? `it has ${theirs.format("full")}` : "it does not"}`);
  }
  const w = await world();
  await w.approve(w.maker, w.alfa, 2n * w.SELL);
  const terms = [await w.terms({ taker: w.taker }), await w.terms({ sellAmount: w.SELL - 1n, buyAmount: w.BUY + 1n })];
  const emitted = (events, name, ...args) => events.some((e) => e.name === name && e.args.length === args.length && args.every((a, i) => same(e.args[i], a)));
  for (const [i, t] of terms.entries()) {
    const id = i + 1;
    check(emitted(await w.create(w.maker, t), "DealCreated", id, w.maker, t.taker), `createDeal number ${id} on a new contract must emit DealCreated(${id}, maker, taker)`);
    const deal = await w.deals.read.getDeal(id);
    for (const field of Object.keys(t)) check(same(deal[field], t[field]), `getDeal(${id}).${field} is ${deal[field]}; createDeal number ${id} was given ${t[field]}`);
    check(same(deal.maker, w.maker) && deal.status === STATUS.Open, `getDeal(${id}) must have the caller of createDeal as maker and status Open; it has maker ${deal.maker} and status ${STATUS_NAME[deal.status]}`);
  }
  await w.approve(w.taker, w.bravo, w.BUY);
  check(emitted(await w.deals.as(w.taker).fill(1), "DealFilled", 1, w.taker), "fill(1) must emit DealFilled(1, the address that filled)");
  check(emitted(await w.deals.as(w.maker).cancel(2), "DealCancelled", 2), "cancel(2) must emit DealCancelled(2)");
  for (const [id, status] of [[1, "Filled"], [2, "Cancelled"], [3, "None"], [0, "None"]]) {
    const deal = await w.deals.read.getDeal(id).catch((e) => { throw new Error(`getDeal(${id}) must answer a deal with status ${status}, never fail (${e.message})`); });
    check(deal.status === STATUS[status], `getDeal(${id}).status is ${STATUS_NAME[deal.status]}; expected ${status}`);
  }
});

// -------------------------------------------------------------------------------------------------- the page

/** The amount a handle shows, in the token's smallest unit; null unless it is a plain number ("1500.25", "1,500.25"). */
function amount(text, token) {
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/.test(text)) return null;
  try {
    return parseUnits(text.replaceAll(",", ""), token.decimals);
  } catch {
    return null; // more decimals than the token has
  }
}
const statusIs = (page, status, what) => shows(page, "deal-status", (s) => s === status, `"${status}" for ${what}`, "data-status");
/** The page has come to rest without offering primary-action: a moment for it to settle, then it must not be offered. */
async function offersNothing(page, where) {
  await page.waitForTimeout(500);
  await until(async () => !(await offered(page)), `${where} offers primary-action: it must be missing, hidden or disabled`, 5000);
}

await test("Show: an open deal's link shows what the taker pays and receives, the maker and the expiry, with no wallet in the browser", async () => {
  const w = await world();
  const expiry = (await w.chain.now()) + 86_400;
  const id = await w.offer({ expiry });
  const site = await serve(w);
  await withPage(site, `#/d/${id}`, null, async (page) => {
    await statusIs(page, "open", "an open deal");
    await shows(page, "pay-amount", (t) => amount(t, w.bravo) === w.BUY, "0.75, the deal's buyAmount in whole BRAVO (18 decimals), as a plain number");
    await shows(page, "pay-symbol", (t) => t === "BRAVO", '"BRAVO", the buyToken\'s symbol');
    await shows(page, "receive-amount", (t) => amount(t, w.alfa) === w.SELL, "1500.25 (or 1,500.25), the deal's sellAmount in whole ALFA (6 decimals), as a plain number");
    await shows(page, "receive-symbol", (t) => t === "ALFA", '"ALFA", the sellToken\'s symbol');
    await shows(page, "maker", (t) => same(t, w.maker), `the maker's address in full, ${w.maker}`);
    await shows(page, "expires", (t) => t === String(expiry), `"${expiry}", the deal's expiry in unix seconds`, "data-expiry");
  }).finally(site.close);
});

await test("Fill from the page: with a wallet that holds the tokens, at most four presses of primary-action end with the deal filled on the chain and deal-status saying so", async () => {
  const w = await world();
  const before = await w.holdings();
  const id = await w.offer();
  const site = await serve(w);
  await withPage(site, `#/d/${id}`, wallet(w, w.taker), async (page) => {
    await statusIs(page, "open", "an open deal");
    await pressUntil(page, async () => (await w.deals.read.getDeal(id)).status === STATUS.Filled, `deal ${id} filled on the chain by the wallet's account`);
    await statusIs(page, "filled", "the deal the wallet just filled");
    await w.moved(before, oneFill(w), "after the fill from the page");
  }).finally(site.close);
});

await test("States: a filled, a cancelled and an expired deal, and an id that does not exist, each say so and offer no fill", async () => {
  const w = await world();
  // The expired deal is still open on the chain; it expires in a few seconds, by the chain's clock and the browser's.
  const expiry = Math.max(await w.chain.now(), Math.floor(Date.now() / 1000)) + 4;
  const expired = await w.offer({ expiry });
  const filled = await w.offer(), cancelled = await w.offer();
  await w.accept(filled);
  await w.deals.as(w.maker).cancel(cancelled);
  const site = await serve(w);
  const says = (id, status, what) => withPage(site, `#/d/${id}`, null, async (page) => {
    await statusIs(page, status, what);
    await offersNothing(page, `the page of ${what}`);
  });
  try {
    await says(filled, "filled", "a filled deal");
    await says(cancelled, "cancelled", "a cancelled deal");
    await says(999, "not-found", "an id no deal has");
    await until(() => Date.now() / 1000 > expiry + 1, "waiting for the deal to expire", 15_000);
    await w.chain.mine();
    await says(expired, "expired", "a deal still open on the chain whose expiry has passed");
  } finally {
    await site.close();
  }
});

await test("Not for you: a deal reserved for one address, opened with another wallet, names the address it is for and offers no fill", async () => {
  const w = await world();
  const id = await w.offer({ taker: w.taker });
  const before = await w.holdings();
  const site = await serve(w);
  await withPage(site, `#/d/${id}`, wallet(w, w.other), async (page) => {
    await statusIs(page, "open", "an open deal");
    const named = async () => (await seen(page, "notice"))?.toLowerCase().includes(w.taker);
    await pressUntil(page, async () => (await named()) && !(await offered(page)), `a notice that contains ${w.taker}, the address the deal is for, with primary-action no longer offered`);
    await offersNothing(page, "once the other wallet is connected, the page of a deal reserved for another address");
    check(await named(), `notice must go on naming ${w.taker}, the address the deal is for; it is ${JSON.stringify(await seen(page, "notice"))}`);
    check((await w.deals.read.getDeal(id)).status === STATUS.Open, "the deal is no longer open on the chain");
    await w.moved(before, {}, "after another wallet opened the reserved deal");
  }).finally(site.close);
});

await test("Create from the page: the form at /#/new and at most four presses of primary-action end with a link in deal-link to a deal with exactly the entered terms, which its taker can fill", async () => {
  const w = await world();
  const before = await w.holdings();
  const entered = { "sell-token": w.alfa.address, "sell-amount": "250.5", "buy-token": w.bravo.address, "buy-amount": "0.125", taker: w.taker, "expiry-hours": "48" };
  const sold = w.units("250.5", w.alfa), bought = w.units("0.125", w.bravo);
  const site = await serve(w);
  await withPage(site, "#/new", wallet(w, w.maker), async (page) => {
    for (const [id, value] of Object.entries(entered)) {
      await until(async () => (await page.getByTestId(id).count()) === 1, `the form at /#/new must have one input with data-testid="${id}"`);
      await page.getByTestId(id).fill(value).catch((e) => { throw new Error(`${id} must be a text input the checks can type "${value}" into: ${e.message.split("\n")[0]}`); });
    }
    const from = Math.floor(Date.now() / 1000);
    const link = () => page.getByTestId("deal-link").evaluate((el) => el.href || el.textContent.trim()).catch(() => null);
    await pressUntil(page, async () => /#\/d\/\d+$/.test((await link()) ?? ""), "a link ending in #/d/<id> in deal-link");
    const id = Number(/(\d+)$/.exec(await link())[1]);
    check((await link()) === `${site.url}/#/d/${id}`, `deal-link is ${await link()}; expected ${site.url}/#/d/${id}, the address the page is served from, then #/d/<id>`);
    const deal = await w.deals.read.getDeal(id);
    const want = { maker: w.maker, taker: w.taker, sellToken: w.alfa.address, sellAmount: sold, buyToken: w.bravo.address, buyAmount: bought };
    for (const [field, value] of Object.entries(want)) check(same(deal[field], value), `deal ${id}, the one behind the link, has ${field} ${deal[field]}; the form and the wallet say ${value}`);
    check(deal.status === STATUS.Open, `deal ${id}, the one behind the link, has status ${STATUS_NAME[deal.status]}; expected Open`);
    const hours = (Number(deal.expiry) - from) / 3600;
    check(Math.abs(hours - 48) < 0.1, `deal ${id} expires ${hours.toFixed(2)} hours after the form was sent; expiry-hours was 48`);
    await w.accept(id);
    await w.moved(before, { maker: { ALFA: -sold, BRAVO: bought }, taker: { ALFA: sold, BRAVO: -bought } }, "after the taker filled the deal made from the page");
  }).finally(site.close);
});

done();
