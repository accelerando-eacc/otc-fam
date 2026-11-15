---
title: otc.fam
payout: top3-60-25-15
pick: creator-in-judging
build_hours: 24
reveal_hours: 3
rank_hours: 4
opens_at: 2026-11-20T09:00:00Z
---

# Pitch

People still do OTC token deals over Telegram, and it gets complicated. otc.fam is a link for one deal, like a calendar link: "I sent you my otc.fam link, can you check it and send the tokens there?" The other side opens the link, sees what they pay and what they receive, and fills it. It is non-custodial: no person and no company ever holds the tokens. The page looks like Uniswap, not like a SaaS form.

# Round 1: One deal, one link

prize: 1000000
criteria:
- Safety (counts triple): tokens move only as the deal says; nobody but the two sides can take anything; awkward tokens and re-entry are handled; nothing can be paused, upgraded or drained
- [product] The link (counts double): a person who opens it sees at once what they pay, what they get, from whom and until when, and what to press; every state is said in plain words
- Correctness: every path of a deal does what the brief says, edges included
- Code quality: a small contract and a small page that read easily; no dependency that is not needed

Build the deal contract of otc.fam and the smallest page that shows one deal from its link and fills it.

The words used here. A **deal** is one offer to swap two tokens. Its **maker** creates it and gives the **sell token**; its **taker** fills it and gives the **buy token**. To **fill** a deal is to swap both amounts in one transaction. To **cancel** it is to withdraw the offer. A **token** is an ERC-20 contract; before a contract can take someone's tokens, that person **approves** it for an amount (their **allowance**). A **handle** is a `data-testid` attribute the page puts on an element so that the checks can find it.

## What you deliver

1. `contracts/OtcDeals.sol`: a contract named `OtcDeals` that implements `contracts/IOtcDeals.sol`. Its constructor takes no argument. Do not change `IOtcDeals.sol`.
2. `web/`: a static page. `npm run build` makes the site in `dist/`, with `dist/index.html`.
3. `scripts/deploy.mjs`: `RPC_URL=… DEPLOYER_KEY=… npm run deploy` deploys `OtcDeals` to the network at `RPC_URL` with the private key in `DEPLOYER_KEY`, and prints the contract's address. Both values come from the environment and are never written to a file.

Leave `.launchpad/` and `.github/` as they are: an entry that changes the checks fails.

## The contract

The interface is fixed:

```solidity
interface IOtcDeals {
    enum Status { None, Open, Filled, Cancelled }
    struct Deal {
        address maker;      // who offers
        address taker;      // who may fill; address(0) = anyone
        address sellToken;  // what the maker gives
        uint256 sellAmount;
        address buyToken;   // what the maker wants
        uint256 buyAmount;
        uint64 expiry;      // unix seconds; a fill at or after it fails
        Status status;
    }
    event DealCreated(uint256 indexed id, address indexed maker, address indexed taker);
    event DealFilled(uint256 indexed id, address indexed taker);
    event DealCancelled(uint256 indexed id);

    function createDeal(address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, address taker, uint64 expiry) external returns (uint256 id);
    function fill(uint256 id) external;
    function cancel(uint256 id) external;
    function getDeal(uint256 id) external view returns (Deal memory);
}
```

What it must do. "Fails" means the call reverts.

- **Ids.** The first deal of a contract has id 1, the next 2, and so on. `getDeal` returns the deal's terms, its maker (the caller of `createDeal`) and its status. For an id no deal has, it returns a deal with status `None`: it does not fail.
- **Events.** `createDeal` emits `DealCreated(id, maker, taker)`, `fill` emits `DealFilled(id, the address that filled)`, `cancel` emits `DealCancelled(id)`.
- **Fill.** After `createDeal` then `fill`, the maker holds exactly `buyAmount` more of `buyToken`, the taker holds exactly `sellAmount` more of `sellToken`, and the contract holds nothing of either. There is no fee.
- **All or nothing.** A fill that cannot complete (the taker does not hold `buyAmount`, or has not approved the contract for it) fails and changes no balance.
- **Private and open.** A deal with a taker is filled only by that address. A deal with `address(0)` as taker is filled by anyone.
- **Once.** A deal fills once. A filled or cancelled deal cannot be filled or cancelled again.
- **Expiry.** A fill in a block whose time is at or after `expiry` fails. The maker can still cancel, and then holds every token again.
- **Cancel.** Only the maker cancels, and only an open deal. After it the maker holds every token again, and a fill fails.
- **Refused at creation.** `createDeal` fails for a `sellAmount` or `buyAmount` of zero, for the same token on both sides, and for an `expiry` that is not in the future (at or before the block's time).
- **Awkward tokens.** Some tokens' `transfer` and `transferFrom` return nothing instead of `true` (USDT on Ethereum does). Such a token works as `sellToken` and as `buyToken`.
- **Re-entry.** A hostile token can call `fill` or `cancel` again from inside its own transfer. That must never make a deal pay twice: not to the taker, not to the maker, and not with the tokens of another maker's deal.
- **Nobody else.** No owner, no admin, no fee, no upgrade, no pause. The checks hold this to what a machine can see: the only functions that change anything are `createDeal`, `fill` and `cancel` (any other function is `view` or `pure`), nothing is payable, there is no `fallback` or `receive`, and the constructor takes no argument. The judges read the rest.

What is yours to choose: whether the contract keeps the maker's tokens from `createDeal` until the fill or the cancel, or takes them from the maker at `fill` (the checks look at what each side holds before and after, not at how; their maker approves the contract for `sellAmount` before `createDeal`, which suits both); the errors; the storage; any library.

The checks compile `contracts/OtcDeals.sol` with solc 0.8.38, optimizer on (200 runs), EVM version `cancun`: your `pragma` must accept 0.8.38. Imports are read from the repository (`./IOtcDeals.sol`) and from its `node_modules` (a package you add to `package.json`).

## The page

- **Links.** `<site>/#/d/<id>` shows deal `<id>` (the id in decimal). `<site>/#/new` makes a deal. `<site>` is wherever `dist/` is served: the page works from any address and any folder.
- **Config.** When it loads, the page fetches `config.json` from next to `index.html` (a relative URL): `{ "chainId": number, "contract": "0x…", "rpcUrl": "…" }`. Never copy these values into the build: the checks serve their own `config.json`, and after the merge the creator puts the deployed contract's address there.
- **Reading.** The page reads the chain by JSON-RPC (HTTP POST) at `rpcUrl`, and shows a deal from that alone: before any wallet is connected, and in a browser that has no wallet at all (`window.ethereum` is undefined).
- **Sending.** Transactions go through the injected wallet, `window.ethereum` (EIP-1193: `request({ method, params })`, `on`, `removeListener`). No wallet library is required. The checks' wallet is on the chain of `config.json`, gives no account until the page calls `eth_requestAccounts`, then emits `accountsChanged`.
- **Nothing from outside.** The page loads nothing from another host: no CDN, no remote font, script or image. The checks run with no network.
- **Amounts** are in whole tokens, using each token's own `decimals()`: 1500250000 of a token with 6 decimals is `1500.25`. Symbols come from the token's `symbol()`.

The handles of a deal's page, `/#/d/<id>`. Each is on one element only, and the page never holds two elements with the same handle.

| Handle | What it holds |
| --- | --- |
| `deal-status` | The deal's state in words of yours, and in its `data-status` attribute exactly one of `open`, `filled`, `cancelled`, `expired`, `not-found`. `expired`: the deal is still open on the chain and its expiry has passed (by the chain's latest block or by the browser's clock: the checks keep the two together). `not-found`: no deal has this id. |
| `pay-amount`, `pay-symbol` | What the taker pays: `buyAmount` and the buy token's symbol. The amount is a plain number and nothing else: digits, a dot before the decimals, never rounded (`0.75`, `1500.25`; `1,500.25` is accepted too). The symbol is exactly the token's. |
| `receive-amount`, `receive-symbol` | What the taker receives: `sellAmount` and the sell token's symbol, written the same way. |
| `maker` | The maker's address in full, `0x` and 40 hex digits. |
| `expires` | When the deal expires, in words of yours, and in its `data-expiry` attribute the expiry in unix seconds (`data-expiry="1795000000"`). |
| `primary-action` | The one button that moves the deal forward: connect the wallet, approve the token, fill. |
| `notice` | A message for the person, when the page has one: why they cannot fill this deal, or what went wrong. |

The handles of `/#/new`: `sell-token` and `buy-token` (token addresses), `sell-amount` and `buy-amount` (whole tokens, like `250.5`), `taker` (an address, or empty for anyone), `expiry-hours` (the deal expires that many hours after it is created), all six `<input>` fields the checks type into; `primary-action`; and `deal-link`, which appears once the deal exists: an `<a>` whose `href` is the deal's link (or an element whose text is the link).

How the page must behave:

- **Show.** An open deal's link shows what the taker pays and receives, the maker and the expiry, with no wallet.
- **The button.** The checks press `primary-action` whenever it is visible and enabled, and wait while it is not. So disable it as soon as it is pressed (in the click handler itself, before anything is awaited), and enable it again only when the page is ready for the next press. With a wallet that holds the tokens, at most four presses fill an open deal (for example: connect, approve, fill), and `deal-status` then says `filled`. The checks' wallet says yes to every request at once: there is no confirmation to wait for.
- **States.** For a filled, a cancelled or an expired deal, and for an id no deal has, `deal-status` says so and `primary-action` is missing, hidden or disabled, wallet or not.
- **Not for you.** When the connected wallet is not the taker of a deal reserved for one address, `notice` says the deal is for another address and contains that address in full, and `primary-action` is missing, hidden or disabled.
- **Create.** On `/#/new`, with the six fields filled and a wallet that holds the sell token, at most four presses of `primary-action` (for example: connect, approve, create) end with `deal-link` showing `<site>/#/d/<id>`, built from the address the page is served from. That deal on the chain has exactly the entered terms, the wallet's account as maker and an expiry `expiry-hours` hours after its creation, and its taker can fill it.

What is yours to choose: the look, the words, the layout, plain files or a framework, a bundler or none, and what the page shows beyond the handles. A dependency you add goes in `package.json` and `package-lock.json`; entries are installed with `npm ci`, install scripts off, registry packages only. The base's `devDependencies` are the checks' tools (solc, ethers, Playwright and a local chain): your scripts may use them.

## The checks

Sixteen tests, named after the rules above: eleven on the contract, five on the page. Run them yourself:

```sh
npm ci
npx playwright install chromium
npm run check
```

Each test starts from a fresh local chain with your `OtcDeals` deployed, the checks' own tokens (a plain one, one that returns nothing, a hostile one) and a few addresses that hold them. The page tests run `npm run build`, serve `dist/` on `127.0.0.1` with their own `config.json`, and use the page in Chromium, at phone width, through the handles. A failing test says what was expected and what happened. On Hotpod the same checks run in a container with no network, 2 CPUs and 2 GB, and must finish within 300 seconds, your build included.

The checks do not run `scripts/deploy.mjs`, and they cannot see everything that makes a contract safe or a page clear: the judges do.

## What users see

Every judge looks at these five scenes before reading any code, as the person who was sent the link, on a phone-width screen:

1. An open deal's link, in a browser with no wallet. At a glance: what do I pay, what do I get, from whom, until when, and what do I press?
2. The same link with a wallet that holds the tokens: each press of the button until the deal is filled. Does every step say what it is about to do, and does the end say that it is done?
3. The links of a filled deal, a cancelled deal, an expired deal, and an id no deal has. Does each say what happened, in plain words?
4. A deal reserved for one address, opened with another wallet. Does the page say why this wallet cannot fill it?
5. `/#/new` with a wallet: the form, each press, and the link at the end. Would I know what to send to the other side?

`node .launchpad/checks/round-1/play.mjs` plays the five scenes on a local chain with the checks' tokens and wallet. For each step it prints the text a person reads and saves a screenshot in `screens/`.

## How to run it

```sh
npm ci && npx playwright install chromium
npm run build      # the site, in dist/
npm run check      # the sixteen tests
node .launchpad/checks/round-1/play.mjs    # the five scenes: text on the terminal, screenshots in screens/
```

- C1 (safety): read `contracts/OtcDeals.sol` from top to bottom. Follow every transfer: who can make it happen, and with which state already written. Look for anything the checks cannot see: a hidden owner, a token that returns `false`, a way to drain another maker's deal.
- C2 (the link): play the five scenes and look at each screenshot before reading the page's code.
- C3 (correctness): run the checks, then try what they leave out: a deal for a token with 0 decimals, an amount with more decimals than the token has, a wallet on another chain, a transaction that fails.
- C4 (code quality): read the contract, `web/` and `scripts/deploy.mjs`, and what the entry added to `package.json`. To try the deployment, run `npm run deploy` against a test network with a key that holds nothing of value.
