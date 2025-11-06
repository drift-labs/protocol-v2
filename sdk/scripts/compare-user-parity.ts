import { Connection, Commitment, PublicKey } from '@solana/web3.js';
import { AnchorProvider, BN } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';

import { DriftClient } from '../src/driftClient';
import { BulkAccountLoader } from '../src/accounts/bulkAccountLoader';
import { DRIFT_PROGRAM_ID, Wallet } from '../src';
import { User as CurrentUser } from '../src/user';
import { User as OldUser } from '../src/user_oldMarginCalculation';
import { UserMap } from '../src/userMap/userMap';
import { UserMapConfig } from '../src/userMap/userMapConfig';

type MarginCategory = 'Initial' | 'Maintenance';

function getEnv(name: string, fallback?: string): string {
	const v = process.env[name];
	if (v === undefined || v === '') {
		if (fallback !== undefined) return fallback;
		throw new Error(`${name} env var must be set.`);
	}
	return v;
}

function asCommitment(
	maybe: string | undefined,
	fallback: Commitment
): Commitment {
	const val = (maybe as Commitment) || fallback;
	return val;
}

function bnEq(a: BN, b: BN): boolean {
	return a.eq(b);
}

function buildOldUserFromSnapshot(
	driftClient: DriftClient,
	currentUser: CurrentUser
): OldUser {
	const userAccountPubkey = currentUser.getUserAccountPublicKey();

	const oldUser = new OldUser({
		driftClient,
		userAccountPublicKey: userAccountPubkey,
		accountSubscription: {
			type: 'custom',
			userAccountSubscriber: currentUser.accountSubscriber,
		},
	});

	return oldUser;
}

function logMismatch(
	userPubkey: PublicKey,
	fn: string,
	args: Record<string, unknown>,
	vNew: BN,
	vOld: BN
) {
	// Ensure BN values are logged as strings and arrays are printable
	const serialize = (val: unknown): unknown => {
		if (val instanceof BN) return val.toString();
		if (Array.isArray(val))
			return val.map((x) => (x instanceof BN ? x.toString() : x));
		return val;
	};

	const argsSerialized: Record<string, unknown> = {};
	for (const k of Object.keys(args)) {
		argsSerialized[k] = serialize(args[k]);
	}

	const argsLines = Object.keys(argsSerialized)
		.map(
			(k) =>
				`\t- ${k}: ${
					Array.isArray(argsSerialized[k])
						? (argsSerialized[k] as unknown[]).join(', ')
						: String(argsSerialized[k])
				}`
		)
		.join('|');

	console.error(
		// `❌ Parity mismatch\n` +
		`- ❌ user: ${userPubkey.toBase58()} | function: ${fn}\n` +
			`- args:\n${argsLines || '\t- none'}\n` +
			`- new: ${vNew.toString()} | old: ${vOld.toString()}\n`
	);
}

async function main(): Promise<void> {
	const RPC_ENDPOINT = getEnv('RPC_ENDPOINT');
	const COMMITMENT = asCommitment(process.env.COMMITMENT, 'processed');
	const POLL_FREQUENCY_MS = Number(process.env.POLL_FREQUENCY_MS || '40000');

	const connection = new Connection(RPC_ENDPOINT, COMMITMENT);
	const wallet = new Wallet(new Keypair());

	// AnchorProvider is not strictly required for polling, but some downstream utils expect a provider on the program
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const _provider = new AnchorProvider(
		connection,
		wallet as unknown as AnchorProvider['wallet'],
		{
			commitment: COMMITMENT,
			preflightCommitment: COMMITMENT,
		}
	);

	const bulkAccountLoader = new BulkAccountLoader(
		connection,
		COMMITMENT,
		POLL_FREQUENCY_MS
	);

	const driftClient = new DriftClient({
		connection,
		wallet,
		programID: new PublicKey(DRIFT_PROGRAM_ID),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});

	await driftClient.subscribe();

	const userMapConfig: UserMapConfig = {
		driftClient,
		subscriptionConfig: {
			type: 'polling',
			frequency: POLL_FREQUENCY_MS,
			commitment: COMMITMENT,
		},
		includeIdle: false,
		fastDecode: true,
		throwOnFailedSync: false,
	};

	const userMap = new UserMap(userMapConfig);
	await userMap.subscribe();
	await userMap.sync();

	let mismatches = 0;
	let usersChecked = 0;
	const mismatchesByFunction: Record<string, number> = {};
	const usersWithDiscrepancies = new Set<string>();

	const isolatedKeysEnv = process.env.ISOLATED_USER_PUBKEY;
	const isolatedKeys =
		isolatedKeysEnv && isolatedKeysEnv.length > 0
			? isolatedKeysEnv
					.split(',')
					.map((k) => k.trim())
					.filter((k) => k.length > 0)
			: [];

	const usersFilterd =
		isolatedKeys.length > 0
			? Array.from(userMap.entries()).filter(([userKey]) =>
					isolatedKeys.includes(userKey)
			  )
			: Array.from(userMap.entries());

	for (const [userKey, currUser] of usersFilterd) {
		usersChecked += 1;
		const userPubkey = new PublicKey(userKey);

		function noteMismatch(functionName: string): void {
			mismatchesByFunction[functionName] =
				(mismatchesByFunction[functionName] ?? 0) + 1;
			usersWithDiscrepancies.add(userPubkey.toBase58());
			mismatches += 1;
		}

		// clean curr User position flags to be all 0

		currUser.getActivePerpPositions().forEach((position) => {
			position.positionFlag = 0;
		});

		const oldUser = buildOldUserFromSnapshot(driftClient, currUser, COMMITMENT);

		try {
			// Cross-account level comparisons
			// const categories: MarginCategory[] = ['Initial', 'Maintenance'];
			const categories: MarginCategory[] = ['Initial'];
			// const categories: MarginCategory[] = ['Maintenance'];
			// const categories: MarginCategory[] = [];

			for (const cat of categories) {
				// getFreeCollateral
				const vNew_fc = currUser.getFreeCollateral(cat);
				const vOld_fc = oldUser.getFreeCollateral(cat);
				if (!bnEq(vNew_fc, vOld_fc)) {
					logMismatch(
						userPubkey,
						'getFreeCollateral',
						{ marginCategory: cat },
						vNew_fc,
						vOld_fc
					);
					noteMismatch('getFreeCollateral');
				}

				// only do free collateral for now
				// continue;

				// getTotalCollateral
				const vNew_tc = currUser.getTotalCollateral(cat);
				const vOld_tc = oldUser.getTotalCollateral(cat);
				if (!bnEq(vNew_tc, vOld_tc)) {
					logMismatch(
						userPubkey,
						'getTotalCollateral',
						{ marginCategory: cat },
						vNew_tc,
						vOld_tc
					);
					noteMismatch('getTotalCollateral');
				}

				// getMarginRequirement (strict=true, includeOpenOrders=true)
				const vNew_mr = currUser.getMarginRequirement(
					cat,
					undefined,
					true,
					true
				);
				const vOld_mr = oldUser.getMarginRequirement(
					cat,
					undefined,
					true,
					true
				);
				if (!bnEq(vNew_mr, vOld_mr)) {
					logMismatch(
						userPubkey,
						'getMarginRequirement',
						{ marginCategory: cat, strict: true, includeOpenOrders: true },
						vNew_mr,
						vOld_mr
					);
					noteMismatch('getMarginRequirement');
				}
			}
			// continue;

			// Per-perp-market comparisons
			const activePerpPositions = currUser.getActivePerpPositions();
			for (const pos of activePerpPositions) {
				const marketIndex = pos.marketIndex;

				// getPerpBuyingPower
				const vNew_pbp = currUser.getPerpBuyingPower(marketIndex);
				const vOld_pbp = oldUser.getPerpBuyingPower(marketIndex);
				if (!bnEq(vNew_pbp, vOld_pbp)) {
					logMismatch(
						userPubkey,
						'getPerpBuyingPower',
						{ marketIndex },
						vNew_pbp,
						vOld_pbp
					);
					noteMismatch('getPerpBuyingPower');
				}

				// liquidationPrice (defaults)
				const vNew_lp = currUser.liquidationPrice(marketIndex);
				const vOld_lp = oldUser.liquidationPrice(marketIndex);
				if (!bnEq(vNew_lp, vOld_lp)) {
					logMismatch(
						userPubkey,
						'liquidationPrice',
						{ marketIndex },
						vNew_lp,
						vOld_lp
					);
					noteMismatch('liquidationPrice');
				}

				// liquidationPriceAfterClose with 10% of current quote as close amount (skip if zero/absent)
				const quoteAbs = pos.quoteAssetAmount
					? pos.quoteAssetAmount.abs()
					: new BN(0);
				const closeQuoteAmount = quoteAbs.div(new BN(10));
				if (closeQuoteAmount.gt(new BN(0))) {
					const vNew_lpac = currUser.liquidationPriceAfterClose(
						marketIndex,
						closeQuoteAmount
					);
					const vOld_lpac = oldUser.liquidationPriceAfterClose(
						marketIndex,
						closeQuoteAmount
					);
					if (!bnEq(vNew_lpac, vOld_lpac)) {
						logMismatch(
							userPubkey,
							'liquidationPriceAfterClose',
							{ marketIndex, closeQuoteAmount: closeQuoteAmount.toString() },
							vNew_lpac,
							vOld_lpac
						);
						noteMismatch('liquidationPriceAfterClose');
					}
				}
			}
		} catch (e) {
			console.error(
				`💥 Parity exception\n` +
					`- user: ${userPubkey.toBase58()}\n` +
					`- error: ${(e as Error).message}`
			);
			usersWithDiscrepancies.add(userPubkey.toBase58());
			mismatches += 1;
		} finally {
			await oldUser.unsubscribe();
		}
	}

	const byFunctionLines = Object.entries(mismatchesByFunction)
		.sort((a, b) => b[1] - a[1])
		.map(([fn, count]) => `\t- ${fn}: ${count}`)
		.join('\n');

	console.log(
		`\n📊 User parity summary\n` +
			`- users checked: ${usersChecked}\n` +
			`- users with discrepancy: ${usersWithDiscrepancies.size}\n` +
			`- percentage of users with discrepancy: ${
				(usersWithDiscrepancies.size / usersChecked) * 100
			}%\n` +
			`- total mismatches: ${mismatches}\n` +
			// `- percentage of mismatches: ${(mismatches / usersChecked) * 100}%\n` +
			`- mismatches by function:\n${byFunctionLines || '\t- none'}\n`
	);

	await userMap.unsubscribe();
	await driftClient.unsubscribe();

	if (mismatches > 0) {
		process.exit(1);
	} else {
		process.exit(0);
	}
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
