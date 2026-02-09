import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import {
	AnchorProvider,
	Idl,
	Program,
	ProgramAccount,
} from '@coral-xyz/anchor';
import driftIDL from '../src/idl/drift.json';
import {
	DRIFT_PROGRAM_ID,
	PerpMarketAccount,
	SpotMarketAccount,
	OracleInfo,
	Wallet,
	ZERO,
} from '../src';
import { DriftClient } from '../src/driftClient';
import { DriftClientConfig } from '../src/driftClientConfig';

function isStatusOpen(status: any) {
	return !!status && 'open' in status;
}

function isPerpMarketType(marketType: any) {
	return !!marketType && 'perp' in marketType;
}

async function main() {
	dotenv.config({ path: '../' });

	const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
	if (!RPC_ENDPOINT) throw new Error('RPC_ENDPOINT env var required');

	// Load wallet
	// For safety this creates a new ephemeral wallet unless PRIVATE_KEY is provided (base58 array)
	let keypair: Keypair;
	const pk = process.env.PRIVATE_KEY;
	if (pk) {
		const secret = Uint8Array.from(JSON.parse(pk));
		keypair = Keypair.fromSecretKey(secret);
	} else {
		keypair = new Keypair();
		console.warn(
			'Using ephemeral keypair. Provide PRIVATE_KEY for real withdrawals.'
		);
	}
	const wallet = new Wallet(keypair);

	// Connection and program for market discovery
	const connection = new Connection(RPC_ENDPOINT);
	const provider = new AnchorProvider(connection, wallet as any, {
		commitment: 'processed',
	});
	const programId = new PublicKey(DRIFT_PROGRAM_ID);
	const program = new Program(driftIDL as Idl, programId, provider);

	// Discover markets and oracles (like the example test script)
	const allPerpMarketProgramAccounts =
		(await program.account.perpMarket.all()) as ProgramAccount<PerpMarketAccount>[];
	const perpMarketIndexes = allPerpMarketProgramAccounts.map(
		(val) => val.account.marketIndex
	);
	const allSpotMarketProgramAccounts =
		(await program.account.spotMarket.all()) as ProgramAccount<SpotMarketAccount>[];
	const spotMarketIndexes = allSpotMarketProgramAccounts.map(
		(val) => val.account.marketIndex
	);

	const seen = new Set<string>();
	const oracleInfos: OracleInfo[] = [];
	for (const acct of allPerpMarketProgramAccounts) {
		const key = `${acct.account.amm.oracle.toBase58()}-${
			Object.keys(acct.account.amm.oracleSource)[0]
		}`;
		if (!seen.has(key)) {
			seen.add(key);
			oracleInfos.push({
				publicKey: acct.account.amm.oracle,
				source: acct.account.amm.oracleSource,
			});
		}
	}
	for (const acct of allSpotMarketProgramAccounts) {
		const key = `${acct.account.oracle.toBase58()}-${
			Object.keys(acct.account.oracleSource)[0]
		}`;
		if (!seen.has(key)) {
			seen.add(key);
			oracleInfos.push({
				publicKey: acct.account.oracle,
				source: acct.account.oracleSource,
			});
		}
	}

	// Build DriftClient with websocket subscription (lightweight)
	const clientConfig: DriftClientConfig = {
		connection,
		wallet,
		programID: programId,
		accountSubscription: {
			type: 'websocket',
			commitment: 'processed',
		},
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
		env: 'devnet',
	};
	const client = new DriftClient(clientConfig);
	await client.subscribe();

	// Ensure user exists and is subscribed
	const user = client.getUser();
	await user.subscribe();

	const userAccount = user.getUserAccount();
	const openOrders = user.getOpenOrders();

	const marketsWithOpenOrders = new Set<number>();
	for (const o of openOrders ?? []) {
		if (isStatusOpen(o.status) && isPerpMarketType(o.marketType)) {
			marketsWithOpenOrders.add(o.marketIndex);
		}
	}

	const withdrawTargets = userAccount.perpPositions.filter((pos) => {
		const isZeroBase = pos.baseAssetAmount.eq(ZERO);
		const hasIso = pos.isolatedPositionScaledBalance.gt(ZERO);
		const hasOpenOrders = marketsWithOpenOrders.has(pos.marketIndex);
		return isZeroBase && hasIso && !hasOpenOrders;
	});

	console.log(
		`Found ${withdrawTargets.length} isolated perp positions to withdraw`
	);

	for (const pos of withdrawTargets) {
		try {
			const amount = client.getIsolatedPerpPositionTokenAmount(pos.marketIndex);
			if (amount.lte(ZERO)) continue;

			const perpMarketAccount = client.getPerpMarketAccount(pos.marketIndex);
			const quoteAta = await client.getAssociatedTokenAccount(
				perpMarketAccount.quoteSpotMarketIndex
			);

			const ixs = await client.getWithdrawFromIsolatedPerpPositionIxsBundle(
				amount,
				pos.marketIndex,
				0,
				quoteAta,
				true
			);

			const tx = await client.buildTransaction(ixs);
			const { txSig } = await client.sendTransaction(tx);
			console.log(
				`Withdrew isolated deposit for perp market ${pos.marketIndex}: ${txSig}`
			);
		} catch (e) {
			console.error(`Failed to withdraw for market ${pos.marketIndex}:`, e);
		}
	}

	await user.unsubscribe();
	await client.unsubscribe();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
