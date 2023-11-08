import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  configs,
  DriftClient,
  Wallet,
} from "@drift-labs/sdk";


async function main() {

  const driftConfig = configs['mainnet-beta'];
  const connection = new Connection('https://api.mainnet-beta.solana.com');

  const driftClient = new DriftClient({
    connection: connection,
    wallet: new Wallet(new Keypair()),
    programID: new PublicKey(driftConfig.DRIFT_PROGRAM_ID),
    userStats: true,
    env: 'mainnet-beta',
  });
  console.log(`driftClientSubscribed: ${await driftClient.subscribe()}`);

  const txHash = "3gvGQufckXGHrFDv4dNWEXuXKRMy3NZkKHMyFrAhLoYScaXXTGCp9vq58kWkfyJ8oDYZrz4bTyGayjUy9PKigeLS";

  const tx = await driftClient.connection.getParsedTransaction(txHash, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  let logIdx = 0;
  // @ts-ignore
  for (const event of driftClient.program._events._eventParser.parseLogs(tx!.meta!.logMessages)) {
    console.log("----------------------------------------");
    console.log(`Log ${logIdx++}`);
    console.log("----------------------------------------");
    console.log(`${JSON.stringify(event, null, 2)}`);
  }

  console.log("========================================");
  console.log("Raw transaction logs");
  console.log("========================================");
  console.log(JSON.stringify(tx!.meta!.logMessages, null, 2));

  process.exit(0);
}

main().catch(console.error);
