// Compiling, the same way for every entry: solc 0.8.38, optimizer on (200 runs), EVM version cancun.
// Compiling reads the entry's files; it runs none of its code.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lib/entry.mjs";
import { solc } from "./tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } };

/** A file of `root` by its path, or of one of `root`'s packages (node_modules), never from outside `root`. */
function fileUnder(root, path) {
  for (const candidate of [join(root, path), join(root, "node_modules", path)]) {
    if (!existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (real.startsWith(realpathSync(root) + sep)) return readFileSync(real, "utf8");
  }
  return null;
}

/**
 * Compiles `file` (a path under `root`) and returns its contracts by name, each `{ abi, bytecode }`.
 * Imports are read from `root`: `./X.sol` next to the importing file, anything else from `root` or its node_modules.
 * Throws the compiler's own messages when it reports an error.
 */
export function compile(root, file) {
  const source = fileUnder(root, file);
  if (source === null) throw new Error(`${file} is missing`);
  const input = { language: "Solidity", sources: { [file]: { content: source } }, settings: SETTINGS };
  const readImport = (path) => {
    const contents = fileUnder(root, path);
    return contents === null ? { error: `${path} is not in the repository or its node_modules` } : { contents };
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: readImport }));
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(`${file} does not compile with solc ${solc.version().split("+")[0]}:\n${errors.map((e) => e.formattedMessage.trim()).join("\n")}`);
  return Object.fromEntries(Object.entries(output.contracts?.[file] ?? {}).map(([name, c]) => [name, { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }]));
}

/** The entry's contract: `OtcDeals` in contracts/OtcDeals.sol. */
export function compileEntry() {
  const { OtcDeals } = compile(ROOT, "contracts/OtcDeals.sol");
  if (!OtcDeals) throw new Error("contracts/OtcDeals.sol has no contract named OtcDeals");
  if (OtcDeals.abi.some((f) => f.type === "constructor" && f.inputs.length)) throw new Error("OtcDeals' constructor takes arguments: the checks deploy it with none");
  if (OtcDeals.bytecode === "0x") throw new Error("OtcDeals in contracts/OtcDeals.sol cannot be deployed: it is abstract, or leaves a function of IOtcDeals without a body");
  return OtcDeals;
}

/** The checks' own tokens (tokens/Tokens.sol): PlainToken, NoReturnToken, ReentrantToken. */
export const compileTokens = () => compile(HERE, "tokens/Tokens.sol");
