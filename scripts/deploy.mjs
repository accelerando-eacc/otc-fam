// npm run deploy: deploys contracts/OtcDeals.sol to the network at RPC_URL with the key in DEPLOYER_KEY,
// and prints the contract's address. Both come from the environment and are never written to a file.
// The base only says what is missing: round 1 builds the deployment.
for (const name of ["RPC_URL", "DEPLOYER_KEY"]) {
  if (!process.env[name]) {
    console.error(`${name} is not set: RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> npm run deploy`);
    process.exit(1);
  }
}
console.error("Nothing to deploy yet: contracts/OtcDeals.sol and this script are round 1's to build.");
process.exit(1);
