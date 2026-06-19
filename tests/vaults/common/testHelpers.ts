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
	PublicKey,
	TransactionSignature,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getMint } from '@solana/spl-token';
import { BankrunProvider } from 'anchor-bankrun';
import { Metaplex } from '@metaplex-foundation/js';
import {
	TestClient,
	User,
	VelocityClient,
	VelocityClientConfig,
	UserMapConfig,
	parseLogs,
	OracleInfo,
	OrderType,
	MarketType,
	PositionDirection,
	OrderParamsBitFlag,
	getOrderParams,
	getTokenAmount,
	getSignedTokenAmount,
	convertToNumber,
	isVariant,
	getUserStatsAccountPublicKey,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	BASE_PRECISION,
	TEN,
	VELOCITY_PROGRAM_ID as DRIFT_PROGRAM_ID,
} from '@velocity-exchange/sdk';
import {
	VaultClient,
	IDL,
	Vaults,
	getVaultDepositorAddressSync,
	getTokenizedVaultAddressSync,
	getTokenizedVaultMintAddressSync,
} from '@velocity-exchange/vaults-sdk';
import { BankrunContextWrapper } from './bankrunConnection';
import {
	mockUserUSDCAccount,
	createWSolTokenAccountForUser,
	createUserWithUSDCAndWSOLAccount,
} from '../../velocity/testHelpers';
import { assert } from 'chai';

export { assert };

export {
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockUSDCMint,
	// drift-vaults named the bankrun mint/ata helpers with a `Bankrun` suffix;
	// the velocity helpers are already bankrun-only, so alias them.
	mockUSDCMint as mockUSDCMintBankrun,
	mockUserUSDCAccount as mockUserUSDCAccountBankrun,
	mockOracle,
	mockOracleNoProgram,
	// drift-vaults' tests call `setFeedPrice`; on bankrun the price feed is a
	// PythLazer account written directly, so map it onto the no-program variant.
	setFeedPriceNoProgram as setFeedPrice,
	setFeedPriceNoProgram,
	sleep,
	createUserWithUSDCAccount,
} from '../../velocity/testHelpers';

export { createUserWithUSDCAndWSOLAccount };

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
	// On bankrun a tx is only retrievable from the BankrunConnection it was sent
	// through. Raw `program.methods.*().rpc()` calls route through a different
	// provider connection than the one passed here, so the tx may be null. The
	// callers that assert on events send through the same connection; the rest
	// only log, so tolerate a missing tx instead of throwing.
	if (tx?.meta?.logMessages) {
		for (const e of parseLogs(
			program!,
			tx.meta.logMessages,
			program!.programId!.toBase58()!
		)) {
			events.push(e);
		}
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
	// If true, no drift user sub-account is initialized for the signer (e.g. for
	// pure vault-depositors or delegates that never trade on their own account).
	skipUser?: boolean;
	// If true, the freshly minted USDC is deposited into the signer's drift user
	// spot position (idx 0). Only meaningful when a user is initialized.
	depositCollateral?: boolean;
	// If provided, a WSOL token account is funded with this many lamports.
	solAmount?: BN;
	velocityClientConfig?: Omit<VelocityClientConfig, 'connection' | 'wallet'>;
	userMapConfig?: UserMapConfig;
	metaplex?: Metaplex;
}): Promise<{
	signer: Keypair;
	wallet: Wallet;
	user: User;
	userUSDCAccount: Keypair;
	userWSOLAccount: PublicKey | undefined;
	velocityClient: TestClient;
	vaultClient: VaultClient;
}> {
	const {
		signer,
		usdcMint,
		usdcAmount,
		vaultClientCliMode,
		skipUser,
		depositCollateral,
		solAmount,
		velocityClientConfig,
		bankrunContext,
	} = params;

	await bankrunContext.fundKeypair(signer, LAMPORTS_PER_SOL);

	const wallet = new Wallet(signer);

	const velocityClient = new TestClient({
		connection: bankrunContext.connection.toConnection(),
		wallet: new Wallet(signer),
		txVersion: 'legacy',
		activeSubAccountId: velocityClientConfig?.activeSubAccountId,
		subAccountIds: velocityClientConfig?.subAccountIds,
		accountSubscription: velocityClientConfig?.accountSubscription,
		perpMarketIndexes: velocityClientConfig?.perpMarketIndexes,
		spotMarketIndexes: velocityClientConfig?.spotMarketIndexes,
		oracleInfos: velocityClientConfig?.oracleInfos,
		authority: velocityClientConfig?.authority,
	});

	const provider = new BankrunProvider(
		bankrunContext.context,
		wallet as anchor.Wallet
	);
	const program = new Program(IDL, provider);
	const vaultClient = new VaultClient({
		velocityClient,
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

	// Only fund a WSOL token account when the caller asks for one (solAmount).
	// Doing it unconditionally moves lamports out of the signer's native balance
	// and skews tests that measure SOL balances (e.g. trustedVault's borrow math).
	let userWSOLAccount: PublicKey | undefined;
	if (solAmount !== undefined) {
		userWSOLAccount = await createWSolTokenAccountForUser(
			bankrunContext,
			signer,
			solAmount
		);
	}

	await velocityClient.subscribe();
	if (!skipUser && !velocityClientConfig?.authority) {
		await velocityClient.initializeUserAccount(
			velocityClientConfig?.activeSubAccountId ?? 0
		);
		if (depositCollateral) {
			await velocityClient.deposit(usdcAmount, 0, userUSDCAccount.publicKey);
		}
	}

	return {
		signer,
		wallet,
		user: skipUser ? undefined : velocityClient.getUser(),
		userUSDCAccount,
		userWSOLAccount,
		velocityClient,
		vaultClient,
	};
}

/**
 * Initializes a SOL spot-market maker on bankrun: a drift user with USDC + WSOL
 * collateral that requotes a bid/ask around the SOL oracle. Ported from
 * drift-vaults, adapted to the velocity bankrun harness (takes the
 * BankrunContextWrapper + a TestBulkAccountLoader instead of an AnchorProvider).
 */
export async function initializeSolSpotMarketMaker(
	bankrunContext: BankrunContextWrapper,
	usdcMint: Keypair,
	chProgram: Program,
	oracleInfos: OracleInfo[] = [],
	solAmount?: BN,
	usdcAmount?: BN,
	accountLoader?: any
): Promise<{
	velocityClient: TestClient;
	solAccount: PublicKey;
	usdcAccount: PublicKey;
	userKeyPair: Keypair;
	requoteFunc: (bid?: BN, ask?: BN, print?: boolean) => Promise<void>;
}> {
	const solDepositAmount = solAmount ?? new BN(10_000 * LAMPORTS_PER_SOL);
	const usdcDepositAmount = usdcAmount ?? new BN(1_000_000 * 1e6);

	const [velocityClient, solAccount, usdcAccount, userKeyPair] =
		await createUserWithUSDCAndWSOLAccount(
			bankrunContext,
			usdcMint,
			chProgram,
			solDepositAmount,
			usdcDepositAmount,
			[],
			[0, 1],
			oracleInfos,
			accountLoader
		);
	await velocityClient.updateUserMarginTradingEnabled([
		{
			marginTradingEnabled: true,
			subAccountId: 0,
		},
	]);

	const usdcMarket = velocityClient.getSpotMarketAccount(0);
	assert(usdcMarket !== undefined, 'usdcMarket was not initialized');
	const solMarket = velocityClient.getSpotMarketAccount(1);
	assert(solMarket !== undefined, 'solMarket was not initialized');

	await velocityClient.deposit(usdcDepositAmount, 0, usdcAccount);
	await velocityClient.deposit(solDepositAmount, 1, solAccount);

	const requoteFunc = async (bid?: BN, ask?: BN, print?: boolean) => {
		await velocityClient.fetchAccounts();
		const solOracle = velocityClient.getOracleDataForSpotMarket(1);

		const bidPrice =
			bid ?? solOracle.price.sub(new BN(10).mul(solMarket!.orderTickSize));
		const askPrice =
			ask ?? solOracle.price.add(new BN(10).mul(solMarket!.orderTickSize));

		const solPos = velocityClient.getUser().getSpotPosition(1);
		const solBal = getSignedTokenAmount(
			getTokenAmount(solPos!.scaledBalance, solMarket!, solPos!.balanceType),
			solPos!.balanceType
		);

		const solPrec = TEN.pow(new BN(solMarket!.decimals));

		try {
			const askAmount = convertToNumber(solBal, solPrec) / 10;
			const bidAmount = askAmount;
			if (print) {
				console.log(
					`mm ${velocityClient.authority.toBase58()} requoting around ${convertToNumber(
						solOracle.price
					)}. bid: ${bidAmount}@$${convertToNumber(
						bidPrice
					)}, ask: ${askAmount}@$${convertToNumber(askPrice)}`
				);
			}

			await velocityClient.cancelAndPlaceOrders(
				{
					marketType: MarketType.SPOT,
					marketIndex: 1,
				},
				[
					getOrderParams({
						orderType: OrderType.LIMIT,
						marketType: MarketType.SPOT,
						marketIndex: 1,
						direction: PositionDirection.LONG,
						price: bidPrice,
						baseAssetAmount: new BN(bidAmount * solPrec.toNumber()),
					}),
					getOrderParams({
						orderType: OrderType.LIMIT,
						marketType: MarketType.SPOT,
						marketIndex: 1,
						direction: PositionDirection.SHORT,
						price: askPrice,
						baseAssetAmount: new BN(askAmount * solPrec.toNumber()),
					}),
				]
			);
		} catch (e) {
			console.error(e);
			throw new Error(`mm failed to requote`);
		}
	};

	return {
		velocityClient,
		solAccount,
		usdcAccount,
		userKeyPair,
		requoteFunc,
	};
}

/**
 * Computes a vault depositor's value/equity, optionally including a tokenized
 * vault depositor's token-account holdings. Ported from drift-vaults.
 */
export async function getVaultDepositorValue(params: {
	vaultClient: VaultClient;
	vault: PublicKey;
	vaultDepositor: PublicKey;
	tokenizedVaultDepositor?: PublicKey;
	tokenizedVaultAta?: PublicKey;
	print?: boolean;
}): Promise<{
	vaultEquity: BN;
	vaultShares: BN;
	vaultDepositorShares: BN;
	vaultDepositorEquity: BN;
	vaultDepositorShareOfVault: number;
	tokenizedVaultDepositorEquity?: BN;
	tokenizedVaultDepositorShareOfVault?: number;
	ataBalance?: BN;
	ataShareOfSupply?: number;
	ataValue?: BN;
}> {
	const vaultAccount = await params.vaultClient.getVault(params.vault);
	const vaultDepositorAccount =
		await params.vaultClient.program.account.vaultDepositor.fetch(
			params.vaultDepositor
		);
	let tokenizedVaultDepositorAccount = undefined;
	try {
		tokenizedVaultDepositorAccount = params.tokenizedVaultDepositor
			? await params.vaultClient.program.account.tokenizedVaultDepositor.fetch(
					params.tokenizedVaultDepositor
			  )
			: undefined;
	} catch (e) {
		console.log('failed to get tokenized vault depositor account', e);
	}

	const vaultEquity =
		await params.vaultClient.calculateVaultEquityInDepositAsset({
			address: params.vault,
		});

	assert(
		vaultAccount.sharesBase === vaultDepositorAccount.vaultSharesBase,
		'vaultDepositorAccount.vaultSharesBase is not equal to vaultAccount.sharesBase'
	);
	if (tokenizedVaultDepositorAccount) {
		assert(
			tokenizedVaultDepositorAccount.vaultSharesBase ===
				vaultAccount.sharesBase,
			'tokenizedVaultDepositorAccount.vaultSharesBase is not equal to vaultAccount.sharesBase'
		);
	}

	let tokenizedVaultDepositorEquity: BN;
	let tokenizedVaultDepositorShareOfVault: number;
	let ataBalance: BN;
	let ataValue: BN;
	let ataShareOfSupply: number;
	if (params.tokenizedVaultDepositor) {
		tokenizedVaultDepositorEquity = vaultEquity
			.mul(tokenizedVaultDepositorAccount.vaultShares)
			.div(vaultAccount.totalShares);
		tokenizedVaultDepositorShareOfVault =
			tokenizedVaultDepositorAccount.vaultShares.toNumber() /
			vaultAccount.totalShares.toNumber();

		if (params.tokenizedVaultAta) {
			try {
				const ata =
					await params.vaultClient.velocityClient.connection.getTokenAccountBalance(
						params.tokenizedVaultAta
					);
				const mint = await getMint(
					params.vaultClient.velocityClient.connection,
					tokenizedVaultDepositorAccount.mint
				);
				const totalSupply = new BN(mint.supply.toString());

				ataBalance = new BN(ata.value.amount);
				if (!totalSupply.isZero()) {
					ataShareOfSupply = ataBalance.toNumber() / totalSupply.toNumber();
					ataValue = tokenizedVaultDepositorEquity
						.mul(ataBalance)
						.div(totalSupply);
				} else {
					ataShareOfSupply = null;
					ataValue = null;
				}
			} catch (e) {
				console.log(
					`depositor ${params.vaultDepositor.toBase58()} has no tokenized ATA (${params.tokenizedVaultAta.toBase58()})`
				);
			}
		}
	}

	const vaultDepositorEquity = vaultEquity
		// @ts-ignore
		.mul(vaultDepositorAccount.vaultShares)
		.div(vaultAccount.totalShares);
	const vaultDepositorShareOfVault =
		vaultDepositorAccount.vaultShares.toNumber() /
		vaultAccount.totalShares.toNumber();

	if (params.print) {
		console.log(`Vault:          ${params.vault.toBase58()}`);
		console.log(`VaultDepositor: ${params.vaultDepositor.toBase58()}`);
		console.log(
			`TokenizedVaultDepositor: ${params.tokenizedVaultDepositor?.toBase58()}`
		);
		console.log(
			`  vaultEquity:          ${convertToNumber(
				vaultEquity,
				QUOTE_PRECISION
			).toString()}`
		);
		console.log(
			`  vaultDepositorEquity: ${convertToNumber(
				vaultDepositorEquity,
				QUOTE_PRECISION
			).toString()}`
		);
		console.log(
			`  vaultDepositorShareOfVault: ${vaultDepositorShareOfVault * 100}%`
		);
		console.log(
			`  tokenizedVaultDepositorEquity:       ${convertToNumber(
				tokenizedVaultDepositorEquity,
				QUOTE_PRECISION
			).toString()}`
		);
		console.log(
			`  tokenizedVaultDepositorShareOfVault: ${
				tokenizedVaultDepositorShareOfVault * 100
			}%`
		);
		console.log(`  ataBalance: ${ataBalance?.toString()}`);
		console.log(
			`  ataValue:   ${convertToNumber(ataValue, QUOTE_PRECISION).toString()}`
		);
		console.log(`  ataShareOfSupply: ${ataShareOfSupply * 100}%`);
	}

	return {
		vaultEquity,
		vaultShares: vaultAccount.totalShares,
		// @ts-ignore
		vaultDepositorShares: vaultDepositorAccount.vaultShares,
		vaultDepositorEquity,
		vaultDepositorShareOfVault,
		tokenizedVaultDepositorEquity,
		tokenizedVaultDepositorShareOfVault,
		ataBalance,
		ataValue,
		ataShareOfSupply,
	};
}

/**
 * Derives the set of PDAs/ATAs for a tokenized vault depositor. Ported from
 * drift-vaults.
 */
export function calculateAllTokenizedVaultPdas(
	vaultProgramId: PublicKey,
	vault: PublicKey,
	vaultDepositorAuthority: PublicKey,
	vaultSharesBase: number
): {
	vaultDepositor: PublicKey;
	tokenizedVaultDepositor: PublicKey;
	mintAddress: PublicKey;
	userVaultTokenAta: PublicKey;
	vaultTokenizedTokenAta: PublicKey;
} {
	const mintAddress = getTokenizedVaultMintAddressSync(
		vaultProgramId,
		vault,
		vaultSharesBase
	);

	return {
		vaultDepositor: getVaultDepositorAddressSync(
			vaultProgramId,
			vault,
			vaultDepositorAuthority
		),
		tokenizedVaultDepositor: getTokenizedVaultAddressSync(
			vaultProgramId,
			vault,
			vaultSharesBase
		),
		mintAddress,
		userVaultTokenAta: getAssociatedTokenAddressSync(
			mintAddress,
			vaultDepositorAuthority,
			true
		),
		vaultTokenizedTokenAta: getAssociatedTokenAddressSync(
			mintAddress,
			vault,
			true
		),
	};
}

/**
 * Validates that the total user shares (vaultDepositors + tokenizedVaultDepositors)
 * matches the vault's userShares. Ported from drift-vaults.
 */
/**
 * Validates that the sum of all (regular + tokenized) vault-depositor shares
 * equals the vault's `userShares`.
 *
 * Upstream drift enumerated the depositors via `program.account.*.all()`
 * (getProgramAccounts), which the bankrun connection does not implement. On
 * bankrun every account address is derivable, so callers pass the explicit
 * depositor PDA lists they created; each is fetched individually (a single
 * getAccountInfo, which bankrun supports). PDAs that don't exist yet are
 * skipped, so over-listing is safe.
 */
export async function validateTotalUserShares(
	program: anchor.Program<Vaults>,
	vault: PublicKey,
	vaultDepositors: PublicKey[] = [],
	tokenizedVaultDepositors: PublicKey[] = []
) {
	const vaultAccount = await program.account.vault.fetch(vault);

	let vdSharesTotal = new BN(0);
	for (const vd of vaultDepositors) {
		try {
			const acct = await program.account.vaultDepositor.fetch(vd);
			vdSharesTotal = vdSharesTotal.add(acct.vaultShares);
		} catch {
			// depositor not created yet — skip
		}
	}

	let tvdSharesTotal = new BN(0);
	for (const tvd of tokenizedVaultDepositors) {
		try {
			const acct = await program.account.tokenizedVaultDepositor.fetch(tvd);
			tvdSharesTotal = tvdSharesTotal.add(acct.vaultShares);
		} catch {
			// tokenized depositor not created yet — skip
		}
	}

	assert(
		tvdSharesTotal.add(vdSharesTotal).eq(vaultAccount.userShares),
		`vdSharesTotal (${vdSharesTotal.toString()}) + tvdSharesTotal (${tvdSharesTotal.toString()}) != vault.userShares (${vaultAccount.userShares.toString()})`
	);
}

/**
 * Drives a trader (the vault's delegated user) to trade spot SOL against a
 * market maker until the vault's equity moves by `stopPnlDiffPct`. Ported from
 * drift-vaults.
 */
export async function doWashTrading({
	mmVelocityClient,
	traderVelocityClient,
	vaultClient,
	vaultAddress,
	startVaultEquity,
	stopPnlDiffPct,
	maxIters,
	traderAuthority,
	traderSubAccount = 0,
	mmRequoteFunc,
	mmQuoteSpreadBps = 500,
	mmQuoteOffsetBps = 0,
	doSell = true,
}: {
	mmVelocityClient: VelocityClient;
	traderVelocityClient: VelocityClient;
	vaultClient: VaultClient;
	vaultAddress: PublicKey;
	startVaultEquity: BN;
	stopPnlDiffPct?: number;
	maxIters?: number;
	traderAuthority: PublicKey;
	traderSubAccount?: number;
	mmRequoteFunc: (price?: BN, size?: BN) => Promise<void>;
	mmQuoteSpreadBps?: number;
	mmQuoteOffsetBps?: number;
	doSell?: boolean;
}) {
	let diff = 1;
	let i = 0;
	stopPnlDiffPct = stopPnlDiffPct ?? -0.999;
	maxIters = maxIters ?? 100;
	console.log(
		`Trading against MM until pnl is ${
			stopPnlDiffPct * 100
		}%, starting at ${convertToNumber(
			startVaultEquity,
			QUOTE_PRECISION
		).toString()}, max ${maxIters} iters`
	);
	let vaultEquity = startVaultEquity;

	const usdcSpotMarket = mmVelocityClient.getSpotMarketAccount(0);
	if (!usdcSpotMarket) {
		throw new Error('No USDC spot market at idx 0, misconfigured?');
	}

	const marketIndex = 1;

	while (diff > stopPnlDiffPct && i < maxIters) {
		try {
			const oracle = mmVelocityClient.getOracleDataForSpotMarket(marketIndex);
			if (!oracle) {
				throw new Error(
					`No oracle for spot market at idx ${marketIndex}, misconfigured?`
				);
			}
			const oraclePrice = convertToNumber(oracle.price, PRICE_PRECISION);

			const bid =
				(oraclePrice + mmQuoteOffsetBps / 10_000) *
				(1 - mmQuoteSpreadBps / 10_000);
			const ask =
				(oraclePrice + mmQuoteOffsetBps / 10_000) *
				(1 + mmQuoteSpreadBps / 10_000);

			await mmRequoteFunc(
				new BN(bid * PRICE_PRECISION.toNumber()),
				new BN(ask * PRICE_PRECISION.toNumber())
			);

			i++;
			await traderVelocityClient.fetchAccounts();

			const mmUser = mmVelocityClient.getUser();
			const mmOffer = mmUser
				.getOpenOrders()
				.find(
					(o) =>
						isVariant(o.marketType, 'spot') &&
						o.marketIndex === marketIndex &&
						isVariant(o.direction, 'short')
				);
			const mmBid = mmUser
				.getOpenOrders()
				.find(
					(o) =>
						isVariant(o.marketType, 'spot') &&
						o.marketIndex === marketIndex &&
						isVariant(o.direction, 'long')
				);
			assert(mmOffer !== undefined, 'mm has no offers');
			assert(mmBid !== undefined, 'mm has no bids');

			const vaultSpotPos0 = traderVelocityClient
				.getUser(traderSubAccount, traderAuthority)
				.getSpotPosition(0);
			const vaultUsdcBalance = getTokenAmount(
				vaultSpotPos0.scaledBalance,
				usdcSpotMarket,
				vaultSpotPos0.balanceType
			)
				.mul(new BN(90))
				.div(new BN(100));

			const bidAmount = vaultUsdcBalance.mul(BASE_PRECISION).div(mmOffer.price);

			await traderVelocityClient.placeAndTakeSpotOrder(
				{
					orderType: OrderType.LIMIT,
					marketIndex,
					baseAssetAmount: bidAmount,
					price: mmOffer.price,
					direction: PositionDirection.LONG,
					auctionDuration: 0,
					bitFlags: OrderParamsBitFlag.ImmediateOrCancel,
				},
				undefined,
				{
					maker: mmUser.getUserAccountPublicKey(),
					makerStats: getUserStatsAccountPublicKey(
						new PublicKey(DRIFT_PROGRAM_ID),
						mmVelocityClient.authority
					),
					makerUserAccount: mmUser.getUserAccount(),
					order: mmOffer,
				}
			);

			if (doSell) {
				await traderVelocityClient.placeAndTakeSpotOrder(
					{
						orderType: OrderType.LIMIT,
						marketIndex,
						baseAssetAmount: bidAmount,
						price: mmBid.price,
						direction: PositionDirection.SHORT,
						auctionDuration: 0,
						reduceOnly: true,
						bitFlags: OrderParamsBitFlag.ImmediateOrCancel,
					},
					undefined,
					{
						maker: mmUser.getUserAccountPublicKey(),
						makerStats: getUserStatsAccountPublicKey(
							new PublicKey(DRIFT_PROGRAM_ID),
							mmVelocityClient.authority
						),
						makerUserAccount: mmUser.getUserAccount(),
						order: mmBid,
					}
				);
			}

			vaultEquity = await vaultClient.calculateVaultEquityInDepositAsset({
				address: vaultAddress,
			});
			diff = vaultEquity.toNumber() / startVaultEquity.toNumber() - 1;
			if (i % 20 === 0) {
				console.log(
					`iter ${i}: Vault equity: ${convertToNumber(
						vaultEquity,
						QUOTE_PRECISION
					).toString()} (${diff * 100}%)`
				);
			}
		} catch (e) {
			console.error(e);
			if (i < 5) {
				// something wrong if we couldnt even do 1 iter
				assert(false, 'Failed to place and take orders');
			}
			console.log(
				`Breaking early, probably a margin error, got ${i} iters, pnl diff: ${diff}`
			);
			break;
		}
	}
	console.log(
		`\nFinal vault equity: ${convertToNumber(
			vaultEquity,
			QUOTE_PRECISION
		).toString()} (${diff * 100}% from start, ${i} iters)\n`
	);
}
