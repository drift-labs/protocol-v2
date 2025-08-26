import { Keypair } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { BulkAccountLoader, DriftClient, PublicKey, UserMap, UserStatsMap, Wallet } from "../src";

const main = async () => {

	const rpcEndpoint = 'https://drift-cranking.rpcpool.com/f1ead98714b94a67f82203cce918';
	const connection = new Connection(rpcEndpoint, 'confirmed');
	const driftClient = new DriftClient({
		connection,
		wallet: new Wallet(Keypair.generate()),
	});
	await driftClient.subscribe();


};

main();
