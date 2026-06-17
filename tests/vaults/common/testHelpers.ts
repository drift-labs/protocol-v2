// Vaults test helpers.
//
// The shared drift/velocity helpers (USDC mint, oracle, spot-market init, user
// bootstrap) are re-exported from the velocity suite's testHelpers so the vaults
// tests exercise the same velocity-adapted account layouts. Only the
// vault-specific helpers are defined here, ported from drift-vaults'
// tests/common/testHelpers and adapted to the velocity SDK + vaults SDK.
import * as anchor from '@coral-xyz/anchor';
import { BN, Program, Wallet } from '@coral-xyz/anchor';
import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	TransactionSignature,
} from '@solana/web3.js';
import { BankrunProvider } from 'anchor-bankrun';
import { Metaplex } from '@metaplex-foundation/js';
import {
	TestClient,
	User,
	VelocityClientConfig as DriftClientConfig,
	UserMapConfig,
	parseLogs,
} from '@velocity-exchange/sdk';
import { VaultClient, IDL } from '@velocity-exchange/vaults-sdk';
import { BankrunContextWrapper } from './bankrunConnection';
import { mockUserUSDCAccount } from '../../velocity/testHelpers';

export {
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockUSDCMint,
	// drift-vaults named the bankrun mint/ata helpers with a `Bankrun` suffix;
	// the velocity helpers are already bankrun-only, so alias them.
	mockUSDCMint as mockUSDCMintBankrun,
	mockUserUSDCAccount as mockUserUSDCAccountBankrun,
	mockOracle,
	setFeedPrice,
	sleep,
	createUserWithUSDCAccount,
} from '../../velocity/testHelpers';

/**
 * Fetches a transaction's logs and returns the program's decoded Anchor events.
 * Ported from drift-vaults: the velocity testHelpers' printTxLogs returns raw
 * log strings, but the vaults tests expect parsed events (e.g. `.data.action`).
 */
export async function printTxLogs(
	connection: Connection,
	txSig: TransactionSignature,
	dumpEvents = false,
	program?: Program
): Promise<Array<any>> {
	const tx = await connection.getTransaction(txSig, {
		commitment: 'confirmed',
		maxSupportedTransactionVersion: 0,
	});
	const events = [];
	for (const e of parseLogs(
		program!,
		tx!.meta!.logMessages!,
		program!.programId!.toBase58()!
	)) {
		events.push(e);
	}
	if (dumpEvents) {
		console.log(JSON.stringify(events));
	}
	return events;
}

/**
 * Funds `signer`, builds a velocity TestClient + a vaults VaultClient bound to
 * it, mints `usdcAmount` to a fresh USDC token account, subscribes, and (unless
 * delegated) initializes a user sub-account. Ported from drift-vaults; `usdcMint`
 * is the velocity mint Keypair (velocity's mockUSDCMint returns a Keypair).
 */
export async function bootstrapSignerClientAndUserBankrun(params: {
	bankrunContext: BankrunContextWrapper;
	signer: Keypair;
	usdcMint: Keypair;
	usdcAmount: BN;
	programId: anchor.web3.PublicKey;
	vaultClientCliMode?: boolean;
	skipUser?: boolean;
	driftClientConfig?: Omit<DriftClientConfig, 'connection' | 'wallet'>;
	userMapConfig?: UserMapConfig;
	metaplex?: Metaplex;
}): Promise<{
	signer: Keypair;
	wallet: Wallet;
	user: User;
	userUSDCAccount: Keypair;
	driftClient: TestClient;
	vaultClient: VaultClient;
}> {
	const {
		signer,
		usdcMint,
		usdcAmount,
		vaultClientCliMode,
		driftClientConfig,
		bankrunContext,
	} = params;

	await bankrunContext.fundKeypair(signer, LAMPORTS_PER_SOL);

	const wallet = new Wallet(signer);

	const driftClient = new TestClient({
		connection: bankrunContext.connection.toConnection(),
		wallet: new Wallet(signer),
		txVersion: 'legacy',
		activeSubAccountId: driftClientConfig?.activeSubAccountId,
		subAccountIds: driftClientConfig?.subAccountIds,
		accountSubscription: driftClientConfig?.accountSubscription,
		perpMarketIndexes: driftClientConfig?.perpMarketIndexes,
		spotMarketIndexes: driftClientConfig?.spotMarketIndexes,
		oracleInfos: driftClientConfig?.oracleInfos,
		authority: driftClientConfig?.authority,
	});

	const provider = new BankrunProvider(
		bankrunContext.context,
		wallet as anchor.Wallet
	);
	const program = new Program(IDL, provider);
	const vaultClient = new VaultClient({
		driftClient,
		// @ts-ignore
		program,
		cliMode: vaultClientCliMode ?? true,
		metaplex: params.metaplex,
		userMapConfig: params.userMapConfig,
	});

	const userUSDCAccount = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		bankrunContext,
		signer.publicKey
	);

	await driftClient.subscribe();
	if (!driftClientConfig?.authority) {
		await driftClient.initializeUserAccount(
			driftClientConfig?.activeSubAccountId ?? 0
		);
	}

	return {
		signer,
		wallet,
		user: driftClient.getUser(),
		userUSDCAccount,
		driftClient,
		vaultClient,
	};
}
