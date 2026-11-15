# otc.fam: the plan

otc.fam is a link for one OTC token deal. This file says what is fixed, what each round adds, and which
parts are the creator's words and which are proposals he can still change.

## What the creator asked for

- A link for one deal, like a calendar link, that one side sends to the other.
- Totally non-custodial.
- A page that looks like Uniswap, not like a SaaS form.

Everything else below is **proposed**: the chain, the contract's shape, the link's format, the rounds.

## The parts

```
contracts/IOtcDeals.sol   the fixed interface of the deal contract
contracts/OtcDeals.sol    its implementation (round 1)
web/                      the page, built into dist/ by "npm run build"
web/config.json           { "chainId", "contract", "rpcUrl" }: read by the page when it loads
scripts/deploy.mjs        deploys OtcDeals; RPC_URL and DEPLOYER_KEY come from the environment only
```

**The contract** (Solidity, any EVM chain). One contract holds every deal. A deal says: the maker gives
`sellAmount` of `sellToken` and wants `buyAmount` of `buyToken`, from one named taker or from anyone,
until `expiry`. `createDeal` makes it, `fill` swaps the tokens in one transaction, `cancel` gives the
maker's tokens back, `getDeal` reads it. Ids count up from 1. The contract has no owner, no fee, no
upgrade and no pause. Whether it keeps the maker's tokens from `createDeal` or takes them at `fill` is
each entry's choice in round 1.

**The page** (static files, no server). It reads `config.json`, then the deal from the chain through
`rpcUrl`: a person sees a deal before connecting any wallet. Sending a transaction goes through the
browser's wallet (`window.ethereum`).

**The link.** `<site>/#/d/<id>` shows deal `<id>`; `<site>/#/new` makes one.

**The handles.** The page marks what it shows with `data-testid` attributes (`deal-status`, `pay-amount`,
`primary-action`…), listed in round 1's brief. The checks and later rounds rely on them: a round may add
handles, never rename one.

## The rounds

| Round | Title | What it adds | How it is checked | Prize |
| --- | --- | --- | --- | --- |
| 1 | One deal, one link | The deal contract, and the smallest page that shows a deal from its link and fills it | The contract on a local chain with the checks' own tokens; the built page in a browser with a stand-in wallet | 1,000,000 points |
| 2 | The page people send around (proposed) | The Uniswap look, real wallets, a deployment on a test network, the link's preview in Telegram, warnings about tokens, so that a fake token is noticed | Decided after round 1 | To set |
| 3 | What a real deal needs (proposed) | Decided after the creator has shown round 2 to three people who do OTC deals | Decided after round 2 | To set |

Only round 1 is specified. Rounds 2 and 3 are added on Hotpod, each after the one before has settled.

## Where it runs

- **Checks:** a chain inside the check's own process, with no network. The compiler is solc 0.8.38,
  optimizer on (200 runs), EVM version cancun.
- **Demo (proposed):** Base Sepolia, after round 1 is merged. The creator deploys with his own key; no key
  is ever in this repository. `web/config.json` holds Base Sepolia's chain id and a zero address until then.
- **Any main network:** not before a security review of the winning contract. Depending on the winning
  design, the contract holds the makers' tokens between `createDeal` and `fill` or `cancel`.

## What it is not

Points only on Hotpod: no token, no fee, nothing to pay. otc.fam takes no custody and gives no advice
about any token or any deal.
