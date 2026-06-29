import { Program, Wallet } from '@coral-xyz/anchor';
import {
	AdminClient,
	BASE_PRECISION,
	BN,
	BulkAccountLoader,
	ZERO,
	PRICE_PRECISION,
	User,
	OracleSource,
	PublicKey,
	getLimitOrderParams,
	PostOnlyParams,
	PositionDirection,
	getUserAccountPublicKey,
	UserAccount,
	QUOTE_PRECISION,
	getOrderParams,
	MarketType,
	PEG_PRECISION,
	calculatePositionPNL,
	getInsuranceFundStakeAccountPublicKey,
	InsuranceFundStake,
	VelocityClient,
	OracleInfo,
	PERCENTAGE_PRECISION,
	TWO,
	VELOCITY_PROGRAM_ID as VELOCITY_PROGRAM_ID,
	WRAPPED_SOL_MINT,
	convertToNumber,
	OrderParamsBitFlag,
} from '@velocity-exchange/sdk';
import {
	bootstrapSignerClientAndUserBankrun,
	calculateAllTokenizedVaultPdas,
	doWashTrading,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	initializeSolSpotMarketMaker,
	mockUSDCMint,
	printTxLogs,
	setFeedPrice,
	validateTotalUserShares,
	assert,
} from './common/testHelpers';
import { BankrunContextWrapper } from './common/bankrunConnection';
import { mockOracleNoProgram } from './common/bankrunOracle';
import { TestBulkAccountLoader } from './common/testBulkAccountLoader';
import { startAnchor } from 'solana-bankrun';
import { BankrunProvider } from 'anchor-bankrun';
import { getMint } from '@solana/spl-token';
import { Keypair, LAMPORTS_PER_SOL, Signer } from '@solana/web3.js';
import { expect } from 'chai';
import {
	VaultClient,
	getTokenizedVaultMintAddressSync,
	getVaultAddressSync,
	getVaultDepositorAddressSync,
	encodeName,
	Vaults,
	VaultProtocolParams,
	getVaultProtocolAddressSync,
	WithdrawUnit,
	IDL,
	VAULT_PROGRAM_ID,
} from '@velocity-exchange/vaults-sdk';

import { Metaplex } from '@metaplex-foundation/js';

// ammInvariant == k == x * y
const mantissaSqrtScale = new BN(100_000);
const ammInitialQuoteAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);
const ammInitialBaseAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);

const METAPLEX_PROGRAM_ID = new PublicKey(
	'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
);

const initialSolPerpPrice = 100;

const perpMarketIndexes = [0];
const spotMarketIndexes = [0, 1];

/**
 * Adapter for the bankrun connection's getTokenAccountBalance, which returns the
 * decoded SPL `Account` (with `.amount: bigint`) rather than web3.js's
 * `{ value: { amount, uiAmount, uiAmountString } }`. Reshapes it into the
 * web3.js form the ported tests expect. `uiAmount` is only ever asserted as
 * `=== 0`, so a decimals-free reconstruction is sufficient.
 */
async function getTokenBalance(
	connection: { getTokenAccountBalance: (k: PublicKey) => Promise<any> },
	tokenAccount: PublicKey
): Promise<{
	value: { amount: string; uiAmount: number; uiAmountString: string };
}> {
	const acct = await connection.getTokenAccountBalance(tokenAccount);
	const amount = BigInt(acct.amount.toString());
	return {
		value: {
			amount: amount.toString(),
			uiAmount: Number(amount),
			uiAmountString: amount.toString(),
		},
	};
}

/**
 * Spins up a fresh bankrun context with the velocity protocol fully
 * bootstrapped (USDC mint, SOL oracle, quote + SOL spot markets, SOL-PERP
 * market) and returns the handles the vault tests need. Each describe block
 * gets its own context because bankrun contexts can't be shared.
 */
async function bootstrapBankrun(): Promise<{
	bankrunContextWrapper: BankrunContextWrapper;
	bulkAccountLoader: TestBulkAccountLoader;
	adminClient: AdminClient;
	program: Program<Vaults>;
	usdcMint: Keypair;
	solPerpOracle: PublicKey;
	metaplex: Metaplex;
	oracleInfos: OracleInfo[];
}> {
	const context = await startAnchor(
		'',
		[{ name: 'metaplex', programId: METAPLEX_PROGRAM_ID }],
		[]
	);
	const bankrunContextWrapper = new BankrunContextWrapper(context);
	const connection = bankrunContextWrapper.connection.toConnection();
	// The bankrun connection has no real RPC endpoint; Metaplex.make() runs
	// `new URL(connection.rpcEndpoint)` at construction, so give it a dummy one.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(connection as any).rpcEndpoint = 'http://localhost:8899';
	const bulkAccountLoader = new TestBulkAccountLoader(
		connection,
		'processed',
		1
	);

	const wallet = bankrunContextWrapper.provider.wallet as Wallet;
	const program = new Program<Vaults>(
		IDL,
		new BankrunProvider(context, wallet)
	);
	const metaplex = Metaplex.make(connection);

	const usdcMint = await mockUSDCMint(bankrunContextWrapper);
	const solPerpOracle = await mockOracleNoProgram(
		bankrunContextWrapper,
		initialSolPerpPrice
	);
	const oracleInfos: OracleInfo[] = [
		{ publicKey: solPerpOracle, source: OracleSource.PYTH_LAZER },
	];

	const adminClient = new AdminClient({
		connection,
		wallet,
		programID: new PublicKey(VELOCITY_PROGRAM_ID),
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId: 0,
		perpMarketIndexes,
		spotMarketIndexes,
		subAccountIds: [],
		oracleInfos,
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader as BulkAccountLoader,
		},
		txVersion: 'legacy',
	});

	await adminClient.initialize(usdcMint.publicKey, true);
	await adminClient.subscribe();
	await initializeQuoteSpotMarket(adminClient, usdcMint.publicKey);
	await initializeSolSpotMarket(adminClient, solPerpOracle);
	await adminClient.updateSpotMarketOrdersEnabled(0, true);
	await adminClient.updateSpotMarketOrdersEnabled(1, true);
	await adminClient.initializePerpMarket(
		0,
		solPerpOracle,
		ammInitialBaseAssetReserve,
		ammInitialQuoteAssetReserve,
		new BN(0), // 1 HOUR
		new BN(initialSolPerpPrice).mul(PEG_PRECISION)
	);
	await adminClient.updatePerpAuctionDuration(new BN(0));
	await adminClient.updatePerpMarketCurveUpdateIntensity(0, 100);

	// adminClient.subscribe() ran before these spot/perp markets existed, so its
	// oracle maps weren't built for them. They're only repopulated lazily by
	// background polling, so a later adminClient.getOracleDataForPerpMarket(0)
	// races that poll and intermittently throws "No oracle price data for perp
	// market 0" in CI. Rebuild the maps now (awaited) to make setup deterministic.
	await adminClient.accountSubscriber.setPerpOracleMap();
	await adminClient.accountSubscriber.setSpotOracleMap();

	await adminClient.fetchAccounts();

	return {
		bankrunContextWrapper,
		bulkAccountLoader,
		adminClient,
		program,
		usdcMint,
		solPerpOracle,
		metaplex,
		oracleInfos,
	};
}

describe('velocityVaults', () => {
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;
	let connection: ReturnType<
		BankrunContextWrapper['connection']['toConnection']
	>;
	let adminClient: AdminClient;
	let program: Program<Vaults>;
	let usdcMint: Keypair;

	let _manager: Keypair;
	let managerClient: VaultClient;
	let managerUser: User;

	let vd2: Keypair;
	let vd2Client: VaultClient;
	let vd2UserUSDCAccount: PublicKey;

	let _delegate: Keypair;
	let delegateClient: VaultClient;

	let vault: PublicKey;
	const vaultName = 'crisp vault';

	const usdcAmount = new BN(1_000).mul(QUOTE_PRECISION);

	before(async () => {
		const bootstrap = await bootstrapBankrun();
		bankrunContextWrapper = bootstrap.bankrunContextWrapper;
		bulkAccountLoader = bootstrap.bulkAccountLoader;
		connection = bankrunContextWrapper.connection.toConnection();
		adminClient = bootstrap.adminClient;
		program = bootstrap.program;
		usdcMint = bootstrap.usdcMint;
		const oracleInfos = bootstrap.oracleInfos;

		vault = getVaultAddressSync(program.programId, encodeName(vaultName));

		const velocityClientConfig = {
			accountSubscription: {
				type: 'polling' as const,
				accountLoader: bulkAccountLoader as BulkAccountLoader,
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes,
			spotMarketIndexes,
			oracleInfos,
		};

		// init vault manager
		const bootstrapManager = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			velocityClientConfig,
		});
		_manager = bootstrapManager.signer;
		managerClient = bootstrapManager.vaultClient;
		managerUser = bootstrapManager.user;

		// init delegate who trades with vault funds
		const bootstrapDelegate = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			skipUser: true,
			velocityClientConfig,
		});
		_delegate = bootstrapDelegate.signer;
		delegateClient = bootstrapDelegate.vaultClient;

		// the VaultDepositor for the vault
		const bootstrapVD2 = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			skipUser: true,
			depositCollateral: false,
			velocityClientConfig,
		});
		vd2 = bootstrapVD2.signer;
		vd2Client = bootstrapVD2.vaultClient;
		vd2UserUSDCAccount = bootstrapVD2.userUSDCAccount.publicKey;

		await bulkAccountLoader.load();
	});

	after(async () => {
		await adminClient.unsubscribe();

		await managerClient.velocityClient.unsubscribe();
		await vd2Client.velocityClient.unsubscribe();
		await delegateClient.velocityClient.unsubscribe();

		await managerUser.unsubscribe();

		await managerClient.unsubscribe();
		await vd2Client.unsubscribe();
		await delegateClient.unsubscribe();
	});

	//
	// Legacy vault tests
	//

	it('Initialize Vault', async () => {
		const beforeStateAccount = adminClient.getStateAccount();
		await managerClient.initializeVault(
			{
				name: encodeName(vaultName),
				spotMarketIndex: 0,
				redeemPeriod: ZERO,
				maxTokens: ZERO,
				managementFee: ZERO,
				profitShare: 0,
				hurdleRate: 0,
				permissioned: false,
				minDepositAmount: ZERO,
			},
			{ noLut: true }
		);
		await adminClient.fetchAccounts();
		const afterStateAccount = adminClient.getStateAccount();

		assert(
			afterStateAccount.numberOfAuthorities
				.sub(beforeStateAccount.numberOfAuthorities)
				.eq(new BN(1))
		);
		assert(
			afterStateAccount.numberOfSubAccounts
				.sub(beforeStateAccount.numberOfSubAccounts)
				.eq(new BN(1))
		);
	});

	it('Initialize Vault Depositor', async () => {
		await vd2Client.initializeVaultDepositor(vault, vd2.publicKey, undefined, {
			noLut: true,
		});
	});

	it('Deposit', async () => {
		const vaultAccount = await program.account.vault.fetch(vault);
		const vaultDepositor = getVaultDepositorAddressSync(
			program.programId,
			vault,
			vd2.publicKey
		);
		const remainingAccounts = vd2Client.velocityClient.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [0],
		});

		await vd2Client.program.methods
			// @ts-ignore
			.deposit(usdcAmount)
			.accounts({
				userTokenAccount: vd2UserUSDCAccount,
				vault,
				vaultDepositor,
				vaultTokenAccount: vaultAccount.tokenAccount,
				velocityUser: vaultAccount.user,
				velocityUserStats: vaultAccount.userStats,
				velocityState: await adminClient.getStatePublicKey(),
				velocitySpotMarketVault: adminClient.getSpotMarketAccount(0).vault,
				velocityProgram: adminClient.program.programId,
			})
			.remainingAccounts(remainingAccounts)
			.rpc();

		const vd = await program.account.vaultDepositor.fetch(vaultDepositor);
		assert(vd.totalDeposits.eq(usdcAmount));
	});

	it('Withdraw', async () => {
		const vaultAccount = await program.account.vault.fetch(vault);
		const vaultDepositor = getVaultDepositorAddressSync(
			program.programId,
			vault,
			vd2.publicKey
		);
		const remainingAccounts = vd2Client.velocityClient.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [0],
		});

		const vaultDepositorAccount = await program.account.vaultDepositor.fetch(
			vaultDepositor
		);
		assert(vaultDepositorAccount.lastWithdrawRequest.value.eq(new BN(0)));
		console.log(
			'vaultDepositorAccount.vaultShares:',
			vaultDepositorAccount.vaultShares.toString()
		);
		assert(vaultDepositorAccount.vaultShares.eq(new BN(1_000_000_000)));

		// request withdraw
		console.log('request withdraw');
		await vd2Client.program.methods
			// @ts-ignore
			.requestWithdraw(usdcAmount, WithdrawUnit.TOKEN)
			.accounts({
				vault,
				vaultDepositor,
				velocityUser: vaultAccount.user,
				velocityUserStats: vaultAccount.userStats,
			})
			.remainingAccounts(remainingAccounts)
			.rpc();

		const vaultDepositorAccountAfter =
			await program.account.vaultDepositor.fetch(vaultDepositor);
		assert(vaultDepositorAccountAfter.vaultShares.eq(new BN(1_000_000_000)));
		console.log(
			'vaultDepositorAccountAfter.lastWithdrawRequestShares:',
			vaultDepositorAccountAfter.lastWithdrawRequest.shares.toString()
		);
		assert(
			!vaultDepositorAccountAfter.lastWithdrawRequest.shares.eq(new BN(0))
		);
		assert(!vaultDepositorAccountAfter.lastWithdrawRequest.value.eq(new BN(0)));

		// do withdraw
		console.log('do withdraw');
		try {
			const txSig = await vd2Client.program.methods
				.withdraw()
				.accounts({
					userTokenAccount: vd2UserUSDCAccount,
					vault,
					vaultDepositor,
					vaultTokenAccount: vaultAccount.tokenAccount,
					velocityUser: vaultAccount.user,
					velocityUserStats: vaultAccount.userStats,
					velocityState: await adminClient.getStatePublicKey(),
					velocitySpotMarketVault: adminClient.getSpotMarketAccount(0).vault,
					velocitySigner: adminClient.getStateAccount().signer,
					velocityProgram: adminClient.program.programId,
				})
				.remainingAccounts(remainingAccounts)
				.rpc();

			// @ts-ignore
			await printTxLogs(connection, txSig, false, program);
		} catch (e) {
			console.error(e);
			assert(false);
		}
	});

	it('Update Delegate', async () => {
		const vaultAccount = await program.account.vault.fetch(vault);
		const delegateKeyPair = Keypair.generate();
		const txSig = await managerClient.program.methods
			.updateDelegate(delegateKeyPair.publicKey)
			.accounts({
				vault,
				velocityUser: vaultAccount.user,
				velocityProgram: adminClient.program.programId,
			})
			.rpc();

		const user = (await adminClient.program.account.user.fetch(
			vaultAccount.user
		)) as UserAccount;
		assert(user.delegate.equals(delegateKeyPair.publicKey));

		// @ts-ignore
		await printTxLogs(connection, txSig, false, program);
	});
});

describe('TestProtocolVaults', () => {
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;
	let connection: ReturnType<
		BankrunContextWrapper['connection']['toConnection']
	>;
	let adminClient: AdminClient;
	let program: Program<Vaults>;
	let usdcMint: Keypair;

	let manager: Keypair;
	let managerClient: VaultClient;
	let managerUser: User;

	let fillerClient: VaultClient;
	let fillerUser: User;

	let vd: Keypair;
	let vdClient: VaultClient;
	let vdUserUSDCAccount: PublicKey;

	let vd2Client: VaultClient;

	let delegate: Keypair;
	let delegateClient: VaultClient;

	let protocol: Keypair;
	let protocolClient: VaultClient;
	let protocolVdUserUSDCAccount: PublicKey;

	let protocolVault: PublicKey;
	const protocolVaultName = 'protocol vault';
	let solPerpOracle: PublicKey;

	const VAULT_PROTOCOL_DISCRIM: number[] = [106, 130, 5, 195, 126, 82, 249, 53];

	const initialSolPerpPrice = 100;
	const finalSolPerpPrice = initialSolPerpPrice + 10;
	const usdcAmount = new BN(1_000).mul(QUOTE_PRECISION);
	const baseAssetAmount = new BN(1).mul(BASE_PRECISION);

	before(async () => {
		const bootstrap = await bootstrapBankrun();
		bankrunContextWrapper = bootstrap.bankrunContextWrapper;
		bulkAccountLoader = bootstrap.bulkAccountLoader;
		connection = bankrunContextWrapper.connection.toConnection();
		adminClient = bootstrap.adminClient;
		program = bootstrap.program;
		usdcMint = bootstrap.usdcMint;
		solPerpOracle = bootstrap.solPerpOracle;
		const oracleInfos = bootstrap.oracleInfos;

		protocolVault = getVaultAddressSync(
			program.programId,
			encodeName(protocolVaultName)
		);

		const velocityClientConfig = {
			accountSubscription: {
				type: 'polling' as const,
				accountLoader: bulkAccountLoader as BulkAccountLoader,
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes,
			spotMarketIndexes,
			oracleInfos,
		};

		// init vault manager
		const bootstrapManager = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			velocityClientConfig,
		});
		manager = bootstrapManager.signer;
		managerClient = bootstrapManager.vaultClient;
		managerUser = bootstrapManager.user;

		// init delegate who trades with vault funds
		const bootstrapDelegate = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			skipUser: true,
			velocityClientConfig,
		});
		delegate = bootstrapDelegate.signer;
		delegateClient = bootstrapDelegate.vaultClient;

		// init a market filler for manager to trade against
		const bootstrapFiller = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			depositCollateral: true,
			velocityClientConfig,
		});
		fillerClient = bootstrapFiller.vaultClient;
		fillerUser = bootstrapFiller.user;

		// the VaultDepositor for the protocol vault
		const bootstrapVD = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			depositCollateral: false,
			velocityClientConfig,
		});
		vd = bootstrapVD.signer;
		vdClient = bootstrapVD.vaultClient;
		vdUserUSDCAccount = bootstrapVD.userUSDCAccount.publicKey;

		// the VaultDepositor for the vault
		const bootstrapVD2 = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			skipUser: true,
			depositCollateral: false,
			velocityClientConfig,
		});
		vd2Client = bootstrapVD2.vaultClient;

		// init protocol
		const bootstrapProtocol = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			skipUser: true,
			velocityClientConfig,
		});
		protocol = bootstrapProtocol.signer;
		protocolClient = bootstrapProtocol.vaultClient;
		protocolVdUserUSDCAccount = bootstrapProtocol.userUSDCAccount.publicKey;

		await bulkAccountLoader.load();
	});

	after(async () => {
		await adminClient.unsubscribe();

		await managerClient.velocityClient.unsubscribe();
		await fillerClient.velocityClient.unsubscribe();
		await vdClient.velocityClient.unsubscribe();
		await vd2Client.velocityClient.unsubscribe();
		await delegateClient.velocityClient.unsubscribe();
		await protocolClient.velocityClient.unsubscribe();

		await managerUser.unsubscribe();

		await managerClient.unsubscribe();
		await vd2Client.unsubscribe();
		await delegateClient.unsubscribe();
	});

	//
	// Protocol vault tests
	//

	it('Initialize Protocol Vault', async () => {
		const vpParams: VaultProtocolParams = {
			protocol: protocol.publicKey,
			protocolFee: new BN(0),
			// 100_000 = 10%
			protocolProfitShare: 100_000,
		};
		await managerClient.initializeVault(
			{
				name: encodeName(protocolVaultName),
				spotMarketIndex: 0,
				redeemPeriod: ZERO,
				maxTokens: ZERO,
				managementFee: ZERO,
				profitShare: 0,
				hurdleRate: 0,
				permissioned: false,
				minDepositAmount: ZERO,
				vaultProtocol: vpParams,
			},
			{ noLut: true }
		);
		const vaultAcct = await program.account.vault.fetch(protocolVault);
		assert(vaultAcct.manager.equals(manager.publicKey));
		const vp = getVaultProtocolAddressSync(
			managerClient.program.programId,
			protocolVault
		);
		// asserts "exit" was called on VaultProtocol to define the discriminator
		const vpAcctInfo = await connection.getAccountInfo(vp);
		assert(vpAcctInfo.data.includes(Buffer.from(VAULT_PROTOCOL_DISCRIM)));

		// asserts Vault and VaultProtocol fields were set properly
		const vpAcct = await program.account.vaultProtocol.fetch(vp);
		assert(vaultAcct.vaultProtocol);
		assert(vpAcct.protocol.equals(protocol.publicKey));
	});

	// assign "delegate" to trade on behalf of the vault
	it('Update Protocol Vault Delegate', async () => {
		const vaultAccount = await program.account.vault.fetch(protocolVault);
		await managerClient.program.methods
			.updateDelegate(delegate.publicKey)
			.accounts({
				vault: protocolVault,
				velocityUser: vaultAccount.user,
				velocityProgram: adminClient.program.programId,
			})
			.rpc();
		const user = (await adminClient.program.account.user.fetch(
			vaultAccount.user
		)) as UserAccount;
		assert(user.delegate.equals(delegate.publicKey));
	});

	it('Initialize Vault Depositor', async () => {
		await vdClient.initializeVaultDepositor(
			protocolVault,
			vd.publicKey,
			undefined,
			{
				noLut: true,
			}
		);
		const vaultDepositor = getVaultDepositorAddressSync(
			program.programId,
			protocolVault,
			vd.publicKey
		);
		const vdAcct = await program.account.vaultDepositor.fetch(vaultDepositor);
		assert(vdAcct.vault.equals(protocolVault));
	});

	// vault depositor deposits USDC to the vault
	it('Vault Depositor Deposit', async () => {
		const vaultAccount = await program.account.vault.fetch(protocolVault);
		const vaultDepositor = getVaultDepositorAddressSync(
			program.programId,
			protocolVault,
			vd.publicKey
		);
		const remainingAccounts = vdClient.velocityClient.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [0],
		});
		if (vaultAccount.vaultProtocol) {
			const vaultProtocol = getVaultProtocolAddressSync(
				managerClient.program.programId,
				protocolVault
			);
			remainingAccounts.push({
				pubkey: vaultProtocol,
				isSigner: false,
				isWritable: true,
			});
		}

		await vdClient.program.methods
			// @ts-ignore
			.deposit(usdcAmount)
			.accounts({
				vault: protocolVault,
				vaultDepositor,
				vaultTokenAccount: vaultAccount.tokenAccount,
				velocityUserStats: vaultAccount.userStats,
				velocityUser: vaultAccount.user,
				velocityState: await adminClient.getStatePublicKey(),
				userTokenAccount: vdUserUSDCAccount,
				velocitySpotMarketVault: adminClient.getSpotMarketAccount(0).vault,
				velocityProgram: adminClient.program.programId,
			})
			.remainingAccounts(remainingAccounts)
			.rpc();
	});

	// vault enters long
	it('Long SOL-PERP', async () => {
		// vault user account is delegated to "delegate". On bankrun we cannot
		// use getUserAccountsForDelegate (getProgramAccounts) — fetch the known
		// vault user PDA directly instead.
		const vaultUserKey = await getUserAccountPublicKey(
			delegateClient.velocityClient.program.programId,
			protocolVault,
			0
		);
		const vaultUserAcct =
			(await delegateClient.velocityClient.program.account.user.fetch(
				vaultUserKey
			)) as unknown as UserAccount;
		assert(vaultUserAcct.authority.equals(protocolVault));
		assert(vaultUserAcct.delegate.equals(delegate.publicKey));

		assert(vaultUserAcct.totalDeposits.eq(usdcAmount));
		const balance =
			vaultUserAcct.totalDeposits.toNumber() / QUOTE_PRECISION.toNumber();
		console.log('vault usdc balance:', balance);

		const marketIndex = 0;

		// delegate assumes control of vault user
		await delegateClient.velocityClient.addUser(
			0,
			protocolVault,
			vaultUserAcct
		);
		await delegateClient.velocityClient.switchActiveUser(0, protocolVault);
		console.log('delegate assumed control of protocol vault user');

		const delegateActiveUser = delegateClient.velocityClient.getUser(
			0,
			protocolVault
		);
		assert(
			delegateActiveUser.userAccountPublicKey.equals(vaultUserKey),
			'delegate active user is not vault user'
		);

		const fillerUser = fillerClient.velocityClient.getUser();

		try {
			// manager places long order and waits to be filler by the filler
			const takerOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				price: new BN((initialSolPerpPrice - 1) * PRICE_PRECISION.toNumber()),
				auctionStartPrice: new BN(
					initialSolPerpPrice * PRICE_PRECISION.toNumber()
				),
				auctionEndPrice: new BN(
					(initialSolPerpPrice - 1) * PRICE_PRECISION.toNumber()
				),
				auctionDuration: 10,
				userOrderId: 1,
				postOnly: PostOnlyParams.NONE,
			});
			await fillerClient.velocityClient.placePerpOrder(takerOrderParams);
		} catch (e) {
			console.log('filler failed to short:', e);
		}
		await fillerUser.fetchAccounts();
		const order = fillerUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		try {
			// vault trades against filler's long
			const makerOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				price: new BN(initialSolPerpPrice).mul(PRICE_PRECISION),
				userOrderId: 1,
				postOnly: PostOnlyParams.MUST_POST_ONLY,
				bitFlags: OrderParamsBitFlag.ImmediateOrCancel,
			});
			const orderParams = getOrderParams(makerOrderParams, {
				marketType: MarketType.PERP,
			});
			const userStatsPublicKey =
				delegateClient.velocityClient.getUserStatsAccountPublicKey();

			const remainingAccounts =
				delegateClient.velocityClient.getRemainingAccounts({
					userAccounts: [
						delegateActiveUser.getUserAccount(),
						fillerUser.getUserAccount(),
					],
					useMarketLastSlotCache: true,
					writablePerpMarketIndexes: [orderParams.marketIndex],
				});

			const takerOrderId = order.orderId;
			const placeAndMakeOrderIx =
				await delegateClient.velocityClient.program.methods
					.placeAndMakePerpOrder(orderParams, takerOrderId)
					.accounts({
						state: await delegateClient.velocityClient.getStatePublicKey(),
						user: delegateActiveUser.userAccountPublicKey,
						userStats: userStatsPublicKey,
						taker: fillerUser.userAccountPublicKey,
						takerStats:
							fillerClient.velocityClient.getUserStatsAccountPublicKey(),
						authority: delegateClient.velocityClient.wallet.publicKey,
					})
					.remainingAccounts(remainingAccounts)
					.instruction();

			const { slot } = await delegateClient.velocityClient.sendTransaction(
				await delegateClient.velocityClient.buildTransaction(
					placeAndMakeOrderIx,
					delegateClient.velocityClient.txParams
				),
				[],
				delegateClient.velocityClient.opts
			);

			delegateClient.velocityClient.perpMarketLastSlotCache.set(
				orderParams.marketIndex,
				slot
			);
		} catch (e) {
			console.log('vault failed to long:', e);
		}

		// check positions from vault and filler are accurate
		await fillerUser.fetchAccounts();
		const fillerPosition = fillerUser.getPerpPosition(0);
		assert(
			fillerPosition.baseAssetAmount.eq(baseAssetAmount.neg()),
			'filler position is not baseAssetAmount'
		);
		await delegateActiveUser.fetchAccounts();
		const vaultPosition = delegateActiveUser.getPerpPosition(0);
		assert(
			vaultPosition.baseAssetAmount.eq(baseAssetAmount),
			'vault position is not baseAssetAmount'
		);
	});

	// increase price of SOL perp by 5%
	it('Increase SOL-PERP Price', async () => {
		const preOD = adminClient.getOracleDataForPerpMarket(0);
		const priceBefore = preOD.price.toNumber() / PRICE_PRECISION.toNumber();
		console.log('price before:', priceBefore);
		assert(priceBefore === initialSolPerpPrice);

		try {
			// increase AMM
			await adminClient.moveAmmToPrice(
				0,
				new BN(finalSolPerpPrice * PRICE_PRECISION.toNumber())
			);
		} catch (e) {
			console.error('failed to move amm price:', e);
			assert(false, 'failed to move amm price');
		}

		try {
			// increase oracle
			await setFeedPrice(
				bankrunContextWrapper,
				finalSolPerpPrice,
				solPerpOracle
			);
		} catch (e) {
			console.error('failed to set feed price:', e);
			assert(false, 'failed to set feed price');
		}

		// Refresh the polling oracle cache so the new price is observed. A single
		// fetchAccounts() can return an already-in-flight BulkAccountLoader load
		// that was issued before the oracle write landed, so force a fresh load
		// twice to guarantee the new price is read.
		await adminClient.fetchAccounts();
		await adminClient.fetchAccounts();

		const postOD = adminClient.getOracleDataForPerpMarket(0);
		const priceAfter = postOD.price.toNumber() / PRICE_PRECISION.toNumber();
		const diff = Math.abs(priceAfter - finalSolPerpPrice);
		expect(diff).to.be.lessThan(0.00001);
	});

	// vault exits long for a profit
	it('Short SOL-PERP', async () => {
		const marketIndex = 0;

		const delegateActiveUser = delegateClient.velocityClient.getUser(
			0,
			protocolVault
		);
		const fillerUser = fillerClient.velocityClient.getUser();

		try {
			// manager places long order and waits to be filler by the filler
			const takerOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				price: new BN((finalSolPerpPrice + 1) * PRICE_PRECISION.toNumber()),
				auctionStartPrice: new BN(
					finalSolPerpPrice * PRICE_PRECISION.toNumber()
				),
				auctionEndPrice: new BN(
					(finalSolPerpPrice + 1) * PRICE_PRECISION.toNumber()
				),
				auctionDuration: 10,
				userOrderId: 1,
				postOnly: PostOnlyParams.NONE,
			});
			await fillerClient.velocityClient.placePerpOrder(takerOrderParams);
		} catch (e) {
			console.log('filler failed to long:', e);
		}
		await fillerUser.fetchAccounts();
		const order = fillerUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		try {
			// vault trades against filler's long
			const makerOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				price: new BN(finalSolPerpPrice).mul(PRICE_PRECISION),
				userOrderId: 1,
				postOnly: PostOnlyParams.MUST_POST_ONLY,
				bitFlags: OrderParamsBitFlag.ImmediateOrCancel,
			});
			const orderParams = getOrderParams(makerOrderParams, {
				marketType: MarketType.PERP,
			});
			const userStatsPublicKey =
				delegateClient.velocityClient.getUserStatsAccountPublicKey();

			const remainingAccounts =
				delegateClient.velocityClient.getRemainingAccounts({
					userAccounts: [
						delegateActiveUser.getUserAccount(),
						fillerUser.getUserAccount(),
					],
					useMarketLastSlotCache: true,
					writablePerpMarketIndexes: [orderParams.marketIndex],
				});

			const takerOrderId = order.orderId;
			const placeAndMakeOrderIx =
				await delegateClient.velocityClient.program.methods
					.placeAndMakePerpOrder(orderParams, takerOrderId)
					.accounts({
						state: await delegateClient.velocityClient.getStatePublicKey(),
						user: delegateActiveUser.userAccountPublicKey,
						userStats: userStatsPublicKey,
						taker: fillerUser.userAccountPublicKey,
						takerStats:
							fillerClient.velocityClient.getUserStatsAccountPublicKey(),
						authority: delegateClient.velocityClient.wallet.publicKey,
					})
					.remainingAccounts(remainingAccounts)
					.instruction();

			const { slot } = await delegateClient.velocityClient.sendTransaction(
				await delegateClient.velocityClient.buildTransaction(
					placeAndMakeOrderIx,
					delegateClient.velocityClient.txParams
				),
				[],
				delegateClient.velocityClient.opts
			);

			delegateClient.velocityClient.perpMarketLastSlotCache.set(
				orderParams.marketIndex,
				slot
			);
		} catch (e) {
			console.log('vault failed to short:', e);
		}

		// check positions from vault and filler are accurate
		await fillerUser.fetchAccounts();
		const fillerPosition = fillerUser.getPerpPosition(0);
		assert(fillerPosition.baseAssetAmount.eq(ZERO));
		await delegateActiveUser.fetchAccounts();
		const vaultPosition = delegateActiveUser.getPerpPosition(0);
		assert(vaultPosition.baseAssetAmount.eq(ZERO));
	});

	it('Settle Pnl', async () => {
		const vaultUser = delegateClient.velocityClient.getUser(0, protocolVault);
		const uA = vaultUser.getUserAccount();
		assert(uA.idle === false);
		const solPerpPos = vaultUser.getPerpPosition(0);
		const solPerpQuote =
			solPerpPos.quoteAssetAmount.toNumber() / QUOTE_PRECISION.toNumber();
		console.log('sol perp quote:', solPerpQuote);
		console.log(
			'sol perp base:',
			solPerpPos.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber()
		);
		assert(solPerpPos.baseAssetAmount.eq(ZERO));
		console.log(
			'free collateral:',
			vaultUser.getFreeCollateral().toNumber() / QUOTE_PRECISION.toNumber()
		);
		assert(usdcAmount.eq(vaultUser.getFreeCollateral()));

		const solPrice =
			delegateClient.velocityClient.getOracleDataForPerpMarket(0);
		console.log(
			'SOL price:',
			solPrice.price.toNumber() / PRICE_PRECISION.toNumber()
		);
		assert(
			finalSolPerpPrice ===
				solPrice.price.toNumber() / PRICE_PRECISION.toNumber()
		);

		const solPerpMarket = delegateClient.velocityClient.getPerpMarketAccount(0);
		const pnl =
			calculatePositionPNL(
				solPerpMarket,
				solPerpPos,
				false,
				solPrice
			).toNumber() / QUOTE_PRECISION.toNumber();

		const upnl =
			vaultUser.getUnrealizedPNL().toNumber() / QUOTE_PRECISION.toNumber();
		console.log('upnl:', upnl.toString());
		assert(pnl === upnl);
		assert(
			solPerpPos.quoteAssetAmount.toNumber() / QUOTE_PRECISION.toNumber() ==
				upnl
		);
		assert(solPerpQuote === pnl);

		await fillerUser.fetchAccounts();
		await vaultUser.fetchAccounts();
		await delegateClient.velocityClient.fetchAccounts();

		try {
			// settle_pnl requires the AMM to have been updated in the same slot
			// (AMMNotUpdatedInSameSlot guard). On bankrun every transaction
			// advances the clock by exactly one slot, so calling updateAMMs in a
			// separate tx would leave the AMM stale by the time settle runs.
			// Instead prepend the AMM-update ix into the SAME transaction as each
			// settle so both execute in one slot.
			const dc = delegateClient.velocityClient;
			const updateAmmIx = await dc.getUpdateAMMsIx([0]);

			// settle market maker who lost trade and pays taker fees
			const fillerSettleIx = await dc.settlePNLIx(
				fillerUser.userAccountPublicKey,
				fillerUser.getUserAccount(),
				0
			);
			await dc.sendTransaction(
				await dc.buildTransaction([updateAmmIx, fillerSettleIx], dc.txParams),
				[],
				dc.opts
			);

			// then settle vault who won trade and earns maker fees
			const updateAmmIx2 = await dc.getUpdateAMMsIx([0]);
			const vaultSettleIx = await dc.settlePNLIx(
				vaultUser.userAccountPublicKey,
				vaultUser.getUserAccount(),
				0
			);
			await dc.sendTransaction(
				await dc.buildTransaction([updateAmmIx2, vaultSettleIx], dc.txParams),
				[],
				dc.opts
			);
		} catch (e) {
			console.log('failed to settle pnl:', e);
			assert(false);
		}

		// vault user account is delegated to "delegate"
		await delegateClient.velocityClient.fetchAccounts();
		const vaultUserAcct = delegateClient.velocityClient
			.getUser(0, protocolVault)
			.getUserAccount();
		const settledPnl =
			vaultUserAcct.settledPerpPnl.toNumber() / QUOTE_PRECISION.toNumber();
		console.log('vault settled pnl:', settledPnl);
		const gotPnl = Math.abs(settledPnl - pnl);
		const expectPnl = 0.00001;
		assert(gotPnl < expectPnl, `Got ${gotPnl}, want: ${expectPnl}`);
	});

	// Asserts profit-share numbers produced by the SOL-PERP round trip above.
	it('Withdraw', async () => {
		const vaultDepositor = getVaultDepositorAddressSync(
			program.programId,
			protocolVault,
			vd.publicKey
		);

		const vaultAccount = await program.account.vault.fetch(protocolVault);
		const vaultDepositorAccount = await program.account.vaultDepositor.fetch(
			vaultDepositor
		);

		const remainingAccounts = vdClient.velocityClient.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [0],
		});
		if (vaultAccount.vaultProtocol) {
			const vaultProtocol = vdClient.getVaultProtocolAddress(
				vaultDepositorAccount.vault
			);
			remainingAccounts.push({
				pubkey: vaultProtocol,
				isSigner: false,
				isWritable: true,
			});
		}

		// On bankrun the vault's velocity user is subscribed over a websocket that
		// never receives updates, so its cached equity is stale after the perp
		// round trip. Force a one-time fetch of the known vault user before
		// computing equity.
		const vdVaultUser = await vdClient.getSubscribedVaultUser(
			vaultAccount.user
		);
		await vdVaultUser.fetchAccounts();

		const withdrawAmount =
			await vdClient.calculateWithdrawableVaultDepositorEquityInDepositAsset({
				vaultDepositor: vaultDepositorAccount,
				vault: vaultAccount,
			});
		console.log(
			'withdraw amount:',
			withdrawAmount.toNumber() / QUOTE_PRECISION.toNumber()
		);
		// $1000 deposit + (~$10.04 in profit - 10% profit share = ~$9.04). The
		// exact figure depends on velocity's fee/funding schedule, which differs
		// slightly from upstream velocity, so assert the magnitude with a tolerance
		// rather than the upstream-specific constant.
		expect(
			withdrawAmount.toNumber() / QUOTE_PRECISION.toNumber()
		).to.be.closeTo(1009.04, 0.01);

		try {
			await vdClient.program.methods
				// @ts-ignore
				.requestWithdraw(withdrawAmount, WithdrawUnit.TOKEN)
				.accounts({
					vault: protocolVault,
					vaultDepositor,
					velocityUserStats: vaultAccount.userStats,
					velocityUser: vaultAccount.user,
				})
				.remainingAccounts(remainingAccounts)
				.rpc();
		} catch (e) {
			console.log('failed to request withdraw:', e);
			assert(false);
		}

		const vaultDepositorAccountAfter =
			await program.account.vaultDepositor.fetch(vaultDepositor);
		console.log(
			'withdraw shares:',
			vaultDepositorAccountAfter.lastWithdrawRequest.shares.toNumber()
		);
		console.log(
			'withdraw value:',
			vaultDepositorAccountAfter.lastWithdrawRequest.value.toNumber()
		);
		expect(
			vaultDepositorAccountAfter.lastWithdrawRequest.shares.toNumber()
		).to.be.closeTo(999_005_866, 100_000);
		expect(
			vaultDepositorAccountAfter.lastWithdrawRequest.value.toNumber()
		).to.be.closeTo(1_009_037_051, 100_000);

		const vdAcct = await program.account.vaultDepositor.fetch(vaultDepositor);
		assert(vdAcct.vault.equals(protocolVault));

		try {
			const vaultAccount = await program.account.vault.fetch(protocolVault);

			await vdClient.program.methods
				.withdraw()
				.accounts({
					userTokenAccount: vdUserUSDCAccount,
					vault: protocolVault,
					vaultDepositor,
					vaultTokenAccount: vaultAccount.tokenAccount,
					velocityUser: vaultAccount.user,
					velocityUserStats: vaultAccount.userStats,
					velocityState: await adminClient.getStatePublicKey(),
					velocitySpotMarketVault: adminClient.getSpotMarketAccount(0).vault,
					velocitySigner: adminClient.getStateAccount().signer,
					velocityProgram: adminClient.program.programId,
				})
				.remainingAccounts(remainingAccounts)
				.rpc();
		} catch (e) {
			console.log('failed to withdraw:', e);
			assert(false);
		}

		const vpAcctAfterWithdraw = await program.account.vaultProtocol.fetch(
			getVaultProtocolAddressSync(
				managerClient.program.programId,
				protocolVault
			)
		);
		const vpSharesAfterWithdraw =
			vpAcctAfterWithdraw.protocolProfitAndFeeShares;
		console.log(
			'vault protocol shares after withdraw request:',
			vpSharesAfterWithdraw.toNumber()
		);
		expect(vpSharesAfterWithdraw.toNumber()).to.be.closeTo(994_133, 5_000);
	});

	it('Protocol Withdraw Profit Share', async () => {
		const vaultAccount = await program.account.vault.fetch(protocolVault);

		const remainingAccounts =
			protocolClient.velocityClient.getRemainingAccounts({
				userAccounts: [],
				writableSpotMarketIndexes: [0],
			});
		const vaultProtocol = getVaultProtocolAddressSync(
			program.programId,
			protocolVault
		);
		if (vaultAccount.vaultProtocol) {
			remainingAccounts.push({
				pubkey: vaultProtocol,
				isSigner: false,
				isWritable: true,
			});
		}

		// Refresh the (websocket-subscribed) vault velocity user so equity reflects
		// the perp profit; see the Withdraw test above for the rationale.
		const protoVaultUser = await protocolClient.getSubscribedVaultUser(
			vaultAccount.user
		);
		await protoVaultUser.fetchAccounts();

		const withdrawAmount = await protocolClient.calculateVaultProtocolEquity({
			vault: protocolVault,
		});
		console.log(
			'protocol withdraw profit share:',
			withdrawAmount.toNumber() / QUOTE_PRECISION.toNumber()
		);
		// 10% of protocolVault depositor's ~$10.04 profit. Tolerance for
		// velocity's slightly different fee/funding economics vs upstream velocity.
		expect(
			withdrawAmount.toNumber() / QUOTE_PRECISION.toNumber()
		).to.be.closeTo(1.004114, 0.001);

		const totalVaultSharesBefore = vaultAccount.totalShares;
		console.log(
			'total vault shares before protocol withdraw:',
			totalVaultSharesBefore.toNumber()
		);
		expect(totalVaultSharesBefore.toNumber()).to.be.closeTo(994_134, 5_000);

		try {
			await protocolClient.program.methods
				// @ts-ignore
				.protocolRequestWithdraw(withdrawAmount, WithdrawUnit.TOKEN)
				.accounts({
					vault: protocolVault,
					vaultProtocol,
					velocityUser: vaultAccount.user,
					velocityUserStats: vaultAccount.userStats,
				})
				.remainingAccounts(remainingAccounts)
				.rpc();
		} catch (e) {
			console.log('failed to request withdraw:', e);
			assert(false);
		}

		const vpAccountAfterRequest = await program.account.vaultProtocol.fetch(
			vaultProtocol
		);
		console.log(
			'protocol withdraw shares:',
			vpAccountAfterRequest.lastProtocolWithdrawRequest.shares.toNumber()
		);
		expect(
			vpAccountAfterRequest.lastProtocolWithdrawRequest.shares.toNumber()
		).to.be.closeTo(994_132, 5_000);
		expect(
			vpAccountAfterRequest.lastProtocolWithdrawRequest.value.toNumber()
		).to.be.closeTo(1_004_114, 5_000);

		try {
			const vaultAccount = await program.account.vault.fetch(protocolVault);

			await protocolClient.program.methods
				.protocolWithdraw()
				.accounts({
					userTokenAccount: protocolVdUserUSDCAccount,
					vault: protocolVault,
					vaultProtocol,
					vaultTokenAccount: vaultAccount.tokenAccount,
					velocityUser: vaultAccount.user,
					velocityUserStats: vaultAccount.userStats,
					velocityState: await adminClient.getStatePublicKey(),
					velocitySpotMarketVault: adminClient.getSpotMarketAccount(0).vault,
					velocitySigner: adminClient.getStateAccount().signer,
					velocityProgram: adminClient.program.programId,
				})
				.remainingAccounts(remainingAccounts)
				.rpc();
		} catch (e) {
			console.log('failed to withdraw:', e);
			assert(false);
		}

		const vpAcctAfterWithdraw = await program.account.vaultProtocol.fetch(
			vaultProtocol
		);
		const vpSharesAfterWithdraw =
			vpAcctAfterWithdraw.protocolProfitAndFeeShares;
		console.log(
			'vault protocol shares after withdraw:',
			vpSharesAfterWithdraw.toNumber()
		);
		// f64 to u64 conversion rounds down to not withdraw more equity than available,
		// so 1 share is left behind.
		// this is the "slight round of out favor" mentioned in the Rust tests by bigz
		assert(vpSharesAfterWithdraw.eq(new BN(1)));

		const vaultAccountAfter = await program.account.vault.fetch(protocolVault);
		const totalVaultShareAfter = vaultAccountAfter.totalShares;
		console.log(
			'user shares after withdraw:',
			vaultAccountAfter.userShares.toNumber()
		);
		console.log(
			'total vault shares after protocol withdraw:',
			totalVaultShareAfter.toNumber()
		);
		assert(vaultAccountAfter.userShares.eq(new BN(1)));
		const totalSharesAfterProtocolWithdraw = totalVaultSharesBefore.sub(
			vpAccountAfterRequest.lastProtocolWithdrawRequest.shares
		);
		assert(totalSharesAfterProtocolWithdraw.eq(new BN(2)));
	});
});

describe('TestTokenizedVaults', () => {
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;
	let connection: ReturnType<
		BankrunContextWrapper['connection']['toConnection']
	>;
	let adminClient: AdminClient;
	let program: Program<Vaults>;
	let usdcMint: Keypair;
	let metaplex: Metaplex;
	let oracleInfos: OracleInfo[];

	let managerClient: VaultClient;
	let managerVelocityClient: VelocityClient;

	let vd0Client: VaultClient;
	let vd0VelocityClient: VelocityClient;

	let vd1Client: VaultClient;
	let vd1VelocityClient: VelocityClient;

	const usdcAmount = new BN(1_000).mul(QUOTE_PRECISION);

	const commonVaultName = 'tokenizing vault';
	let commonVaultKey: PublicKey;

	before(async () => {
		const bootstrap = await bootstrapBankrun();
		bankrunContextWrapper = bootstrap.bankrunContextWrapper;
		bulkAccountLoader = bootstrap.bulkAccountLoader;
		connection = bankrunContextWrapper.connection.toConnection();
		adminClient = bootstrap.adminClient;
		program = bootstrap.program;
		usdcMint = bootstrap.usdcMint;
		metaplex = bootstrap.metaplex;
		oracleInfos = bootstrap.oracleInfos;

		commonVaultKey = getVaultAddressSync(
			program.programId,
			encodeName(commonVaultName)
		);

		const velocityClientConfig = {
			accountSubscription: {
				type: 'polling' as const,
				accountLoader: bulkAccountLoader as BulkAccountLoader,
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes,
			spotMarketIndexes,
			oracleInfos,
		};

		const bootstrapManager = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		managerClient = bootstrapManager.vaultClient;
		managerVelocityClient = bootstrapManager.velocityClient;

		const vd0Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount: new BN(10).mul(usdcAmount),
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		vd0Client = vd0Bootstrap.vaultClient;
		vd0VelocityClient = vd0Bootstrap.velocityClient;
		const vd1Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount: new BN(10).mul(usdcAmount),
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		vd1Client = vd1Bootstrap.vaultClient;
		vd1VelocityClient = vd1Bootstrap.velocityClient;

		await managerClient.initializeVault(
			{
				name: encodeName(commonVaultName),
				spotMarketIndex: 0,
				redeemPeriod: ZERO,
				maxTokens: ZERO,
				managementFee: ZERO,
				profitShare: 0,
				hurdleRate: 0,
				permissioned: false,
				minDepositAmount: ZERO,
			},
			{ noLut: true }
		);

		await bulkAccountLoader.load();
	});

	after(async () => {
		await adminClient.unsubscribe();
		await managerClient.unsubscribe();
		await managerVelocityClient.unsubscribe();
		await vd0Client.unsubscribe();
		await vd0VelocityClient.unsubscribe();
		await vd1Client.unsubscribe();
		await vd1VelocityClient.unsubscribe();
	});

	async function _fetchAccountStates(
		vaultAddress?: PublicKey,
		vaultDepositorAddress?: PublicKey,
		tokenizedVaultDepositorAddress?: PublicKey
	) {
		const vault = vaultAddress
			? await program.account.vault.fetch(vaultAddress)
			: undefined;
		const vaultDepositor = vaultDepositorAddress
			? await program.account.vaultDepositor.fetch(vaultDepositorAddress)
			: undefined;
		const tokenizedVaultDepositor = tokenizedVaultDepositorAddress
			? await program.account.tokenizedVaultDepositor.fetch(
					tokenizedVaultDepositorAddress
			  )
			: undefined;
		return {
			vault,
			vaultDepositor,
			tokenizedVaultDepositor,
		};
	}

	it('Initialize TokenizedVaultDepositor', async () => {
		try {
			await managerClient.initializeTokenizedVaultDepositor(
				{
					vault: commonVaultKey,
					tokenName: 'Tokenized Vault',
					tokenSymbol: 'TV',
					tokenUri: '',
					decimals: 6,
				},
				{ noLut: true }
			);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const tokenMint = getTokenizedVaultMintAddressSync(
			program.programId,
			commonVaultKey,
			0
		);
		const metadataAccount = metaplex.nfts().pdas().metadata({
			mint: tokenMint,
		});

		const mintAccount = await getMint(connection, tokenMint);
		assert(mintAccount.mintAuthority.equals(commonVaultKey));
		assert(mintAccount.decimals === 6);
		assert(mintAccount.isInitialized === true);

		assert((await connection.getAccountInfo(metadataAccount)) !== null);
		const metadata = await metaplex
			.nfts()
			.findByMint({ mintAddress: tokenMint });
		assert(metadata.mint.address.equals(tokenMint));
		assert(metadata.name === 'Tokenized Vault');
		assert(metadata.symbol === 'TV');
		assert(metadata.uri === '');
	});

	it('Initialize another TokenizedVaultDepositor', async () => {
		const { tokenizedVaultDepositor } = calculateAllTokenizedVaultPdas(
			program.programId,
			commonVaultKey,
			bankrunContextWrapper.provider.wallet.publicKey,
			0
		);
		const tvdAccount = await connection.getAccountInfo(tokenizedVaultDepositor);
		assert(tvdAccount !== null, 'TokenizedVaultDepositor account should exist');
		try {
			const initTx = await managerClient.initializeTokenizedVaultDepositor(
				{
					vault: commonVaultKey,
					tokenName: 'Tokenized Vault',
					tokenSymbol: 'TV',
					tokenUri: '',
					decimals: 6,
				},
				{ noLut: true }
			);
			// @ts-ignore
			await printTxLogs(connection, initTx, false, program);
		} catch (e) {
			return;
		}
		assert(
			false,
			'Should not have been able to initialize a second TokenizedVaultDepositor'
		);
	});

	it('Tokenize and redeem vault shares', async () => {
		const bootstrapVd = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig: {
				accountSubscription: {
					type: 'polling',
					accountLoader: bulkAccountLoader as BulkAccountLoader,
				},
				activeSubAccountId: 0,
				subAccountIds: [],
				perpMarketIndexes,
				spotMarketIndexes,
				oracleInfos,
			},
		});

		const {
			vaultDepositor,
			tokenizedVaultDepositor,
			mintAddress,
			userVaultTokenAta,
			vaultTokenizedTokenAta,
		} = calculateAllTokenizedVaultPdas(
			program.programId,
			commonVaultKey,
			bootstrapVd.signer.publicKey,
			0
		);

		// deposit to vault
		try {
			await bootstrapVd.vaultClient.deposit(
				vaultDepositor,
				usdcAmount,
				{
					vault: commonVaultKey,
					authority: bootstrapVd.vaultClient.velocityClient.wallet.publicKey,
				},
				{ noLut: true },
				bootstrapVd.userUSDCAccount.publicKey
			);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		await validateTotalUserShares(
			program,
			commonVaultKey,
			[vaultDepositor],
			[tokenizedVaultDepositor]
		);

		const vdBefore = await program.account.vaultDepositor.fetch(vaultDepositor);
		const vdtBefore = await program.account.tokenizedVaultDepositor.fetch(
			tokenizedVaultDepositor
		);
		const vaultBefore = await program.account.vault.fetch(commonVaultKey);
		const mintAccountBefore = await getMint(connection, mintAddress);
		const tvdTokenBalanceBefore = await getTokenBalance(
			connection,
			vaultTokenizedTokenAta
		);

		assert(
			(await connection.getAccountInfo(userVaultTokenAta)) === null,
			'User vault token account should not exist'
		);
		assert(
			tvdTokenBalanceBefore.value.uiAmount === 0,
			'TokenizedVaultDepositor token account has tokens'
		);
		assert(Number(mintAccountBefore.supply) === 0, 'Mint supply !== 0');

		assert(
			Number(vdBefore.vaultShares) === Number(usdcAmount),
			`VaultDepositor has no shares`
		);

		// tokenize shares for tokens
		try {
			const txSig = await bootstrapVd.vaultClient.tokenizeShares(
				vaultDepositor,
				vdBefore.vaultShares,
				WithdrawUnit.SHARES,
				undefined,
				{ noLut: true }
			);
			// @ts-ignore
			await printTxLogs(connection, txSig, false, program);
		} catch (e) {
			console.error(e);
			assert(false, 'tokenizeShares threw');
		}

		const vdAfterTokenize = await program.account.vaultDepositor.fetch(
			vaultDepositor
		);
		const vdtAfterTokenize =
			await program.account.tokenizedVaultDepositor.fetch(
				tokenizedVaultDepositor
			);
		const vaultAfterTokenize = await program.account.vault.fetch(
			commonVaultKey
		);
		const mintAccountAfterTokenize = await getMint(connection, mintAddress);
		const userTokenBalanceAfterTokenize = await getTokenBalance(
			connection,
			userVaultTokenAta
		);
		const tvdTokenBalanceAfterTokenize = await getTokenBalance(
			connection,
			vaultTokenizedTokenAta
		);

		assert(
			tvdTokenBalanceAfterTokenize.value.uiAmount === 0,
			'TokenizedVaultDepositor token account has tokens'
		);

		const vdSharesDelta = vdAfterTokenize.vaultShares.sub(vdBefore.vaultShares);
		const vdtSharesDelta = vdtAfterTokenize.vaultShares.sub(
			vdtBefore.vaultShares
		);
		const tokenBalanceDelta = new BN(
			userTokenBalanceAfterTokenize.value.amount
		).sub(ZERO);
		const mintSupplyDelta = new BN(String(mintAccountAfterTokenize.supply)).sub(
			new BN(String(mintAccountBefore.supply))
		);

		assert(
			vdAfterTokenize.vaultSharesBase === vdBefore.vaultSharesBase,
			'VaultDepositor shares base changed'
		);
		assert(
			vdtAfterTokenize.vaultSharesBase === vdtBefore.vaultSharesBase,
			'TokenizedVaultDepositor shares base changed'
		);

		assert(
			vdSharesDelta.neg().eq(vdtSharesDelta),
			'VaultDepositor and TokenizedVaultDepositor shares delta should be equal and opposite'
		);
		assert(
			tokenBalanceDelta.eq(mintSupplyDelta),
			'Token balance delta should equal mint supply delta'
		);

		assert(
			vaultBefore.totalShares.eq(vaultAfterTokenize.totalShares),
			'Vault total shares should not have changed'
		);
		assert(
			vaultBefore.userShares.eq(vaultAfterTokenize.userShares),
			'Vault user shares should not have changed'
		);

		// redeem tokens for shares
		try {
			const txSig = await bootstrapVd.vaultClient.redeemTokens(
				vaultDepositor,
				new BN(userTokenBalanceAfterTokenize.value.amount).div(TWO),
				undefined,
				{ noLut: true }
			);
			// @ts-ignore
			await printTxLogs(connection, txSig, false, program);
		} catch (e) {
			console.error(e);
			assert(false, 'redeemTokens threw');
		}

		const vdAfterRedeem = await program.account.vaultDepositor.fetch(
			vaultDepositor
		);
		const vdtAfterRedeem = await program.account.tokenizedVaultDepositor.fetch(
			tokenizedVaultDepositor
		);
		const vaultAfterRedeem = await program.account.vault.fetch(commonVaultKey);
		const mintAccountAfterRedeem = await getMint(connection, mintAddress);
		const userTokenBalanceAfterRedeem = await getTokenBalance(
			connection,
			userVaultTokenAta
		);
		const tvdTokenBalanceAfterRedeem = await getTokenBalance(
			connection,
			vaultTokenizedTokenAta
		);

		assert(
			tvdTokenBalanceAfterRedeem.value.uiAmount === 0,
			'TokenizedVaultDepositor token account has tokens'
		);

		const vdSharesDeltaAfterRedeem = vdAfterRedeem.vaultShares.sub(
			vdBefore.vaultShares
		);
		const vdtSharesDeltaAfterRedeem = vdtAfterRedeem.vaultShares.sub(
			vdtBefore.vaultShares
		);
		const tokenBalanceDeltaAfterRedeem = new BN(
			userTokenBalanceAfterRedeem.value.amount
		).sub(new BN(userTokenBalanceAfterTokenize.value.amount));
		const mintSupplyDeltaAfterRedeem = new BN(
			String(mintAccountAfterRedeem.supply)
		).sub(new BN(String(mintAccountAfterTokenize.supply)));

		assert(
			vdAfterRedeem.vaultSharesBase === vdBefore.vaultSharesBase,
			'VaultDepositor shares base changed'
		);
		assert(
			vdtAfterRedeem.vaultSharesBase === vdtBefore.vaultSharesBase,
			'TokenizedVaultDepositor shares base changed'
		);

		assert(
			vdSharesDeltaAfterRedeem.neg().eq(vdtSharesDeltaAfterRedeem),
			'VaultDepositor and TokenizedVaultDepositor shares delta should be equal and opposite'
		);
		assert(
			tokenBalanceDeltaAfterRedeem.eq(mintSupplyDeltaAfterRedeem),
			'Token balance delta should equal mint supply delta'
		);

		assert(
			vaultBefore.totalShares.eq(vaultAfterRedeem.totalShares),
			'Vault total shares should not have changed'
		);
		assert(
			vaultBefore.userShares.eq(vaultAfterRedeem.userShares),
			'Vault user shares should not have changed'
		);

		// teardown

		await validateTotalUserShares(
			program,
			commonVaultKey,
			[vaultDepositor],
			[tokenizedVaultDepositor]
		);

		await bootstrapVd.velocityClient.unsubscribe();
		await bootstrapVd.vaultClient.unsubscribe();
	});

	// The following profit-share / rebase tests move vault equity by having the
	// vault trade SPOT against a market maker (placeAndTakeSpotOrder on spot
	// market index 1). Velocity disabled spot DLOB trading entirely
	// (validate_spot_dlob_trading_enabled_for_market_type always rejects
	// MarketType::Spot -> SpotDlobTradingDisabled / 0x18ce), so there is no way
	// to drive the vault into the profit/loss/rebase states these tests assert,
	// on bankrun or any other harness. Left as skipped stubs.
	it.skip('Redeem vault tokens with profit share, profitable', async () => {
		// blocked: requires spot DLOB trading, which velocity removed (SpotDlobTradingDisabled)
	});

	it.skip('Redeem vault tokens with profit share, not profitable', async () => {
		// blocked: requires spot DLOB trading, which velocity removed (SpotDlobTradingDisabled)
	});

	it.skip('Disallow tokenize after vault rebases, allow redeeming tokens', async () => {
		// blocked: requires spot DLOB trading, which velocity removed (SpotDlobTradingDisabled)
	});
});

describe('TestInsuranceFundStake', () => {
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;
	let connection: ReturnType<
		BankrunContextWrapper['connection']['toConnection']
	>;
	let adminClient: AdminClient;
	let program: Program<Vaults>;
	let usdcMint: Keypair;

	let managerClient: VaultClient;
	let managerVelocityClient: VelocityClient;
	let managerUsdcAccount: PublicKey;
	let managerWSOLAccount: PublicKey;

	let vd0Client: VaultClient;
	let vd0VelocityClient: VelocityClient;
	let vd0UsdcAccount: PublicKey;
	let vd0WSOLAccount: PublicKey;

	let vd1Client: VaultClient;
	let vd1VelocityClient: VelocityClient;

	const usdcAmount = new BN(1_000).mul(QUOTE_PRECISION);
	const solAmount = new BN(100).mul(new BN(LAMPORTS_PER_SOL));

	const commonVaultName = 'vault with IF';

	before(async () => {
		const bootstrap = await bootstrapBankrun();
		bankrunContextWrapper = bootstrap.bankrunContextWrapper;
		bulkAccountLoader = bootstrap.bulkAccountLoader;
		connection = bankrunContextWrapper.connection.toConnection();
		adminClient = bootstrap.adminClient;
		program = bootstrap.program;
		usdcMint = bootstrap.usdcMint;
		const metaplex = bootstrap.metaplex;
		const oracleInfos = bootstrap.oracleInfos;

		const velocityClientConfig = {
			accountSubscription: {
				type: 'polling' as const,
				accountLoader: bulkAccountLoader as BulkAccountLoader,
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes,
			spotMarketIndexes,
			oracleInfos,
		};

		const bootstrapManager = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			solAmount,
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		managerClient = bootstrapManager.vaultClient;
		managerVelocityClient = bootstrapManager.velocityClient;
		managerUsdcAccount = bootstrapManager.userUSDCAccount.publicKey;
		managerWSOLAccount = bootstrapManager.userWSOLAccount;
		const vd0Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount: new BN(10).mul(usdcAmount),
			solAmount,
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		vd0Client = vd0Bootstrap.vaultClient;
		vd0VelocityClient = vd0Bootstrap.velocityClient;
		vd0UsdcAccount = vd0Bootstrap.userUSDCAccount.publicKey;
		vd0WSOLAccount = vd0Bootstrap.userWSOLAccount;
		const vd1Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount: new BN(10).mul(usdcAmount),
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		vd1Client = vd1Bootstrap.vaultClient;
		vd1VelocityClient = vd1Bootstrap.velocityClient;

		await managerClient.initializeVault(
			{
				name: encodeName(commonVaultName),
				spotMarketIndex: 0,
				redeemPeriod: ZERO,
				maxTokens: ZERO,
				managementFee: ZERO,
				profitShare: 0,
				hurdleRate: 0,
				permissioned: false,
				minDepositAmount: ZERO,
			},
			{ noLut: true }
		);

		await bulkAccountLoader.load();
	});

	after(async () => {
		await adminClient.unsubscribe();
		await managerClient.unsubscribe();
		await managerVelocityClient.unsubscribe();
		await vd0Client.unsubscribe();
		await vd0VelocityClient.unsubscribe();
		await vd1Client.unsubscribe();
		await vd1VelocityClient.unsubscribe();
	});

	const testInsuranceFundStake = async (marketIndex: number) => {
		const vaultName = `if stake vault market ${marketIndex}`;
		const vault = getVaultAddressSync(program.programId, encodeName(vaultName));

		const beforeStateAccount = adminClient.getStateAccount();
		await managerClient.initializeVault(
			{
				name: encodeName(vaultName),
				spotMarketIndex: 0,
				redeemPeriod: ZERO,
				maxTokens: ZERO,
				managementFee: ZERO,
				profitShare: 0,
				hurdleRate: 0,
				permissioned: false,
				minDepositAmount: ZERO,
			},
			{ noLut: true }
		);
		await adminClient.fetchAccounts();
		const afterStateAccount = adminClient.getStateAccount();

		assert(
			afterStateAccount.numberOfAuthorities
				.sub(beforeStateAccount.numberOfAuthorities)
				.eq(new BN(1))
		);
		assert(
			afterStateAccount.numberOfSubAccounts
				.sub(beforeStateAccount.numberOfSubAccounts)
				.eq(new BN(1))
		);

		// Shrink the IF unstaking escrow so the remove-stake step only needs a
		// short bankrun clock advance (default is THIRTEEN_DAY).
		await adminClient.updateInsuranceFundUnstakingPeriod(
			marketIndex,
			new BN(1)
		);

		console.log(
			`Testing initializeInsuranceFundStake for market ${marketIndex}`
		);
		const _ifStakeTx0 = await managerClient.initializeInsuranceFundStake(
			vault,
			marketIndex,
			{ noLut: true }
		);

		// test initializing an IF stake account
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			managerVelocityClient.program.programId,
			vault,
			marketIndex
		);
		const ifStakeAccount =
			(await managerVelocityClient.program.account.insuranceFundStake.fetch(
				ifStakeAccountPublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount !== null, "Couldn't fetch IF stake account");
		assert(
			ifStakeAccount.marketIndex === marketIndex,
			'Market index is incorrect'
		);
		assert(
			ifStakeAccount.authority.equals(vault),
			'Vault is not the authority'
		);
		assert(ifStakeAccount.ifShares.eq(ZERO), 'Doesnt have 0 shares');

		let managerTokenAccount: PublicKey;
		let vd0TokenAccount: PublicKey;
		if (marketIndex === 0) {
			managerTokenAccount = managerUsdcAccount;
			vd0TokenAccount = vd0UsdcAccount;
		} else if (marketIndex === 1) {
			managerTokenAccount = managerWSOLAccount;
			vd0TokenAccount = vd0WSOLAccount;
		} else {
			assert(false, 'Invalid market index');
		}
		const managerTokenAccountBalance = await getTokenBalance(
			connection,
			managerTokenAccount
		);

		const vd0TokenAccountBalance = await getTokenBalance(
			connection,
			vd0TokenAccount
		);

		// test only manager can add stake
		try {
			await vd0Client.addToInsuranceFundStake(
				vault,
				marketIndex,
				new BN(vd0TokenAccountBalance.value.amount),
				vd0TokenAccount
			);
			assert(false, 'vd0 should not be able to add to IF stake');
		} catch (e) {
			assert(true);
		}

		// test add some stake
		const ifStakeAmount = new BN(managerTokenAccountBalance.value.amount);
		await managerClient.addToInsuranceFundStake(
			vault,
			marketIndex,
			ifStakeAmount,
			managerTokenAccount,
			{ noLut: true }
		);

		const ifStakeAccount1 =
			(await managerVelocityClient.program.account.insuranceFundStake.fetch(
				ifStakeAccountPublicKey
			)) as InsuranceFundStake;
		await managerVelocityClient.fetchAccounts();
		assert(
			ifStakeAccount1.ifShares.eq(ifStakeAmount),
			'Shares are not equal to amount deposited'
		);

		// test request remove stake
		const requestRemoveAmount = ifStakeAmount.sub(new BN(2));
		await managerClient.requestRemoveInsuranceFundStake(
			vault,
			marketIndex,
			requestRemoveAmount,
			{ noLut: true }
		);

		const ifStakeAccount2 =
			(await managerVelocityClient.program.account.insuranceFundStake.fetch(
				ifStakeAccountPublicKey
			)) as InsuranceFundStake;
		assert(
			ifStakeAccount2.lastWithdrawRequestShares.eq(requestRemoveAmount),
			'Failed to request remove stake'
		);

		// test cancel remove stake request
		await managerClient.cancelRequestRemoveInsuranceFundStake(
			vault,
			marketIndex,
			{ noLut: true }
		);

		const ifStakeAccount3 =
			(await managerVelocityClient.program.account.insuranceFundStake.fetch(
				ifStakeAccountPublicKey
			)) as InsuranceFundStake;
		assert(
			ifStakeAccount3.lastWithdrawRequestShares.eq(ZERO),
			'Failed to cancel remove stake request'
		);

		// test remove stake
		await managerClient.requestRemoveInsuranceFundStake(
			vault,
			marketIndex,
			requestRemoveAmount,
			{ noLut: true }
		);

		// Advance the bankrun clock past the unstake period.
		await bankrunContextWrapper.moveTimeForward(1000);

		await managerClient.removeInsuranceFundStake(
			vault,
			marketIndex,
			managerTokenAccount,
			{ noLut: true }
		);

		const tokenBalanceAfter = await getTokenBalance(
			connection,
			managerTokenAccount
		);
		assert(
			new BN(tokenBalanceAfter.value.amount).eq(requestRemoveAmount),
			`Manager balance not expected after unstake: ${tokenBalanceAfter.value.amount}`
		);
	};

	it('Test initializeInsuranceFundStake for vault deposit asset', async () => {
		await testInsuranceFundStake(0);
	});

	it('Test initializeInsuranceFundStake for asset different than deposit asset', async () => {
		await testInsuranceFundStake(1);
	});
});

describe('TestSOLDenomindatedVault', () => {
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;
	let adminClient: AdminClient;
	let program: Program<Vaults>;
	let usdcMint: Keypair;

	let managerClient: VaultClient;
	let managerVelocityClient: VelocityClient;

	let vd0Signer: Signer;
	let vd0Client: VaultClient;
	let vd0VelocityClient: VelocityClient;

	const usdcAmount = new BN(1_000).mul(QUOTE_PRECISION);

	const commonVaultName = 'sol vault';
	let commonVaultKey: PublicKey;

	before(async () => {
		const bootstrap = await bootstrapBankrun();
		bankrunContextWrapper = bootstrap.bankrunContextWrapper;
		bulkAccountLoader = bootstrap.bulkAccountLoader;
		adminClient = bootstrap.adminClient;
		program = bootstrap.program;
		usdcMint = bootstrap.usdcMint;
		const metaplex = bootstrap.metaplex;
		const oracleInfos = bootstrap.oracleInfos;

		commonVaultKey = getVaultAddressSync(
			program.programId,
			encodeName(commonVaultName)
		);

		const velocityClientConfig = {
			accountSubscription: {
				type: 'polling' as const,
				accountLoader: bulkAccountLoader as BulkAccountLoader,
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes,
			spotMarketIndexes,
			oracleInfos,
		};

		const bootstrapManager = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		managerClient = bootstrapManager.vaultClient;
		managerVelocityClient = bootstrapManager.velocityClient;

		const vd0Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount: new BN(10).mul(usdcAmount),
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		vd0Signer = vd0Bootstrap.signer;
		vd0Client = vd0Bootstrap.vaultClient;
		vd0VelocityClient = vd0Bootstrap.velocityClient;

		await managerClient.initializeVault(
			{
				name: encodeName(commonVaultName),
				spotMarketIndex: 1,
				redeemPeriod: ZERO,
				maxTokens: ZERO,
				managementFee: ZERO,
				profitShare: 0,
				hurdleRate: 0,
				permissioned: false,
				minDepositAmount: ZERO,
			},
			{ noLut: true }
		);

		await bulkAccountLoader.load();
	});

	after(async () => {
		await adminClient.unsubscribe();
		await managerClient.unsubscribe();
		await managerVelocityClient.unsubscribe();
		await vd0Client.unsubscribe();
		await vd0VelocityClient.unsubscribe();
	});

	it('Initialized SOL denominated vault', async () => {
		const vault = await program.account.vault.fetch(commonVaultKey);
		assert(vault.spotMarketIndex === 1, 'Vault spot market index is not 1');

		const spotMarket1 = vd0VelocityClient.getSpotMarketAccount(1);
		assert(
			spotMarket1.mint.equals(WRAPPED_SOL_MINT),
			'Spot market mint is not SOL'
		);

		const vdSolBalance = await vd0VelocityClient.connection.getBalance(
			vd0Signer.publicKey
		);
		assert(vdSolBalance > 0, 'Vault depositor SOL balance is 0');
	});

	it('Test deposit then withdraw SOL', async () => {
		const balanceBefore = Number(
			await vd0VelocityClient.connection.getBalance(vd0Signer.publicKey)
		);
		const vaultEquityBefore =
			await vd0Client.calculateVaultEquityInDepositAsset({
				address: commonVaultKey,
			});

		const vdKey = getVaultDepositorAddressSync(
			program.programId,
			commonVaultKey,
			vd0Signer.publicKey
		);
		await vd0Client.deposit(
			vdKey,
			new BN(0.5 * LAMPORTS_PER_SOL),
			{
				authority: vd0Signer.publicKey,
				vault: commonVaultKey,
			},
			{ noLut: true, cuPriceMicroLamports: 0 }
		);

		const balanceAfter = Number(
			await vd0VelocityClient.connection.getBalance(vd0Signer.publicKey)
		);
		console.log(`sol balance ${balanceBefore} -> ${balanceAfter}`);
		assert(
			balanceAfter < balanceBefore,
			'Vault depositor SOL balance not decreased'
		);

		await vd0Client.syncVaultUsers();
		const vaultEquityAfter = await vd0Client.calculateVaultEquityInDepositAsset(
			{
				address: commonVaultKey,
			}
		);
		console.log(`vault equity: ${vaultEquityBefore} -> ${vaultEquityAfter}`);
		assert(vaultEquityAfter > vaultEquityBefore, 'Vault equity not increased');

		await vd0Client.requestWithdraw(
			vdKey,
			PERCENTAGE_PRECISION,
			WithdrawUnit.SHARES_PERCENT,
			{ noLut: true, cuPriceMicroLamports: 0 }
		);

		await vd0Client.withdraw(vdKey, { noLut: true, cuPriceMicroLamports: 0 });

		await vd0Client.syncVaultUsers();
		const equityEnd = await vd0Client.calculateVaultEquityInDepositAsset({
			address: commonVaultKey,
		});
		console.log(
			`vault equity: ${vaultEquityBefore} -> ${vaultEquityAfter} -> ${equityEnd}`
		);
		assert(
			equityEnd.sub(vaultEquityBefore).abs().lten(1),
			'Vault equity not decreased'
		);

		const balanceEnd = Number(
			await vd0VelocityClient.connection.getBalance(vd0Signer.publicKey)
		);
		console.log(
			`sol balance 333 ${balanceBefore} -> ${balanceAfter} -> ${balanceEnd}`
		);
		assert(
			Math.abs(balanceEnd - balanceBefore) <= 0.003 * LAMPORTS_PER_SOL,
			'Vault depositor SOL balance not increased'
		);
	});
});

describe('TestWithdrawFromVaults', () => {
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;
	let connection: ReturnType<
		BankrunContextWrapper['connection']['toConnection']
	>;
	let adminClient: AdminClient;
	let program: Program<Vaults>;
	let usdcMint: Keypair;
	let solPerpOracle: PublicKey;
	let oracleInfos: OracleInfo[];

	let managerSigner: Signer;
	let managerClient: VaultClient;
	let managerVelocityClient: VelocityClient;
	let managerUsdcAccount: PublicKey;

	let vd0Signer: Signer;
	let vd0Client: VaultClient;
	let vd0VelocityClient: VelocityClient;
	let vd0UsdcAccount: PublicKey;

	let protocol: Keypair;
	let protocolClient: VaultClient;
	let protocolVelocityClient: VelocityClient;

	const usdcAmount = new BN(1_000).mul(QUOTE_PRECISION);

	const commonVaultName = 'withdraw test vault';
	let commonVaultKey: PublicKey;

	const VAULT_PROTOCOL_DISCRIM: number[] = [106, 130, 5, 195, 126, 82, 249, 53];

	before(async () => {
		const bootstrap = await bootstrapBankrun();
		bankrunContextWrapper = bootstrap.bankrunContextWrapper;
		bulkAccountLoader = bootstrap.bulkAccountLoader;
		connection = bankrunContextWrapper.connection.toConnection();
		adminClient = bootstrap.adminClient;
		program = bootstrap.program;
		usdcMint = bootstrap.usdcMint;
		const metaplex = bootstrap.metaplex;
		solPerpOracle = bootstrap.solPerpOracle;
		oracleInfos = bootstrap.oracleInfos;

		commonVaultKey = getVaultAddressSync(
			program.programId,
			encodeName(commonVaultName)
		);

		const velocityClientConfig = {
			accountSubscription: {
				type: 'polling' as const,
				accountLoader: bulkAccountLoader as BulkAccountLoader,
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes,
			spotMarketIndexes,
			oracleInfos,
		};

		const bootstrapManager = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		managerSigner = bootstrapManager.signer;
		managerClient = bootstrapManager.vaultClient;
		managerVelocityClient = bootstrapManager.velocityClient;
		managerUsdcAccount = bootstrapManager.userUSDCAccount.publicKey;

		const vd0Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			metaplex,
			velocityClientConfig,
		});
		vd0Signer = vd0Bootstrap.signer;
		vd0Client = vd0Bootstrap.vaultClient;
		vd0VelocityClient = vd0Bootstrap.velocityClient;
		vd0UsdcAccount = vd0Bootstrap.userUSDCAccount.publicKey;

		const bootstrapProtocol = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			signer: Keypair.generate(),
			programId: VAULT_PROGRAM_ID,
			usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			skipUser: true,
			velocityClientConfig,
		});
		protocol = bootstrapProtocol.signer;
		protocolClient = bootstrapProtocol.vaultClient;
		protocolVelocityClient = bootstrapProtocol.velocityClient;

		{
			const vpParams: VaultProtocolParams = {
				protocol: protocol.publicKey,
				protocolFee: new BN(0),
				// 100_000 = 10%
				protocolProfitShare: 100_000,
			};

			await managerClient.initializeVault(
				{
					name: encodeName(commonVaultName),
					spotMarketIndex: 0,
					redeemPeriod: ZERO,
					maxTokens: ZERO,
					managementFee: ZERO,
					profitShare: 0,
					hurdleRate: 0,
					permissioned: false,
					minDepositAmount: ZERO,
					vaultProtocol: vpParams,
				},
				{ noLut: true }
			);

			const vaultAcct = await program.account.vault.fetch(commonVaultKey);
			assert(vaultAcct.manager.equals(managerSigner.publicKey));
			const vp = getVaultProtocolAddressSync(
				managerClient.program.programId,
				commonVaultKey
			);
			// asserts "exit" was called on VaultProtocol to define the discriminator
			const vpAcctInfo = await connection.getAccountInfo(vp);
			assert(vpAcctInfo.data.includes(Buffer.from(VAULT_PROTOCOL_DISCRIM)));

			// asserts Vault and VaultProtocol fields were set properly
			const vpAcct = await program.account.vaultProtocol.fetch(vp);
			assert(vaultAcct.vaultProtocol);
			assert(vpAcct.protocol.equals(protocol.publicKey));

			await vd0Client.initializeVaultDepositor(
				commonVaultKey,
				vd0Signer.publicKey,
				undefined,
				{ noLut: true }
			);
			const vaultDepositor = getVaultDepositorAddressSync(
				program.programId,
				commonVaultKey,
				vd0Signer.publicKey
			);
			const vdAcct = await program.account.vaultDepositor.fetch(vaultDepositor);
			assert(vdAcct.vault.equals(commonVaultKey));
		}

		await bulkAccountLoader.load();
	});

	after(async () => {
		await adminClient.unsubscribe();
		await managerClient.unsubscribe();
		await managerVelocityClient.unsubscribe();
		await vd0Client.unsubscribe();
		await vd0VelocityClient.unsubscribe();
		await protocolClient.unsubscribe();
		await protocolVelocityClient.unsubscribe();
	});

	async function fetchAccountStates(
		vaultAddress?: PublicKey,
		vaultDepositorAddress?: PublicKey,
		protocolAddress?: PublicKey
	) {
		const vault = vaultAddress
			? await program.account.vault.fetch(vaultAddress)
			: undefined;
		const vaultDepositor = vaultDepositorAddress
			? await program.account.vaultDepositor.fetch(vaultDepositorAddress)
			: undefined;
		const protocol = protocolAddress
			? await program.account.vaultProtocol.fetch(protocolAddress)
			: undefined;
		return {
			vault,
			vaultDepositor,
			protocol,
		};
	}

	it('Test full withdraw of vault shares', async () => {
		const managerTokenBalance0 = await getTokenBalance(
			connection,
			managerUsdcAccount
		);
		const vd0TokenBalance0 = await getTokenBalance(connection, vd0UsdcAccount);
		console.log(
			'managerTokenBalance0',
			managerTokenBalance0.value.uiAmountString
		);
		console.log('vd0TokenBalance0', vd0TokenBalance0.value.uiAmountString);

		let vaultEquity = await managerClient.calculateVaultEquity({
			address: commonVaultKey,
		});
		console.log('vault equity:', vaultEquity.toString());

		// 1) manager deposits + vd deposits

		await managerClient.managerDeposit(
			commonVaultKey,
			new BN(100).mul(QUOTE_PRECISION),
			{ noLut: true },
			managerUsdcAccount
		);
		const vdKey = getVaultDepositorAddressSync(
			program.programId,
			commonVaultKey,
			vd0Signer.publicKey
		);
		await vd0Client.deposit(
			vdKey,
			new BN(500).mul(QUOTE_PRECISION),
			undefined,
			{ noLut: true },
			vd0UsdcAccount
		);

		// 2) manager requests withdraw + vd requests withdraw

		await managerClient.managerRequestWithdraw(
			commonVaultKey,
			PERCENTAGE_PRECISION,
			WithdrawUnit.SHARES_PERCENT,
			{ noLut: true }
		);
		await vd0Client.requestWithdraw(
			vdKey,
			PERCENTAGE_PRECISION,
			WithdrawUnit.SHARES_PERCENT,
			{ noLut: true }
		);

		const { vault: vaultState0 } = await fetchAccountStates(
			commonVaultKey,
			vdKey
		);

		console.log(
			'vaultState0 usdc balance',
			(await getTokenBalance(connection, vaultState0.tokenAccount)).value
				.uiAmountString
		);

		// 3) withdraw in reverse order:
		// 3.1) vd withdraws
		try {
			const remainingAccounts = vd0Client.velocityClient.getRemainingAccounts({
				userAccounts: [],
				writableSpotMarketIndexes: [0],
			});
			remainingAccounts.push({
				pubkey: vd0Client.getVaultProtocolAddress(commonVaultKey),
				isSigner: false,
				isWritable: true,
			});
			const txSig = await vd0Client.program.methods
				.withdraw()
				.accounts({
					userTokenAccount: vd0UsdcAccount,
					vault: commonVaultKey,
					vaultDepositor: vdKey,
					vaultTokenAccount: vaultState0.tokenAccount,
					velocityUser: vaultState0.user,
					velocityUserStats: vaultState0.userStats,
					velocityState: await adminClient.getStatePublicKey(),
					velocitySpotMarketVault: adminClient.getSpotMarketAccount(0).vault,
					velocitySigner: adminClient.getStateAccount().signer,
					velocityProgram: adminClient.program.programId,
				})
				.remainingAccounts(remainingAccounts)
				.rpc();

			// @ts-ignore
			await printTxLogs(connection, txSig, false, program);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		// 3.2) manager withdraws
		try {
			const remainingAccounts =
				managerClient.velocityClient.getRemainingAccounts({
					userAccounts: [],
					writableSpotMarketIndexes: [0],
				});
			remainingAccounts.push({
				pubkey: managerClient.getVaultProtocolAddress(commonVaultKey),
				isSigner: false,
				isWritable: true,
			});
			const txSig = await managerClient.program.methods
				.managerWithdraw()
				.accounts({
					userTokenAccount: managerUsdcAccount,
					manager: managerSigner.publicKey,
					vault: commonVaultKey,
					vaultTokenAccount: vaultState0.tokenAccount,
					velocityUser: vaultState0.user,
					velocityUserStats: vaultState0.userStats,
					velocityState: await adminClient.getStatePublicKey(),
					velocitySpotMarketVault: adminClient.getSpotMarketAccount(0).vault,
					velocitySigner: adminClient.getStateAccount().signer,
					velocityProgram: adminClient.program.programId,
				})
				.remainingAccounts(remainingAccounts)
				.rpc();

			// @ts-ignore
			await printTxLogs(connection, txSig, false, program);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const { vault: vaultState1 } = await fetchAccountStates(
			commonVaultKey,
			vdKey
		);

		// calculateVaultEquity reads the vault's velocity user through the
		// websocket-subscribed vaultUsers map, which never receives updates on
		// bankrun. Force a one-time fetch of the known vault user so equity
		// reflects the post-withdraw (drained) state.
		await managerClient.velocityClient.fetchAccounts();
		const vaultVelocityUser = await managerClient.getSubscribedVaultUser(
			vaultState1.user
		);
		await vaultVelocityUser.fetchAccounts();
		vaultEquity = await managerClient.calculateVaultEquity({
			address: commonVaultKey,
		});
		console.log('final vault equity:', vaultEquity.toNumber() / 1e6);
		assert(vaultEquity.eq(ZERO));

		const managerTokenBalance1 = await getTokenBalance(
			connection,
			managerUsdcAccount
		);
		const vd0TokenBalance1 = await getTokenBalance(connection, vd0UsdcAccount);
		const vaultTokenBalance1 = await getTokenBalance(
			connection,
			vaultState1.tokenAccount
		);

		console.log(
			'managerTokenBalance1',
			managerTokenBalance1.value.uiAmountString
		);
		console.log('vd0TokenBalance1', vd0TokenBalance1.value.uiAmountString);
		console.log('vaultTokenBalance1', vaultTokenBalance1.value.uiAmountString);
	});

	// Drives an MM wash-trading loop (place-and-take spot orders against a
	// live maker) plus vault delegate control; does not run on bankrun.
	// Skipped: this test moves vault equity via an MM wash-trading loop that
	// places SPOT DLOB orders, but velocity disabled spot DLOB trading entirely
	// (validate_spot_dlob_trading_enabled_for_market_type always rejects
	// MarketType::Spot -> SpotDlobTradingDisabled / 0x18ce). The bankrun port is
	// otherwise complete (vault-user PDA fetch + equity refresh); it cannot pass
	// against the velocity program regardless of harness.
	it.skip('Test manager cancel withdraw owning 100% of vault', async () => {
		const { velocityClient: mmVelocityClient, requoteFunc } =
			await initializeSolSpotMarketMaker(
				bankrunContextWrapper,
				usdcMint,
				managerVelocityClient.program,
				[
					{
						publicKey: solPerpOracle,
						source: OracleSource.PYTH_LAZER,
					},
				],
				undefined,
				undefined,
				bulkAccountLoader
			);

		// 1) manager deposits

		await managerClient.managerDeposit(
			commonVaultKey,
			new BN(100).mul(QUOTE_PRECISION),
			{ noLut: true },
			managerUsdcAccount
		);

		const { vault: vaultState0 } = await fetchAccountStates(commonVaultKey);
		const vaultEquity0 = await managerClient.calculateVaultEquity({
			address: commonVaultKey,
		});

		// 2) manager requests withdraw
		const tx0 = await managerClient.managerRequestWithdraw(
			commonVaultKey,
			PERCENTAGE_PRECISION,
			WithdrawUnit.SHARES_PERCENT,
			{ noLut: true }
		);
		// @ts-ignore
		await printTxLogs(connection, tx0, false, program);

		// 3) vault trades into profit
		try {
			const oracle0 = mmVelocityClient.getOracleDataForSpotMarket(1);

			await managerClient.updateDelegate(
				commonVaultKey,
				managerSigner.publicKey,
				{ noLut: true }
			);
			// addAndSubscribeToUsers uses getProgramAccounts (unavailable on
			// bankrun); assume control of the vault user by fetching its known
			// PDA directly and adding it to the manager (delegate) client.
			const vaultUserKey = await getUserAccountPublicKey(
				managerVelocityClient.program.programId,
				commonVaultKey,
				0
			);
			const vaultUserAcct =
				(await managerVelocityClient.program.account.user.fetch(
					vaultUserKey
				)) as unknown as UserAccount;
			await managerVelocityClient.addUser(0, commonVaultKey, vaultUserAcct);
			await managerVelocityClient.switchActiveUser(0, commonVaultKey);

			const washVaultUser = await managerClient.getSubscribedVaultUser(
				vaultState0.user
			);
			await washVaultUser.fetchAccounts();
			const vaultEquity = await managerClient.calculateVaultEquity({
				address: commonVaultKey,
			});

			await doWashTrading({
				mmVelocityClient,
				traderVelocityClient: managerVelocityClient,
				traderAuthority: commonVaultKey,
				traderSubAccount: 0,
				vaultClient: managerClient,
				vaultAddress: commonVaultKey,
				startVaultEquity: vaultEquity,
				stopPnlDiffPct: -0.1,
				maxIters: 1,
				mmRequoteFunc: requoteFunc,
				doSell: false,
			});

			const solMarket = adminClient.getSpotMarketAccount(1)!;

			// increase oracle
			const newOraclePrice = convertToNumber(oracle0.price) * 1.25;

			console.log(
				`setting oracle price ${convertToNumber(
					oracle0.price
				)} -> ${newOraclePrice}`
			);
			await setFeedPrice(
				bankrunContextWrapper,
				newOraclePrice,
				solMarket.oracle
			);

			await managerVelocityClient.fetchAccounts();
			await washVaultUser.fetchAccounts();

			const vaultEquity1 = await managerClient.calculateVaultEquity({
				address: commonVaultKey,
			});

			assert(vaultEquity1.gt(vaultEquity0), 'vault equity should be in profit');
		} catch (e) {
			console.error(e);
			assert(false);
		}

		// 4) manager cancels withdraw
		const tx1 = await managerClient.managerCancelWithdrawRequest(
			commonVaultKey,
			{ noLut: true }
		);
		// @ts-ignore
		await printTxLogs(connection, tx1, false, program);

		await managerClient.velocityClient.fetchAccounts();

		const { vault: vaultState1 } = await fetchAccountStates(commonVaultKey);

		assert(
			vaultState1.totalShares.eq(vaultState0.totalShares),
			'total shares should be the same after canceling withdraws'
		);

		const finalVaultUser = await managerClient.getSubscribedVaultUser(
			vaultState1.user
		);
		await finalVaultUser.fetchAccounts();
		const vaultEquity2 = await managerClient.calculateVaultEquity({
			address: commonVaultKey,
		});
		console.log('final vault equity:', vaultEquity2.toNumber() / 1e6);
		assert(vaultEquity2.gt(ZERO));
	});
});
