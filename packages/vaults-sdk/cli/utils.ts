import {
	BASE_PRECISION,
	BN,
	DriftClient,
	DriftEnv,
	OraclePriceData,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	SpotMarketAccount,
	TEN,
	User,
	Wallet,
	WhileValidTxSender,
	convertToNumber,
	getSignedTokenAmount,
	getTokenAmount,
	loadKeypair,
} from '@velocity-exchange/sdk';
import {
	FeeUpdate,
	Vault,
	VaultClass,
	VaultClient,
	VaultDepositor,
	decodeName,
} from '../src';
import { Command } from 'commander';
import {
	Connection,
	Keypair,
	PublicKey,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';
import { AnchorProvider, Wallet as AnchorWallet } from '@coral-xyz/anchor';
import * as anchor from '@coral-xyz/anchor';
import { IDL } from '../src/utils';
import { DriftVaults } from '../src/types/drift_vaults';
import { getLedgerWallet } from './ledgerWallet';
import fs from 'fs';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';

export async function printVault(
	slot: number,
	driftClient: DriftClient,
	vault: Vault,
	vaultEquity: BN,
	spotMarket: SpotMarketAccount,
	spotOracle: OraclePriceData,
	feeUpdateAccount: FeeUpdate | null = null
) {
	const oraclePriceNum = convertToNumber(spotOracle.price, PRICE_PRECISION);
	const spotPrecision = TEN.pow(new BN(spotMarket.decimals));
	const spotSymbol = decodeName(spotMarket.name);

	console.log(`slot: ${slot}`);
	console.log(`vault: ${decodeName(vault.name)}`);
	console.log(`vaultClass:     ${vault.vaultClass}`);
	if (vault.vaultClass === VaultClass.TRUSTED) {
		console.log(
			`  managerBorrowedValue: ${convertToNumber(
				vault.managerBorrowedValue,
				spotPrecision
			)} ${spotSymbol}`
		);
	}
	console.log(`pubkey:         ${vault.pubkey.toBase58()}`);
	console.log(`manager:         ${vault.manager.toBase58()}`);
	console.log(`tokenAccount:    ${vault.tokenAccount.toBase58()}`);
	console.log(`driftUserStats:  ${vault.userStats.toBase58()}`);
	console.log(`driftUser:       ${vault.user.toBase58()}`);
	console.log(`delegate:        ${vault.delegate.toBase58()}`);
	console.log(`liqDelegate:     ${vault.liquidationDelegate.toBase58()}`);
	console.log(`userShares:      ${vault.userShares.toString()}`);
	console.log(`totalShares:     ${vault.totalShares.toString()}`);
	const managerShares = vault.totalShares.sub(vault.userShares);
	const managerSharePct =
		managerShares.toNumber() / vault.totalShares.toNumber();
	console.log(
		`  [managerShares]: ${managerShares.toString()} (${(
			managerSharePct * 100.0
		).toFixed(4)}%)`
	);
	console.log(`totalShares:     ${vault.totalShares.toString()}`);
	console.log(`lastFeeUpdateTs:    ${vault.lastFeeUpdateTs.toString()}`);
	console.log(`liquidationStartTs: ${vault.liquidationStartTs.toString()}`);
	console.log(`redeemPeriod:            ${vault.redeemPeriod.toString()}`);
	console.log(
		`totalWithdrawRequested:  ${vault.totalWithdrawRequested.toString()}`
	);
	console.log(
		`maxTokens:               ${convertToNumber(
			vault.maxTokens,
			spotPrecision
		)} ${spotSymbol} (${vault.maxTokens.toString()})`
	);
	console.log(`sharesBase:              ${vault.sharesBase}`);
	console.log(`managementFee:           ${vault.managementFee.toString()}`);
	console.log(`initTs:                  ${vault.initTs.toString()}`);
	console.log(
		`netDeposits:             ${convertToNumber(
			vault.netDeposits,
			spotPrecision
		)} ${spotSymbol} (${vault.netDeposits.toString()})`
	);
	console.log(
		`totalDeposits:           ${convertToNumber(
			vault.totalDeposits,
			spotPrecision
		)} ${spotSymbol} (${vault.totalDeposits.toString()})`
	);
	console.log(
		`totalWithdraws:          ${convertToNumber(
			vault.totalWithdraws,
			spotPrecision
		)} ${spotSymbol} (${vault.totalWithdraws.toString()})`
	);
	console.log(
		`managerNetDeposits:      ${convertToNumber(
			vault.managerNetDeposits,
			spotPrecision
		)} ${spotSymbol} (${vault.managerNetDeposits.toString()})`
	);
	console.log(
		`managerTotalDeposits:    ${convertToNumber(
			vault.managerTotalDeposits,
			spotPrecision
		)} ${spotSymbol} (${vault.managerTotalDeposits.toString()})`
	);
	console.log(
		`managerTotalWithdraws:   ${convertToNumber(
			vault.managerTotalWithdraws,
			spotPrecision
		)} ${spotSymbol} (${vault.managerTotalWithdraws.toString()})`
	);
	console.log(
		`managerTotalFee:         ${convertToNumber(
			vault.managerTotalFee,
			spotPrecision
		)} ${spotSymbol} (${vault.managerTotalFee.toString()})`
	);
	console.log(
		`managerTotalProfitShare: ${convertToNumber(
			vault.managerTotalProfitShare,
			spotPrecision
		)} ${spotSymbol} (${vault.managerTotalProfitShare.toString()})`
	);
	console.log(`lastManagerWithdrawRequest:`);
	console.log(
		`  shares: ${vault.lastManagerWithdrawRequest.shares.toString()}`
	);
	console.log(
		`  values: ${convertToNumber(
			vault.lastManagerWithdrawRequest.value,
			spotPrecision
		)} ${spotSymbol} (${vault.lastManagerWithdrawRequest.value.toString()})`
	);
	console.log(`  ts:     ${vault.lastManagerWithdrawRequest.ts.toString()}`);
	console.log(`FeeUpdate Account:`);
	if (feeUpdateAccount) {
		const timeUntilUpdate = feeUpdateAccount.incomingUpdateTs.sub(
			new BN(Date.now() / 1000)
		);
		console.log(
			`  incomingUpdateTs: ${feeUpdateAccount.incomingUpdateTs.toString()} (in ${timeUntilUpdate.toString()} seconds)`
		);
		console.log(
			`  incomingManagementFee: ${vault.managementFee.toString()} -> ${feeUpdateAccount.incomingManagementFee.toString()}`
		);
		console.log(
			`  incomingProfitShare:   ${vault.profitShare} -> ${feeUpdateAccount.incomingProfitShare}`
		);
		console.log(
			`  incomingHurdleRate:    ${vault.hurdleRate} -> ${feeUpdateAccount.incomingHurdleRate}`
		);
	} else {
		console.log(`  None`);
	}
	console.log(`minDepositAmount:  ${vault.minDepositAmount.toString()}`);
	console.log(`profitShare:       ${vault.profitShare}`);
	console.log(`hurdleRate:        ${vault.hurdleRate}`);
	console.log(`spotMarketIndex:   ${vault.spotMarketIndex}`);
	console.log(`permissioned:      ${vault.permissioned}`);

	const vaultEquityNum = convertToNumber(vaultEquity, QUOTE_PRECISION);
	const netDepositsNum = convertToNumber(vault.netDeposits, spotPrecision);
	console.log(`vaultEquity (USDC):   $${vaultEquityNum}`);
	console.log(`manager share (USDC): $${managerSharePct * vaultEquityNum}`);

	const vaultEquitySpot = vaultEquityNum / oraclePriceNum;

	const user = new User({
		// accountSubscription,
		driftClient,
		userAccountPublicKey: vault.user,
	});
	await user.subscribe();

	for (const spotPos of user.getActiveSpotPositions()) {
		const sm = driftClient.getSpotMarketAccount(spotPos.marketIndex)!;
		const prec = TEN.pow(new BN(sm.decimals));
		const sym = decodeName(sm.name);
		const bal = getSignedTokenAmount(
			getTokenAmount(spotPos.scaledBalance, sm, spotPos.balanceType),
			spotPos.balanceType
		);
		console.log(
			`Spot Position: ${spotPos.marketIndex}, ${convertToNumber(
				bal,
				prec
			)} ${sym}`
		);
	}

	for (const perpPos of user.getActivePerpPositions()) {
		console.log(
			`Perp Position: ${perpPos.marketIndex}, base: ${convertToNumber(
				perpPos.baseAssetAmount,
				BASE_PRECISION
			)}, quote: ${convertToNumber(perpPos.quoteAssetAmount, QUOTE_PRECISION)}`
		);
		const upnl = user.getUnrealizedPNL(true, perpPos.marketIndex);
		console.log(`  upnl: ${convertToNumber(upnl, QUOTE_PRECISION)}`);
	}

	console.log(`vaultEquity (${spotSymbol}):   ${vaultEquitySpot}`);
	console.log(
		`manager share (${spotSymbol}): ${managerSharePct * vaultEquitySpot}`
	);
	console.log(
		`vault PnL     (${spotSymbol}):   ${vaultEquitySpot - netDepositsNum}`
	);
	console.log(
		`vault PnL (USD) ${convertToNumber(
			user.getTotalAllTimePnl(),
			QUOTE_PRECISION
		)}`
	);
	console.log(
		`vault PnL (spot) ${
			convertToNumber(user.getTotalAllTimePnl(), QUOTE_PRECISION) /
			oraclePriceNum
		}`
	);

	return {
		managerShares,
		managerSharePct,
	};
}

export function printVaultDepositor(vaultDepositor: VaultDepositor) {
	console.log(`vault:          ${vaultDepositor.vault.toBase58()}`);
	console.log(`pubkey:         ${vaultDepositor.pubkey.toBase58()}`);
	console.log(`authority:      ${vaultDepositor.authority.toBase58()}`);
	console.log(`vaultShares:    ${vaultDepositor.vaultShares.toString()}`);
	console.log(
		`lastWithdrawRequest.Shares:   ${vaultDepositor.lastWithdrawRequest.shares.toString()}`
	);
	console.log(
		`lastWithdrawRequest.Value:    ${vaultDepositor.lastWithdrawRequest.value.toString()}`
	);
	console.log(
		`lastWithdrawRequest.Ts:       ${vaultDepositor.lastWithdrawRequest.ts.toString()}`
	);
	console.log(
		`lastValidTs:                 ${vaultDepositor.lastValidTs.toString()}`
	);
	console.log(
		`netDeposits:                 ${vaultDepositor.netDeposits.toString()}`
	);
	console.log(
		`totalDeposits:               ${vaultDepositor.totalDeposits.toString()}`
	);
	console.log(
		`totalWithdraws:              ${vaultDepositor.totalWithdraws.toString()}`
	);
	console.log(
		`cumulativeProfitShareAmount: ${vaultDepositor.cumulativeProfitShareAmount.toString()}`
	);
	console.log(
		`vaultSharesBase:             ${vaultDepositor.vaultSharesBase.toString()}`
	);
}

export async function getCommandContext(
	program: Command,
	needToSign: boolean
): Promise<{
	driftClient: DriftClient;
	driftVault: VaultClient;
	wallet: Wallet;
}> {
	const opts = program.opts();

	let wallet: Wallet;
	const isLedgerUrl = opts.keypair.startsWith('usb://ledger');
	console.log('isLedgerUrl:', isLedgerUrl);

	if (isLedgerUrl || fs.existsSync(opts.keypair)) {
		console.log('opts.keypair:', opts.keypair);
	} else {
		console.log('opts.keypair:', opts.keypair.replace(/./g, '*'));
	}

	let loadedKeypair = false;
	wallet = new Wallet(Keypair.generate());

	if (isLedgerUrl) {
		wallet = (await getLedgerWallet(opts.keypair)) as unknown as Wallet;
		loadedKeypair = true;
	} else if (opts.keypair) {
		try {
			const keypair = loadKeypair(opts.keypair as string);
			wallet = new Wallet(keypair);
			loadedKeypair = true;
		} catch (e) {
			console.error(`Need to provide a valid keypair: ${e}`);
			process.exit(1);
		}
	} else {
		if (needToSign) {
			throw new Error('Need to provide a keypair.');
		}
	}

	const driftEnv = opts.env as DriftEnv;
	console.log('driftEnv:', driftEnv);

	if (loadedKeypair) {
		console.log(`Loaded wallet address: ${wallet.publicKey.toBase58()}`);
	}

	const connection = new Connection(opts.url, {
		commitment: opts.commitment,
	});

	const driftClient = new DriftClient({
		connection,
		wallet,
		env: driftEnv as DriftEnv,
		opts: {
			commitment: opts.commitment,
			skipPreflight: false,
			preflightCommitment: opts.commitment,
		},
		txSender: new WhileValidTxSender({
			connection,
			wallet,
			opts: {
				maxRetries: 0,
			},
			retrySleep: 1000,
		}),
	});
	await driftClient.subscribe();

	const provider = new AnchorProvider(connection, wallet as AnchorWallet, {});
	anchor.setProvider(provider);
	const vaultProgram = new anchor.Program<DriftVaults>(IDL, provider);

	const driftVault = new VaultClient({
		driftClient,
		program: vaultProgram,
		cliMode: true,
	});

	return {
		driftClient,
		driftVault,
		wallet,
	};
}

/// a valid blockhash to allow tx simulation
export const BLOCKHASH_PLACEHOLDER =
	'CHNfFRxxeCTyy1RRnKGsV2dkrJfKwVEa8zE7cZgK4TSe';

export function dumpTransactionMessage(
	payer: PublicKey,
	ixs: Array<TransactionInstruction>
): string {
	const tx = new Transaction();
	tx.add(...ixs);
	tx.feePayer = payer;
	tx.recentBlockhash = BLOCKHASH_PLACEHOLDER;

	return bs58.encode(tx.serialize({ requireAllSignatures: false }));
}
