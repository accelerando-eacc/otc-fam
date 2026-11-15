// The entry's page, as a person gets it: built by "npm run build" (a child process), served from dist/ on
// 127.0.0.1 with the checks' own config.json and a read-only JSON-RPC endpoint, and opened in Chromium (a
// child process too), with the checks' wallet as window.ethereum or with no wallet at all.
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, sep } from "node:path";
import { CHAIN_ID } from "./chain.mjs";
import { entry, ROOT, workspace } from "./lib/entry.mjs";
import { chromium } from "./tools.mjs";

const WAIT_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `probe` until it answers something truthy, and returns it; throws `what` (text, or a function that words it) after `ms`. */
export async function until(probe, what, ms = WAIT_MS) {
  for (const end = Date.now() + ms; ;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > end) throw new Error(`${typeof what === "function" ? await what() : what} (waited ${ms / 1000} s)`);
    await sleep(100);
  }
}

let built;
/** Runs the entry's "npm run build" once; every page test waits for it, and fails with its error. */
function build() {
  built ??= (async () => {
    const npm = entry("npm", ["run", "build"], { timeoutMs: 120_000, env: { npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" } });
    const run = await npm();
    if (run.code !== 0) throw new Error(`npm run build exited with ${run.code ?? run.signal}:\n${(run.err || run.out).trim().slice(-600)}`);
    if (!existsSync(join(ROOT, "dist", "index.html"))) throw new Error("npm run build left no dist/index.html");
    return realpathSync(join(ROOT, "dist"));
  })();
  return built;
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves the built page for the world `w`: dist/ as files, /config.json naming w's contract and chain, and
 * /rpc, the chain's read-only endpoint. Returns `{ url, close }`.
 */
export async function serve(w) {
  const dist = await build();
  let url;
  const server = createServer(async (req, res) => {
    const send = (status, type, body) => res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
    try {
      const path = decodeURIComponent(new URL(req.url, url).pathname);
      if (req.method === "POST" && path === "/rpc") {
        let body = "";
        for await (const chunk of req) if ((body += chunk).length > 1_000_000) return send(413, "text/plain", "too large");
        return send(200, "application/json", JSON.stringify(await w.chain.publicRpc(JSON.parse(body))));
      }
      if (req.method !== "GET") return send(405, "text/plain", "GET, or POST /rpc");
      if (path === "/config.json") return send(200, "application/json", JSON.stringify({ chainId: CHAIN_ID, contract: w.deals.address, rpcUrl: `${url}/rpc` }));
      // A file of dist/ and nothing outside it, whatever the path or a link says.
      const file = join(dist, path.endsWith("/") ? `${path}index.html` : path);
      const real = existsSync(file) ? realpathSync(file) : null;
      if (!real || !real.startsWith(dist + sep) || !statSync(real).isFile()) return send(404, "text/plain", "not found");
      send(200, TYPES[extname(real)] ?? "application/octet-stream", readFileSync(real));
    } catch (e) {
      send(400, "text/plain", String(e.message));
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

/**
 * The checks' wallet for `account` on the world `w`: what window.ethereum.request answers. It follows EIP-1193,
 * holds no account until the page asks (eth_requestAccounts), and says yes to everything at once.
 */
export function wallet(w, account) {
  let connected = false;
  const refuse = (code, message) => ({ error: { code, message } });
  return async ({ method, params = [] }) => {
    switch (method) {
      case "eth_requestAccounts":
        connected = true;
        return { result: [account] };
      case "eth_accounts":
        return { result: connected ? [account] : [] };
      case "eth_chainId":
        return { result: `0x${CHAIN_ID.toString(16)}` };
      case "wallet_switchEthereumChain":
        return Number(params[0]?.chainId) === CHAIN_ID ? { result: null } : refuse(4902, `the wallet only knows chain ${CHAIN_ID}`);
      case "eth_sendTransaction": {
        if (!connected) return refuse(4100, "the wallet is not connected: call eth_requestAccounts first");
        if (String(params[0]?.from).toLowerCase() !== account) return refuse(4100, `the wallet's account is ${account}, not ${params[0]?.from}`);
        return w.chain.submit(account, params[0]).then((result) => ({ result }), (e) => refuse(e.code ?? -32000, e.message));
      }
      default: {
        if (method.startsWith("wallet_")) return refuse(4200, `the checks' wallet does not support ${method}`);
        const { result, error } = await w.chain.publicRpc({ jsonrpc: "2.0", id: 1, method, params });
        return error ? { error } : { result };
      }
    }
  };
}

/** Runs in the page before its own scripts: window.ethereum, answered by the wallet above. */
function injectWallet() {
  const listeners = {};
  window.ethereum = {
    async request({ method, params }) {
      const { result, error } = await window.__checksWallet({ method, params });
      if (error) throw Object.assign(new Error(error.message), { code: error.code, data: error.data });
      if (method === "eth_requestAccounts") for (const listener of listeners.accountsChanged ?? []) listener(result);
      return result;
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return this;
    },
    removeListener(event, listener) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      return this;
    },
  };
}

/**
 * Opens `site.url/<hash>` in a fresh browser (phone width, English, UTC), with `answer` (a wallet above) as
 * window.ethereum, or no wallet. Runs `steps(page)`, closes the browser, and adds to a failure what the page
 * itself reported (uncaught errors, console errors).
 */
export async function withPage(site, hash, answer, steps) {
  const profile = mkdtempSync(join(workspace().scratch, "browser-"));
  chmodSync(profile, 0o777); // under the gate the browser runs as another user than the check
  const context = await chromium.launchPersistentContext(profile, { locale: "en-US", timezoneId: "UTC", viewport: { width: 390, height: 844 } });
  const reported = [];
  try {
    context.setDefaultTimeout(5000);
    context.setDefaultNavigationTimeout(20_000);
    if (answer) {
      await context.exposeBinding("__checksWallet", (_source, request) => answer(request));
      await context.addInitScript(injectWallet);
    }
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("pageerror", (e) => reported.push(`uncaught ${e.message}`));
    page.on("console", (m) => m.type() === "error" && reported.push(m.text()));
    await page.goto(`${site.url}/${hash}`);
    return await steps(page);
  } catch (e) {
    throw new Error(`${e.message}${reported.length ? `\nThe page reported: ${reported.slice(-5).join(" | ").slice(0, 800)}` : ""}`);
  } finally {
    await context.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

/** The text of the one element with data-testid `id` (or its attribute `name`), trimmed; null when there is not exactly one, or no such attribute. */
export async function seen(page, id, name) {
  const handle = page.getByTestId(id);
  try {
    if ((await handle.count()) !== 1) return null;
    return name ? await handle.getAttribute(name) : (await handle.innerText()).trim();
  } catch {
    return null; // it went away while we looked
  }
}

/** Waits until handle `id` (its text, or its attribute `name`) satisfies `ok`; else says what it shows instead of `expected`. */
export async function shows(page, id, ok, expected, name) {
  let last = null;
  await until(async () => (last = await seen(page, id, name)) !== null && ok(last), async () => {
    const count = await page.getByTestId(id).count().catch(() => 0);
    const found = last !== null ? `it is ${JSON.stringify(last)}`
      : count === 1 ? `that element has no ${name} attribute`
      : count === 0 ? `the page has no element with data-testid="${id}"` : `the page has ${count} elements with data-testid="${id}": one at most`;
    return `${name ? `${id}'s ${name}` : id} must be ${expected}; ${found}`;
  });
}

/** Whether the page offers its main action: primary-action is there, visible and enabled. */
export async function offered(page) {
  const button = page.getByTestId("primary-action");
  try {
    return (await button.count()) === 1 && (await button.isVisible()) && (await button.isEnabled());
  } catch {
    return false;
  }
}

/**
 * Presses primary-action whenever it is offered, at most four times, until `done()` answers true.
 * Returns the number of presses; throws when `what` is not done after four, or when nothing is left to press.
 * `settled(presses)`, if given, is called each time the page has come to rest: before every press, and at the end.
 */
export async function pressUntil(page, done, what, settled = () => {}) {
  let presses = 0;
  for (const end = Date.now() + 60_000; ;) {
    const next = await until(async () => ((await done()) ? "done" : (await offered(page)) ? "press" : null),
      `${what}: not there after ${presses} press${presses === 1 ? "" : "es"} of primary-action, and primary-action is not offered (missing, hidden or disabled)`);
    await settled(presses);
    if (next === "done") return presses;
    if (presses === 4) throw new Error(`${what}: not there after four presses of primary-action`);
    if (Date.now() > end) throw new Error(`${what}: not there after 60 s`);
    // The button may change between the look and the click: then look again.
    await page.getByTestId("primary-action").click({ timeout: 2000 }).then(() => presses++, () => {});
  }
}
