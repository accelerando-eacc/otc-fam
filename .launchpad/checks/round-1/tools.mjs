// The checks' own tools, pinned in the base's package-lock.json: the Solidity compiler (solc, which is the
// compiler itself, nothing to download), a local chain (EDR, Hardhat's runtime), an ABI codec (ethers) and a
// browser driver (Playwright). Under the gate they are installed apart from the entry's dependencies, in
// /tools/node_modules, and loaded from there: an entry that changes its own node_modules changes nothing here.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ROOT } from "./lib/entry.mjs";

const dir = process.env.LAUNCHPAD_SANDBOXED === "1" && existsSync("/tools/node_modules") ? "/tools/node_modules" : join(ROOT, "node_modules");
const load = createRequire(join(dir, "tools"));
const tool = (name) => {
  try {
    return load(name);
  } catch (e) {
    throw new Error(`the checks' tool "${name}" is not in ${dir}: run "npm ci" at the repository's root first (${e.code ?? e.message})`);
  }
};

export const solc = tool("solc");
export const edr = tool("@nomicfoundation/edr");
export const { Interface, formatUnits, parseUnits } = tool("ethers");
export const { chromium } = tool("playwright");
