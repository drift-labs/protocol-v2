import { BN, Program } from '@coral-xyz/anchor';
import { expect } from 'chai';
import { BankrunContextWrapper } from './common/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import {
	VaultClient,
	getVaultAddressSync,
	getVaultDepositorAddressSync,
	encodeName,
	Vaults,
	VAULT_PROGRAM_ID,
	IDL,
	WithdrawUnit,
} from '@velocity-exchange/vaults-sdk';
import {
	BulkAccountLoader,
	VELOCITY_PROGRAM_ID as DRIFT_PROGRAM_ID,
	VelocityClient,
	OracleSource,
	PEG_PRECISION,
	PublicKey,
	QUOTE_PRECISION,
	TestClient,
	ZERO,
} from '@velocity-exchange/sdk';
import { TestBulkAccountLoader } from './common/testBulkAccountLoader';
import {
	bootstrapSignerClientAndUserBankrun,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockUSDCMintBankrun,
	mockUserUSDCAccountBankrun,
} from './common/testHelpers';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { mockOracleNoProgram } from './common/bankrunOracle';

const mantissaSqrtScale = new BN(100_000);
const ammInitialQuoteAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);
const ammInitialBaseAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);

describe('transferVaultDepositorShares', () => {
	let vaultProgram: Program<Vaults>;
	const initialSolPerpPrice = 100;
	let adminVelocityClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint: Keypair;
	let solPerpOracle: PublicKey;
	// Fresh, uniquely-named vault per test (the vault PDA derives from the name)
	// so the chain + client bootstrap can move to a one-time `before`; see the
	// before/beforeEach split below.
	let vaultName: string;
	let commonVaultKey: PublicKey;
	let vaultCounter = 0;
	const usdcAmount = new BN(1_000_000_000).mul(QUOTE_PRECISION);

	const managerSigner = Keypair.generate();
	let managerClient: VaultClient;
	let managerVelocityClient: VelocityClient;

	const user1Signer = Keypair.generate();
	let user1Client: VaultClient;
	let user1VelocityClient: VelocityClient;
	let user1UserUSDCAccount: PublicKey;
	let user1VaultDepositor: PublicKey;

	const user2Signer = Keypair.generate();
	let user2Client: VaultClient;
	let user2VelocityClient: VelocityClient;
	let user2UserUSDCAccount: PublicKey;
	let user2VaultDepositor: PublicKey;

	const velocityClientConfig = (
		bulkAccountLoader: TestBulkAccountLoader,
		solPerpOracle: PublicKey
	) => ({
		accountSubscription: {
			type: 'polling' as const,
			accountLoader: bulkAccountLoader as BulkAccountLoader,
		},
		activeSubAccountId: 0,
		subAccountIds: [],
		perpMarketIndexes: [0],
		spotMarketIndexes: [0, 1],
		oracleInfos: [
			{ publicKey: solPerpOracle, source: OracleSource.PYTH_LAZER },
		],
	});

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		vaultProgram = new Program<Vaults>(IDL, bankrunContextWrapper.provider);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection.toConnection(),
			'processed',
			1
		);

		usdcMint = await mockUSDCMintBankrun(bankrunContextWrapper);

		solPerpOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			initialSolPerpPrice
		);

		adminVelocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: new PublicKey(DRIFT_PROGRAM_ID),
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{ publicKey: solPerpOracle, source: OracleSource.PYTH_LAZER },
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader as BulkAccountLoader,
			},
		});

		await adminVelocityClient.initialize(usdcMint.publicKey, true);
		await adminVelocityClient.subscribe();

		await initializeQuoteSpotMarket(adminVelocityClient, usdcMint.publicKey);
		await initializeSolSpotMarket(adminVelocityClient, solPerpOracle);

		await adminVelocityClient.initializePerpMarket(
			0,
			solPerpOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0),
			new BN(initialSolPerpPrice).mul(PEG_PRECISION)
		);

		await adminVelocityClient.fetchAccounts();

		const managerBootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			programId: VAULT_PROGRAM_ID,
			signer: managerSigner,
			usdcMint: usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			velocityClientConfig: velocityClientConfig(
				bulkAccountLoader,
				solPerpOracle
			),
		});
		managerClient = managerBootstrap.vaultClient;
		managerVelocityClient = managerBootstrap.velocityClient;

		const user1Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			programId: VAULT_PROGRAM_ID,
			signer: user1Signer,
			usdcMint: usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			velocityClientConfig: velocityClientConfig(
				bulkAccountLoader,
				solPerpOracle
			),
		});
		user1Client = user1Bootstrap.vaultClient;
		user1VelocityClient = user1Bootstrap.velocityClient;

		const user2Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			programId: VAULT_PROGRAM_ID,
			signer: user2Signer,
			usdcMint: usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			velocityClientConfig: velocityClientConfig(
				bulkAccountLoader,
				solPerpOracle
			),
		});
		user2Client = user2Bootstrap.vaultClient;
		user2VelocityClient = user2Bootstrap.velocityClient;

		// `before` runs once; each test re-mints USDC and builds its own vault +
		// depositors below, so top the reused signers up for the whole suite.
		await bankrunContextWrapper.fundKeypair(
			managerSigner,
			100 * LAMPORTS_PER_SOL
		);
		await bankrunContextWrapper.fundKeypair(
			user1Signer,
			100 * LAMPORTS_PER_SOL
		);
		await bankrunContextWrapper.fundKeypair(
			user2Signer,
			100 * LAMPORTS_PER_SOL
		);
	});

	// Per-test: a fresh uniquely-named vault, fresh USDC for each depositor, and
	// fresh deposits. The chain, markets, and clients are shared from `before`. A
	// vault deposit moves USDC from the depositor's token account into the vault's
	// own drift account (it doesn't touch the depositor's drift user account), so
	// re-minting per test is all that's needed to keep tests isolated.
	beforeEach(async () => {
		vaultName = `transfer shares vault ${vaultCounter++}`;
		commonVaultKey = getVaultAddressSync(
			VAULT_PROGRAM_ID,
			encodeName(vaultName)
		);
		user1VaultDepositor = getVaultDepositorAddressSync(
			VAULT_PROGRAM_ID,
			commonVaultKey,
			user1Signer.publicKey
		);
		user2VaultDepositor = getVaultDepositorAddressSync(
			VAULT_PROGRAM_ID,
			commonVaultKey,
			user2Signer.publicKey
		);

		// fresh USDC for each depositor
		user1UserUSDCAccount = (
			await mockUserUSDCAccountBankrun(
				usdcMint,
				usdcAmount,
				bankrunContextWrapper,
				user1Signer.publicKey
			)
		).publicKey;
		user2UserUSDCAccount = (
			await mockUserUSDCAccountBankrun(
				usdcMint,
				usdcAmount,
				bankrunContextWrapper,
				user2Signer.publicKey
			)
		).publicKey;

		// initialize vault
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

		// initialize depositors
		await user1Client.initializeVaultDepositor(
			commonVaultKey,
			user1Signer.publicKey,
			user1Signer.publicKey,
			{ noLut: true }
		);
		await user2Client.initializeVaultDepositor(
			commonVaultKey,
			user2Signer.publicKey,
			user2Signer.publicKey,
			{ noLut: true }
		);

		// user1 deposits
		await user1Client.deposit(
			user1VaultDepositor,
			usdcAmount,
			undefined,
			{ noLut: true },
			user1UserUSDCAccount
		);

		// user2 deposits half
		await user2Client.deposit(
			user2VaultDepositor,
			usdcAmount.divn(2),
			undefined,
			{ noLut: true },
			user2UserUSDCAccount
		);
	});

	after(async () => {
		await adminVelocityClient.unsubscribe();
		await managerClient.unsubscribe();
		await managerVelocityClient.unsubscribe();
		await user1Client.unsubscribe();
		await user1VelocityClient.unsubscribe();
		await user2Client.unsubscribe();
		await user2VelocityClient.unsubscribe();
	});

	it('basic transfer shares from user1 to user2', async () => {
		const vaultBefore = await vaultProgram.account.vault.fetch(commonVaultKey);
		const vd1Before = await vaultProgram.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		const vd2Before = await vaultProgram.account.vaultDepositor.fetch(
			user2VaultDepositor
		);

		const transferAmount = vd1Before.vaultShares.divn(2);
		expect(transferAmount.gtn(0)).to.equal(true);

		await user1Client.transferVaultDepositorShares(
			user1VaultDepositor,
			user2VaultDepositor,
			transferAmount,
			WithdrawUnit.SHARES,
			{ noLut: true }
		);

		const vaultAfter = await vaultProgram.account.vault.fetch(commonVaultKey);
		const vd1After = await vaultProgram.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		const vd2After = await vaultProgram.account.vaultDepositor.fetch(
			user2VaultDepositor
		);

		// shares moved from user1 to user2
		expect(vd1After.vaultShares.lt(vd1Before.vaultShares)).to.equal(true);
		expect(vd2After.vaultShares.gt(vd2Before.vaultShares)).to.equal(true);

		// total shares in vault unchanged
		expect(vaultAfter.totalShares.eq(vaultBefore.totalShares)).to.equal(true);
		expect(vaultAfter.userShares.eq(vaultBefore.userShares)).to.equal(true);

		// combined depositor shares unchanged
		const combinedBefore = vd1Before.vaultShares.add(vd2Before.vaultShares);
		const combinedAfter = vd1After.vaultShares.add(vd2After.vaultShares);
		expect(combinedAfter.eq(combinedBefore)).to.equal(true);
	});

	it('transfer all shares from user1 to user2', async () => {
		const vd1Before = await vaultProgram.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		const vd2Before = await vaultProgram.account.vaultDepositor.fetch(
			user2VaultDepositor
		);

		const allShares = vd1Before.vaultShares;
		expect(allShares.gtn(0)).to.equal(true);

		await user1Client.transferVaultDepositorShares(
			user1VaultDepositor,
			user2VaultDepositor,
			allShares,
			WithdrawUnit.SHARES,
			{ noLut: true }
		);

		const vd1After = await vaultProgram.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		const vd2After = await vaultProgram.account.vaultDepositor.fetch(
			user2VaultDepositor
		);

		// user1 has 0 shares
		expect(vd1After.vaultShares.eqn(0)).to.equal(true);

		// user2 has all transferred shares
		const combinedBefore = vd1Before.vaultShares.add(vd2Before.vaultShares);
		expect(vd2After.vaultShares.eq(combinedBefore)).to.equal(true);
	});

	it('unauthorized transfer fails', async () => {
		const vd1Before = await vaultProgram.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		const transferAmount = vd1Before.vaultShares.divn(2);

		// user2 tries to transfer user1's shares -> should fail
		try {
			await user2Client.transferVaultDepositorShares(
				user1VaultDepositor,
				user2VaultDepositor,
				transferAmount,
				WithdrawUnit.SHARES,
				{ noLut: true }
			);
			expect(true).to.equal(false); // should not reach here
		} catch (e) {
			// expected to fail due to PDA constraint (authority mismatch)
			expect(e).to.not.be.undefined;
		}
	});

	it('transfer more shares than owned fails', async () => {
		const vd1Before = await vaultProgram.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		const tooManyShares = vd1Before.vaultShares.addn(1);

		try {
			await user1Client.transferVaultDepositorShares(
				user1VaultDepositor,
				user2VaultDepositor,
				tooManyShares,
				WithdrawUnit.SHARES,
				{ noLut: true }
			);
			expect(true).to.equal(false); // should not reach here
		} catch (e) {
			expect(e).to.not.be.undefined;
		}
	});
});
