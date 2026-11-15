// A local chain inside the check's process: EDR (Hardhat's runtime), a block per transaction, no network.
// The checks send transactions as any address (the chain lets them, there is no key anywhere), set the time
// of the next block, and lend the page a read-only JSON-RPC endpoint.
import { edr, Interface } from "./tools.mjs";

export const CHAIN_ID = 31337;
const GAS_LIMIT = 30_000_000n;
const bytes = (hex) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));

let context;
/** EDR's context, made once for the process. */
async function edrContext() {
  if (!context) {
    context = new edr.EdrContext();
    await context.registerProviderFactory(edr.L1_CHAIN_TYPE, edr.l1ProviderFactory());
  }
  return context;
}

/** A transaction that the chain mined and that reverted. */
export class Reverted extends Error {}

/** Starts a chain. `rich` are the addresses that start with ether for gas. */
export async function startChain(rich = []) {
  const hardfork = "prague";
  // Blocks mined within one second share its timestamp, so the chain's clock stays the machine's.
  const provider = await (await edrContext()).createProvider(edr.L1_CHAIN_TYPE, {
    allowBlocksWithSameTimestamp: true, allowUnlimitedContractSize: false, bailOnCallFailure: true, bailOnTransactionFailure: false,
    chainId: BigInt(CHAIN_ID), networkId: BigInt(CHAIN_ID), coinbase: bytes(`0x${"c0".repeat(20)}`), hardfork,
    genesisState: [...edr.l1GenesisState(edr.l1HardforkFromString(hardfork)), ...rich.map((a) => ({ address: bytes(a), balance: 10n ** 24n }))],
    initialBaseFeePerGas: 1_000_000_000n, minGasPrice: 0n,
    mining: { autoMine: true, blockGasLimit: GAS_LIMIT, memPool: { order: edr.MineOrdering.Fifo } },
    network: { genesisBlockGasLimit: GAS_LIMIT }, observability: {}, ownedAccounts: [], precompileOverrides: [],
  }, { enable: false, decodeConsoleLogInputsCallback: () => [], printLineCallback: () => {} }, { subscriptionCallback: () => {} }, new edr.ContractDecoder());

  /** One JSON-RPC request as a node answers it: `{ jsonrpc, id, result }` or `{ jsonrpc, id, error }`. */
  const answer = async (request) => {
    const { data } = await provider.handleRequest(JSON.stringify(request));
    const { result, error } = typeof data === "string" ? JSON.parse(data) : data;
    return { jsonrpc: "2.0", id: request.id ?? null, ...(error ? { error } : { result: result ?? null }) };
  };
  let ids = 0;
  const rpc = async (method, params = []) => {
    const r = await answer({ jsonrpc: "2.0", id: ++ids, method, params });
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { code: r.error.code, data: r.error.data });
    return r.result;
  };
  const impersonated = new Set();

  const chain = {
    rpc,
    /**
     * What a public node answers the page: reads only. Sending is the wallet's job, and the chain's own
     * controls (hardhat_*, evm_*) are the checks'.
     */
    async publicRpc(request) {
      if (Array.isArray(request)) return Promise.all(request.map((r) => chain.publicRpc(r)));
      const method = String(request?.method ?? "");
      const allowed = /^(eth|net|web3)_/.test(method) && !/^eth_(sendTransaction|sign)/.test(method);
      return allowed ? answer(request) : { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32601, message: `the method ${method} is not available on this endpoint` } };
    },
    /** Sends a transaction from `from` (any address: the chain asks for no signature) and returns its hash. */
    async submit(from, tx) {
      if (!impersonated.has(from)) {
        await rpc("hardhat_impersonateAccount", [from]);
        impersonated.add(from);
      }
      return rpc("eth_sendTransaction", [{ ...tx, from }]);
    },
    /** Sends a transaction from `from` and returns its receipt; throws Reverted if it reverted. */
    async send(from, tx, what = "the transaction") {
      const receipt = await rpc("eth_getTransactionReceipt", [await chain.submit(from, tx)]);
      if (receipt.status === "0x1") return receipt;
      // Why, when the chain can say: the same call again, as a read.
      const why = await rpc("eth_call", [{ ...tx, from }, "latest"]).then(() => "", (e) => ` (${e.message.replace(/^eth_call: /, "")})`);
      throw new Reverted(`${what} reverted${why}`);
    },
    /** Ether for gas, for an address that did not start rich (a contract that acts as a party). */
    fund: (address) => rpc("hardhat_setBalance", [address, `0x${(10n ** 24n).toString(16)}`]),
    /** The time of the latest block, in unix seconds. */
    now: async () => Number((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp),
    /** The next block (the next transaction) happens at `time`, unix seconds. */
    setNextTime: (time) => rpc("evm_setNextBlockTimestamp", [`0x${time.toString(16)}`]),
    /** Mines an empty block, at the clock's time. */
    mine: () => rpc("evm_mine", []),
  };
  return chain;
}

/**
 * A contract on a chain. `c.read.name(...args)` calls a view; `c.as(sender).name(...args)` sends a transaction
 * and resolves to its events, `[{ name, args }]`, or throws Reverted. `label` and `show` (how to print an
 * argument) word the error; `c.interface` encodes and decodes.
 */
export function contractAt(chain, abi, address, { label = "the contract", show = String } = {}) {
  const iface = new Interface(abi);
  const one = (values) => (values.length === 1 ? values[0] : values);
  return {
    address, interface: iface,
    read: new Proxy({}, {
      get: (_, name) => async (...args) => one(iface.decodeFunctionResult(name, await chain.rpc("eth_call", [{ to: address, data: iface.encodeFunctionData(name, args) }, "latest"]))),
    }),
    as: (sender) => new Proxy({}, {
      get: (_, name) => async (...args) => {
        const receipt = await chain.send(sender, { to: address, data: iface.encodeFunctionData(name, args) }, `${label}.${name}(${args.map(show).join(", ")}), sent by ${show(sender)},`);
        return receipt.logs.filter((l) => l.address.toLowerCase() === address.toLowerCase()).map((l) => iface.parseLog(l)).filter(Boolean).map((e) => ({ name: e.name, args: e.args }));
      },
    }),
  };
}

/** Deploys `artifact` ({ abi, bytecode }) from `from` with constructor `args`, and returns the contract. */
export async function deploy(chain, from, artifact, args = [], { label = "the contract", show } = {}) {
  const data = artifact.bytecode + new Interface(artifact.abi).encodeDeploy(args).slice(2);
  const receipt = await chain.send(from, { data }, `deploying ${label}`);
  return contractAt(chain, artifact.abi, receipt.contractAddress, { label, show });
}
