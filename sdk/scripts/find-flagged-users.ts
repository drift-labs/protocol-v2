import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import {
	DriftClient,
	DriftClientConfig,
	Wallet,
	UserMap,
	DRIFT_PROGRAM_ID,
	getMarketsAndOraclesForSubscription,
	BulkAccountLoader,
	BN,
	PerpPosition,
} from '../src';
import { TransactionSignature } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function main() {
	dotenv.config({ path: '../' });
	// Simple CLI parsing
	interface CliOptions {
		mode: 'list' | 'one' | 'all';
		targetUser?: string;
	}

	function parseCliArgs(): CliOptions {
		const args = process.argv.slice(2);
		let mode: CliOptions['mode'] = 'list';
		let targetUser: string | undefined = undefined;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === '--mode' && i + 1 < args.length) {
				const next = args[i + 1] as CliOptions['mode'];
				if (next === 'list' || next === 'one' || next === 'all') {
					mode = next;
				}
				i++;
			} else if ((arg === '--user' || arg === '--target') && i + 1 < args.length) {
				targetUser = args[i + 1];
				i++;
			}
		}
		return { mode, targetUser };
	}

	const { mode, targetUser } = parseCliArgs();

	const RPC_ENDPOINT =
		process.env.RPC_ENDPOINT ?? 'https://api.mainnet-beta.solana.com';

	const connection = new Connection(RPC_ENDPOINT);
	const keypairPath =
		process.env.SOLANA_KEYPAIR ??
		path.join(os.homedir(), '.config', 'solana', 'id.json');
	const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf-8')) as number[];
	const wallet = new Wallet(Keypair.fromSecretKey(Uint8Array.from(secret)));

	const { perpMarketIndexes, spotMarketIndexes, oracleInfos } =
		getMarketsAndOraclesForSubscription('mainnet-beta');

		const accountLoader = new BulkAccountLoader(connection, 'confirmed', 60_000);

	const clientConfig: DriftClientConfig = {
		connection,
		wallet,
		programID: new PublicKey(DRIFT_PROGRAM_ID),
		accountSubscription: {
			type: 'polling',
			accountLoader,
		},
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
		env: 'mainnet-beta',
	};

	const client = new DriftClient(clientConfig);
	await client.subscribe();

	const userMap = new UserMap({
		driftClient: client,
		subscriptionConfig: {
			type: 'polling',
			frequency: 60_000,
			commitment: 'confirmed',
		},
		includeIdle: false,
		syncConfig: { type: 'paginated' },
		throwOnFailedSync: false,
	});
	await userMap.subscribe();


	const flaggedUsers: Array<{
		userPubkey: string;
		authority: string;
		flags: Array<{ marketIndex: number; flag: number; isolatedPositionScaledBalance: BN }>;
	}> = [];

	console.log(`User map size: ${Array.from(userMap.entries()).length}`);

	for (const [userPubkey, user] of userMap.entries()) {
		const userAccount = user.getUserAccount();
		const flaggedPositions = userAccount.perpPositions
			.filter((p) => p.positionFlag >= 1 || p.isolatedPositionScaledBalance.toString() !== '0')
			.map((p) => ({ marketIndex: p.marketIndex, flag: p.positionFlag, isolatedPositionScaledBalance: p.isolatedPositionScaledBalance, fullPosition: p }));

		if (flaggedPositions.length > 0) {
			if(mode === 'one' && userPubkey === targetUser) {
				console.log(`flagged positions on user ${userPubkey}`);
				console.log(flaggedPositions.map((p) => `mkt=${p.marketIndex}, flag=${p.flag}, isolatedPositionScaledBalance=${p.isolatedPositionScaledBalance.toString()}, fullPosition=${fullLogPerpPosition(p.fullPosition)}`).join('\n\n; '));
			}
			flaggedUsers.push({
				userPubkey,
				authority: userAccount.authority.toBase58(),
				flags: flaggedPositions,
			});
		}
	}

	// Mode 1: list flagged users (default)
	if (mode === 'list') {
		console.log(`Flagged users (positionFlag >= 1 || isolatedPositionScaledBalance > 0): ${flaggedUsers.length}`);
		for (const u of flaggedUsers) {
			const flagsStr = u.flags
				.map((f) => `mkt=${f.marketIndex}, flag=${f.flag}, isolatedPositionScaledBalance=${f.isolatedPositionScaledBalance.toString()}`)
				.join('; ');
			console.log(
				`- authority=${u.authority} userAccount=${u.userPubkey} -> [${flagsStr}]`
			);
		}
	}

	// Helper to invoke updateUserIdle
	async function updateUserIdleFor(userAccountPubkeyStr: string): Promise<TransactionSignature | undefined> {
		const userObj = userMap.get(userAccountPubkeyStr);
		if (!userObj) {
			console.warn(`User ${userAccountPubkeyStr} not found in userMap`);
			return undefined;
		}
		try {
			const sig = await client.updateUserIdle(
				new PublicKey(userAccountPubkeyStr),
				userObj.getUserAccount()
			);
			console.log(`updateUserIdle sent for userAccount=${userAccountPubkeyStr} -> tx=${sig}`);
			return sig;
		} catch (e) {
			console.error(`Failed updateUserIdle for userAccount=${userAccountPubkeyStr}`, e);
			return undefined;
		}
	}

	// Mode 2: updateUserIdle on a single flagged user
	if (mode === 'one') {
		if (flaggedUsers.length === 0) {
			console.log('No flagged users to update.');
		} else {
			const chosen =
				(targetUser && flaggedUsers.find((u) => u.userPubkey === targetUser)) ||
				flaggedUsers[0];
			console.log(
				`Updating single flagged userAccount=${chosen.userPubkey} authority=${chosen.authority}`
			);
			await updateUserIdleFor(chosen.userPubkey);
		}
	}

	// Mode 3: updateUserIdle on all flagged users
	if (mode === 'all') {
		if (flaggedUsers.length === 0) {
			console.log('No flagged users to update.');
		} else {
			console.log(`Updating all ${flaggedUsers.length} flagged users...`);
			for (const u of flaggedUsers) {
				await updateUserIdleFor(u.userPubkey);
			}
			console.log('Finished updating all flagged users.');
		}
	}

	await userMap.unsubscribe();
	await client.unsubscribe();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});


function fullLogPerpPosition(position: PerpPosition) {

	return `
	[PERP POSITION]
	baseAssetAmount=${position.baseAssetAmount.toString()}
	quoteAssetAmount=${position.quoteAssetAmount.toString()}
	quoteBreakEvenAmount=${position.quoteBreakEvenAmount.toString()}
	quoteEntryAmount=${position.quoteEntryAmount.toString()}
	openBids=${position.openBids.toString()}
	openAsks=${position.openAsks.toString()}
	settledPnl=${position.settledPnl.toString()}
	lpShares=${position.lpShares.toString()}
	remainderBaseAssetAmount=${position.remainderBaseAssetAmount}
	lastQuoteAssetAmountPerLp=${position.lastQuoteAssetAmountPerLp.toString()}
	perLpBase=${position.perLpBase}
	maxMarginRatio=${position.maxMarginRatio}
	marketIndex=${position.marketIndex}
	openOrders=${position.openOrders}
	positionFlag=${position.positionFlag}
	isolatedPositionScaledBalance=${position.isolatedPositionScaledBalance.toString()}
	`;

}

