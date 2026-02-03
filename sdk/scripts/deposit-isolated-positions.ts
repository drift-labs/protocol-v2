import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { AnchorProvider, Idl, Program, ProgramAccount, BN } from '@coral-xyz/anchor';
import driftIDL from '../src/idl/drift.json';
import {
	DRIFT_PROGRAM_ID,
	PerpMarketAccount,
	SpotMarketAccount,
	OracleInfo,
	Wallet,
	numberToSafeBN,
} from '../src';
import { DriftClient } from '../src/driftClient';
import { DriftClientConfig } from '../src/driftClientConfig';

async function main() {
	dotenv.config({ path: '../' });

	const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
	if (!RPC_ENDPOINT) throw new Error('RPC_ENDPOINT env var required');

	let keypair: Keypair;
	const pk = process.env.PRIVATE_KEY;
	if (pk) {
		const secret = Uint8Array.from(JSON.parse(pk));
		keypair = Keypair.fromSecretKey(secret);
	} else {
		keypair = new Keypair();
		console.warn('Using ephemeral keypair. Provide PRIVATE_KEY to use a real wallet.');
	}
	const wallet = new Wallet(keypair);

	const connection = new Connection(RPC_ENDPOINT);
	const provider = new AnchorProvider(connection, wallet as any, {
		commitment: 'processed',
	});
	const programId = new PublicKey(DRIFT_PROGRAM_ID);
	const program = new Program(driftIDL as Idl, programId, provider);

	const allPerpMarketProgramAccounts =
		(await program.account.perpMarket.all()) as ProgramAccount<PerpMarketAccount>[];
	const perpMarketIndexes = allPerpMarketProgramAccounts.map((val) => val.account.marketIndex);
	const allSpotMarketProgramAccounts =
		(await program.account.spotMarket.all()) as ProgramAccount<SpotMarketAccount>[];
	const spotMarketIndexes = allSpotMarketProgramAccounts.map((val) => val.account.marketIndex);

	const seen = new Set<string>();
	const oracleInfos: OracleInfo[] = [];
	for (const acct of allPerpMarketProgramAccounts) {
		const key = `${acct.account.amm.oracle.toBase58()}-${Object.keys(acct.account.amm.oracleSource)[0]}`;
		if (!seen.has(key)) {
			seen.add(key);
			oracleInfos.push({ publicKey: acct.account.amm.oracle, source: acct.account.amm.oracleSource });
		}
	}
	for (const acct of allSpotMarketProgramAccounts) {
		const key = `${acct.account.oracle.toBase58()}-${Object.keys(acct.account.oracleSource)[0]}`;
		if (!seen.has(key)) {
			seen.add(key);
			oracleInfos.push({ publicKey: acct.account.oracle, source: acct.account.oracleSource });
		}
	}

	const clientConfig: DriftClientConfig = {
		connection,
		wallet,
		programID: programId,
		accountSubscription: { type: 'websocket', commitment: 'processed' },
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
		env: 'devnet',
	};
	const client = new DriftClient(clientConfig);
	await client.subscribe();

	const candidates = perpMarketIndexes.filter((i) => i >= 0 && i <= 5);
	const targetMarketIndex = candidates.length
		? candidates[Math.floor(Math.random() * candidates.length)]
		: perpMarketIndexes[0];

	const perpMarketAccount = client.getPerpMarketAccount(targetMarketIndex);
	const quoteSpotMarketIndex = perpMarketAccount.quoteSpotMarketIndex;
	const spotMarketAccount = client.getSpotMarketAccount(quoteSpotMarketIndex);

	const precision = new BN(10).pow(new BN(spotMarketAccount.decimals));
	const amount = numberToSafeBN(0.01, precision);

	const userTokenAccount = await client.getAssociatedTokenAccount(quoteSpotMarketIndex);
	const ix = await client.getDepositIntoIsolatedPerpPositionIx(
		amount,
		targetMarketIndex,
		userTokenAccount,
		0
	);

	const tx = await client.buildTransaction([ix]);
	const { txSig } = await client.sendTransaction(tx);
	console.log(`Deposited into isolated perp market ${targetMarketIndex}: ${txSig}`);

	await client.getUser().unsubscribe();
	await client.unsubscribe();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});


