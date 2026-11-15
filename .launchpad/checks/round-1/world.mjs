// A fresh world for one test: a new chain, the entry's OtcDeals deployed on it, two plain tokens (ALFA with
// 6 decimals, BRAVO with 18) and four people. The maker, the taker and a third person ("other") hold a
// million of each token; "broke" holds none. Nobody has approved anything.
import { contractAt, deploy, Reverted, startChain } from "./chain.mjs";
import { compileEntry, compileTokens } from "./compile.mjs";
import { formatUnits, parseUnits } from "./tools.mjs";

/** The fixed interface (contracts/IOtcDeals.sol), as the checks call it whatever the entry's copy says. */
export const OTC_DEALS = [
  "event DealCreated(uint256 indexed id, address indexed maker, address indexed taker)",
  "event DealFilled(uint256 indexed id, address indexed taker)",
  "event DealCancelled(uint256 indexed id)",
  "function createDeal(address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, address taker, uint64 expiry) returns (uint256 id)",
  "function fill(uint256 id)",
  "function cancel(uint256 id)",
  "function getDeal(uint256 id) view returns (tuple(address maker, address taker, address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, uint64 expiry, uint8 status))",
];
export const STATUS = { None: 0n, Open: 1n, Filled: 2n, Cancelled: 3n };
export const STATUS_NAME = ["None", "Open", "Filled", "Cancelled"];
/** Whether two addresses (or any two values, as text) are the same, whatever the letters' case. */
export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
/** The taker of a deal anyone may fill. */
export const ANYONE = `0x${"00".repeat(20)}`;

const PEOPLE = {
  deployer: "0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
  maker: "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
  taker: "0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  other: "0x9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d",
  broke: "0x0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
};
const HOLDERS = ["maker", "taker", "other"];
const MILLION = 1_000_000n;

let compiled;
/** The entry's contract and the checks' tokens, compiled once. A compile error is every test's failure. */
export function artifacts() {
  compiled ??= (() => {
    try {
      return { entry: compileEntry(), tokens: compileTokens() };
    } catch (error) {
      return { error };
    }
  })();
  if (compiled.error) throw compiled.error;
  return compiled;
}

/** `sending` must revert: resolves if it did, throws if the transaction went through. */
export async function refused(sending, what) {
  try {
    await sending;
  } catch (e) {
    if (e instanceof Reverted) return;
    throw e;
  }
  throw new Error(`${what} went through: it must fail (revert)`);
}

export async function world() {
  const { entry, tokens: kinds } = artifacts();
  const chain = await startChain(Object.values(PEOPLE));
  /** Who holds what is watched: the people, the contract, and whoever joins. */
  const parties = { ...PEOPLE };
  const tokens = {};
  const tokenAt = (address) => Object.values(tokens).find((t) => same(t.address, address));
  const nameOf = (address) => Object.entries(parties).find(([, a]) => same(a, address))?.[0] ?? tokenAt(address)?.symbol;
  const show = (v) => (typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) ? (v === ANYONE ? "address(0)" : nameOf(v) ?? v) : String(v));
  const at = (abi, address, label) => contractAt(chain, abi, address, { label, show });

  const deals = at(OTC_DEALS, (await deploy(chain, PEOPLE.deployer, entry, [], { label: "OtcDeals" })).address, "OtcDeals");
  parties.contract = deals.address;
  let created = 0;

  const w = {
    chain, deals, tokens, ...PEOPLE,
    /** `"1500.25"` of `token` in its smallest unit. */
    units: (amount, token) => parseUnits(amount, token.decimals),
    /** Deploys one of the checks' tokens (PlainToken, NoReturnToken, ReentrantToken) and gives the three holders a million each. */
    async token(kind, symbol, decimals) {
      const t = at(kinds[kind].abi, (await deploy(chain, PEOPLE.deployer, kinds[kind], [symbol, decimals], { label: symbol })).address, symbol);
      Object.assign(t, { symbol, decimals });
      tokens[symbol] = t;
      for (const who of HOLDERS) await t.as(PEOPLE.deployer).mint(PEOPLE[who], MILLION * 10n ** BigInt(decimals));
      return t;
    },
    /** A contract that acts as a party to deals: it gets gas and a million of every token, and its holdings are watched. */
    async join(name, address) {
      parties[name] = address;
      await chain.fund(address);
      for (const t of Object.values(tokens)) await t.as(PEOPLE.deployer).mint(address, MILLION * 10n ** BigInt(t.decimals));
    },
    /** `owner` lets the contract take `amount` of `token`. */
    approve: (owner, token, amount) => token.as(owner).approve(deals.address, amount),
    /** The default terms (1500.25 ALFA for 0.75 BRAVO, anyone, an hour from now), with `changes`. */
    async terms(changes = {}) {
      return { sellToken: w.alfa.address, sellAmount: w.SELL, buyToken: w.bravo.address, buyAmount: w.BUY, taker: ANYONE, expiry: (await chain.now()) + 3600, ...changes };
    },
    /** `from` calls createDeal with `terms`; returns the events. No approval is made here. */
    create: (from, t) => deals.as(from).createDeal(t.sellToken, t.sellAmount, t.buyToken, t.buyAmount, t.taker, t.expiry),
    /** `from` (the maker by default) approves the sell amount and creates a deal with the default terms and `changes`; returns its id. */
    async offer(changes = {}, from = PEOPLE.maker) {
      const t = await w.terms(changes);
      await w.approve(from, tokenAt(t.sellToken), t.sellAmount);
      await w.create(from, t);
      const id = ++created;
      const deal = await deals.read.getDeal(id);
      if (deal.status !== STATUS.Open || !same(deal.maker, from)) {
        throw new Error(`createDeal number ${id} on this contract went through, but getDeal(${id}) is not that open deal (status ${STATUS_NAME[deal.status] ?? deal.status}, maker ${show(deal.maker)}): ids count up from 1`);
      }
      return id;
    },
    /** `from` (the taker by default) approves the buy amount of deal `id` and fills it. */
    async accept(id, from = PEOPLE.taker) {
      const deal = await deals.read.getDeal(id);
      await w.approve(from, tokenAt(deal.buyToken), deal.buyAmount);
      await deals.as(from).fill(id);
    },
    /**
     * Keeps a call that must fail from failing merely for lack of tokens: one more deal of the maker stays
     * open (its tokens may sit in the contract), and the contract may take one more sell amount from the maker.
     */
    async stock() {
      await w.offer();
      await w.approve(PEOPLE.maker, w.alfa, w.SELL);
    },
    /** What everyone watched holds of every token: `{ maker: { ALFA: 1000000000000n, … }, …, contract: { … } }`. */
    async holdings() {
      const all = {};
      for (const [who, address] of Object.entries(parties)) {
        all[who] = {};
        for (const t of Object.values(tokens)) all[who][t.symbol] = await t.read.balanceOf(address);
      }
      return all;
    },
    /**
     * Throws unless holdings changed since `before` by exactly `changes` (`{ maker: { ALFA: -sold, BRAVO: bought }, … }`)
     * and by nothing else: whoever is not named, the contract included, holds what it held.
     */
    async moved(before, changes, when) {
      const now = await w.holdings();
      const wrong = [];
      for (const who of Object.keys(before)) {
        for (const t of Object.values(tokens)) {
          if (before[who][t.symbol] === undefined) continue;
          const got = now[who][t.symbol] - before[who][t.symbol], want = BigInt(changes[who]?.[t.symbol] ?? 0n);
          const signed = (n) => `${n > 0n ? "+" : ""}${formatUnits(n, t.decimals)}`;
          if (got !== want) wrong.push(`${who === "contract" ? "the contract" : who}'s ${t.symbol} changed by ${signed(got)}, expected ${signed(want)}`);
        }
      }
      if (wrong.length) throw new Error(`${when}: ${wrong.join("; ")}`);
    },
  };
  w.alfa = await w.token("PlainToken", "ALFA", 6);
  w.bravo = await w.token("PlainToken", "BRAVO", 18);
  w.SELL = w.units("1500.25", w.alfa);
  w.BUY = w.units("0.75", w.bravo);
  return w;
}
