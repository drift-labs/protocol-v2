import * as anchor from '@coral-xyz/anchor';
import { BN, Program, Wallet } from '@coral-xyz/anchor';
import { expect } from 'chai';
import {
	BankrunContextWrapper,
	TEST_ADMIN_KEYPAIR,
} from './common/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import {
	VaultClient,
	getVaultAddressSync,
	getVaultDepositorAddressSync,
	encodeName,
	Vaults,
	VAULT_PROGRAM_ID,
	IDL,
	FeeUpdateStatus,
	getFeeUpdateAddressSync,
} from '@velocity-exchange/vaults-sdk';
import {
	BulkAccountLoader,
	VELOCITY_PROGRAM_ID as DRIFT_PROGRAM_ID,
	VelocityClient,
	getVariant,
	OracleSource,
	PEG_PRECISION,
	PERCENTAGE_PRECISION,
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
	printTxLogs,
} from './common/testHelpers';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { mockOracleNoProgram } from './common/bankrunOracle';
import { BankrunProvider } from 'anchor-bankrun';

// ammInvariant == k == x * y
const mantissaSqrtScale = new BN(100_000);
const ammInitialQuoteAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);
const ammInitialBaseAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);

const redeemPeriod = new BN(1);

const TEN_PCT_FEE = new BN(PERCENTAGE_PRECISION.divn(10));
const TWENTY_PCT_FEE = new BN(PERCENTAGE_PRECISION.divn(5));
const FIFTY_PCT_MANAGEMENT_FEE = new BN(PERCENTAGE_PRECISION.divn(2));
const ONE_DAY_S = new BN(86400);
const ONE_WEEK_S = ONE_DAY_S.muln(7);

describe('feeUpdate', () => {
	let vaultProgram: Program<Vaults>;
	const initialSolPerpPrice = 100;
	let adminVelocityClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint: Keypair;
	let solPerpOracle: PublicKey;
	// Each test gets a fresh, uniquely-named vault (the vault PDA derives from the
	// name only), so the expensive protocol + client bootstrap can move to a
	// one-time `before` while per-test vault state stays fully isolated — see the
	// before/beforeEach split below.
	let vaultName: string;
	let commonVaultKey: PublicKey;
	let vaultCounter = 0;
	const usdcAmount = new BN(1_000_000_000).mul(QUOTE_PRECISION);

	const managerSigner = Keypair.generate();
	let managerClient: VaultClient;
	let managerVelocityClient: VelocityClient;

	let adminClient: VaultClient;

	const user1Signer = Keypair.generate();
	let user1Client: VaultClient;
	let user1VelocityClient: VelocityClient;

	const user2Signer = Keypair.generate();
	let user2Client: VaultClient;
	let user2VelocityClient: VelocityClient;

	const user3Signer = Keypair.generate();
	let user3Client: VaultClient;
	let user3VelocityClient: VelocityClient;

	before(async () => {
		const context = await startAnchor('', [], []);

		// wrap the context to use it with the test helpers
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

		const adminWallet = new Wallet(
			Keypair.fromSecretKey(Buffer.from(TEST_ADMIN_KEYPAIR))
			// Keypair.generate()
		);

		await bankrunContextWrapper.fundKeypair(
			adminWallet.payer,
			100 * LAMPORTS_PER_SOL
		);

		adminVelocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: adminWallet,
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
			new BN(0), // 1 HOUR
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
			velocityClientConfig: {
				accountSubscription: {
					type: 'polling',
					accountLoader: bulkAccountLoader as BulkAccountLoader,
				},
				activeSubAccountId: 0,
				subAccountIds: [],
				perpMarketIndexes: [0],
				spotMarketIndexes: [0, 1],
				oracleInfos: [
					{ publicKey: solPerpOracle, source: OracleSource.PYTH_LAZER },
				],
			},
		});
		managerClient = managerBootstrap.vaultClient;
		managerVelocityClient = managerBootstrap.velocityClient;

		const provider = new BankrunProvider(
			bankrunContextWrapper.context,
			adminVelocityClient.wallet as anchor.Wallet
		);
		const program = new Program(IDL, provider);
		adminClient = new VaultClient({
			velocityClient: adminVelocityClient,
			// @ts-ignore
			program,
		});

		const user1Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			programId: VAULT_PROGRAM_ID,
			signer: user1Signer,
			usdcMint: usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			velocityClientConfig: {
				accountSubscription: {
					type: 'polling',
					accountLoader: bulkAccountLoader as BulkAccountLoader,
				},
				activeSubAccountId: 0,
				subAccountIds: [],
				perpMarketIndexes: [0],
				spotMarketIndexes: [0, 1],
				oracleInfos: [
					{ publicKey: solPerpOracle, source: OracleSource.PYTH_LAZER },
				],
			},
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
			velocityClientConfig: {
				accountSubscription: {
					type: 'polling',
					accountLoader: bulkAccountLoader as BulkAccountLoader,
				},
				activeSubAccountId: 0,
				subAccountIds: [],
				perpMarketIndexes: [0],
				spotMarketIndexes: [0, 1],
				oracleInfos: [
					{ publicKey: solPerpOracle, source: OracleSource.PYTH_LAZER },
				],
			},
		});
		user2Client = user2Bootstrap.vaultClient;
		user2VelocityClient = user2Bootstrap.velocityClient;

		const user3Bootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			programId: VAULT_PROGRAM_ID,
			signer: user3Signer,
			usdcMint: usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			velocityClientConfig: {
				accountSubscription: {
					type: 'polling',
					accountLoader: bulkAccountLoader as BulkAccountLoader,
				},
				activeSubAccountId: 0,
				subAccountIds: [],
				perpMarketIndexes: [0],
				spotMarketIndexes: [0, 1],
				oracleInfos: [
					{ publicKey: solPerpOracle, source: OracleSource.PYTH_LAZER },
				],
			},
		});
		user3Client = user3Bootstrap.vaultClient;
		user3VelocityClient = user3Bootstrap.velocityClient;

		// `before` runs once but each test below initializes its own vault +
		// depositor accounts (rent paid by manager/users), so top these reused
		// signers up to cover the whole suite's worth of account creation.
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

	// Per-test: a fresh, uniquely-named vault + its depositors. The chain, markets,
	// and clients are shared from `before`; these tests neither deposit user
	// collateral nor assert on global balances, so the only state that must reset
	// between them is the vault itself.
	beforeEach(async () => {
		vaultName = `fuel distribution vault ${vaultCounter++}`;
		commonVaultKey = getVaultAddressSync(
			VAULT_PROGRAM_ID,
			encodeName(vaultName)
		);

		await managerClient.initializeVault(
			{
				name: encodeName(vaultName),
				spotMarketIndex: 0,
				redeemPeriod,
				maxTokens: ZERO,
				managementFee: TWENTY_PCT_FEE,
				profitShare: TWENTY_PCT_FEE.toNumber(),
				hurdleRate: TEN_PCT_FEE.toNumber(),
				permissioned: false,
				minDepositAmount: ZERO,
			},
			{ noLut: true }
		);
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
	});

	after(async () => {
		await adminVelocityClient.unsubscribe();
		await adminClient.unsubscribe();
		await managerClient.unsubscribe();
		await managerVelocityClient.unsubscribe();
		await user1Client.unsubscribe();
		await user1VelocityClient.unsubscribe();
		await user2Client.unsubscribe();
		await user2VelocityClient.unsubscribe();
		await user3Client.unsubscribe();
		await user3VelocityClient.unsubscribe();
	});

	it('vaults initialized', async () => {
		const vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.manager).to.deep.equal(managerSigner.publicKey);

		const vaultDepositor = getVaultDepositorAddressSync(
			vaultProgram.programId,
			commonVaultKey,
			user2Signer.publicKey
		);
		const vdAcct = await vaultProgram.account.vaultDepositor.fetch(
			vaultDepositor
		);
		expect(vdAcct.vault).to.deep.equal(commonVaultKey);

		const vaultDepositor2 = getVaultDepositorAddressSync(
			vaultProgram.programId,
			commonVaultKey,
			user1Signer.publicKey
		);
		const vdAcct2 = await vaultProgram.account.vaultDepositor.fetch(
			vaultDepositor2
		);
		expect(vdAcct2.vault).to.deep.equal(commonVaultKey);
	});

	it('only admin can init fee update account', async () => {
		let vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.feeUpdateStatus).to.deep.equal(FeeUpdateStatus.None);

		const feeUpdate = getFeeUpdateAddressSync(
			vaultProgram.programId,
			commonVaultKey
		);
		expect(await bankrunContextWrapper.connection.getAccountInfo(feeUpdate)).to
			.be.null;

		// manager cannot init their own FeeUpdate account
		try {
			await managerClient.adminInitFeeUpdate(commonVaultKey, { noLut: true });
			fail('should not get here');
		} catch (e) {
			expect(e).to.not.be.undefined;
		}

		// admin can init the FeeUpdate account
		await adminClient.adminInitFeeUpdate(commonVaultKey, { noLut: true });

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.feeUpdateStatus).to.deep.equal(FeeUpdateStatus.None);

		expect(await bankrunContextWrapper.connection.getAccountInfo(feeUpdate)).not
			.to.be.null;
	});

	it('manager can lower fee from normal update', async () => {
		let vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managementFee.toNumber()).to.deep.equal(
			TWENTY_PCT_FEE.toNumber()
		);
		expect(vaultAcct.profitShare).to.deep.equal(TWENTY_PCT_FEE.toNumber());
		expect(vaultAcct.hurdleRate).to.deep.equal(TEN_PCT_FEE.toNumber());

		await managerClient.managerUpdateVault(
			commonVaultKey,
			{
				redeemPeriod: null,
				maxTokens: null,
				minDepositAmount: null,
				permissioned: null,
				managementFee: TEN_PCT_FEE,
				profitShare: TEN_PCT_FEE.toNumber(),
				hurdleRate: TWENTY_PCT_FEE.toNumber(),
			},
			{ noLut: true }
		);

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managementFee.toNumber()).to.deep.equal(
			TEN_PCT_FEE.toNumber()
		);
		expect(vaultAcct.profitShare).to.deep.equal(TEN_PCT_FEE.toNumber());
		expect(vaultAcct.hurdleRate).to.deep.equal(TWENTY_PCT_FEE.toNumber());
	});

	it('manager cannot raise fee from normal update', async () => {
		let vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managementFee.toNumber()).to.deep.equal(
			TWENTY_PCT_FEE.toNumber()
		);
		expect(vaultAcct.profitShare).to.deep.equal(TWENTY_PCT_FEE.toNumber());
		expect(vaultAcct.hurdleRate).to.deep.equal(TEN_PCT_FEE.toNumber());

		try {
			await managerClient.managerUpdateVault(
				commonVaultKey,
				{
					redeemPeriod: null,
					maxTokens: null,
					minDepositAmount: null,
					permissioned: null,
					managementFee: FIFTY_PCT_MANAGEMENT_FEE,
					profitShare: FIFTY_PCT_MANAGEMENT_FEE.toNumber(),
					hurdleRate: TEN_PCT_FEE.toNumber(),
				},
				{ noLut: true }
			);
			fail('should not get here');
		} catch (e) {
			expect(e).to.not.be.undefined;
		}

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managementFee.toNumber()).to.deep.equal(
			TWENTY_PCT_FEE.toNumber()
		);
		expect(vaultAcct.profitShare).to.deep.equal(TWENTY_PCT_FEE.toNumber());
		expect(vaultAcct.hurdleRate).to.deep.equal(TEN_PCT_FEE.toNumber());
	});

	it('manager must choose timelock duration greater than 2x redeem period and 1 week', async () => {
		const vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managementFee.toNumber()).to.deep.equal(
			TWENTY_PCT_FEE.toNumber()
		);
		expect(vaultAcct.profitShare).to.deep.equal(TWENTY_PCT_FEE.toNumber());
		expect(vaultAcct.hurdleRate).to.deep.equal(TEN_PCT_FEE.toNumber());

		const timelockDuration = ONE_WEEK_S.divn(2);

		try {
			await managerClient.managerUpdateFees(
				commonVaultKey,
				{
					timelockDuration,
					newManagementFee: TEN_PCT_FEE,
					newProfitShare: TEN_PCT_FEE.toNumber(),
					newHurdleRate: TWENTY_PCT_FEE.toNumber(),
				},
				{ noLut: true }
			);
			fail('should not get here');
		} catch (e) {
			expect(e).to.not.be.undefined;
		}
	});

	it('manager can raise fee through timelock', async () => {
		let vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managementFee.toNumber()).to.deep.equal(
			TWENTY_PCT_FEE.toNumber()
		);
		expect(vaultAcct.profitShare).to.deep.equal(TWENTY_PCT_FEE.toNumber());
		expect(vaultAcct.hurdleRate).to.deep.equal(TEN_PCT_FEE.toNumber());

		const timelockDuration = ONE_WEEK_S;

		await adminClient.adminInitFeeUpdate(commonVaultKey, { noLut: true });

		const tx = await managerClient.managerUpdateFees(
			commonVaultKey,
			{
				timelockDuration,
				newManagementFee: TEN_PCT_FEE,
				newProfitShare: TEN_PCT_FEE.toNumber(),
				newHurdleRate: TWENTY_PCT_FEE.toNumber(),
			},
			{ noLut: true }
		);
		const events = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			tx,
			false,
			// @ts-ignore
			vaultProgram
		);

		expect(events.length).to.deep.equal(1);
		expect(getVariant(events[0].data.action)).to.deep.equal('pending');
		const ts = events[0].data.ts;
		const timeLockEndTs = events[0].data.timelockEndTs;
		expect(timeLockEndTs.sub(ts).toNumber()).to.deep.equal(
			timelockDuration.toNumber()
		);

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managementFee.toNumber()).to.deep.equal(
			TWENTY_PCT_FEE.toNumber()
		);
		expect(vaultAcct.profitShare).to.deep.equal(TWENTY_PCT_FEE.toNumber());
		expect(vaultAcct.hurdleRate).to.deep.equal(TEN_PCT_FEE.toNumber());
		expect(vaultAcct.feeUpdateStatus).to.deep.equal(
			FeeUpdateStatus.PendingFeeUpdate
		);

		// user deposits after 1 day, new fee should come into effect
		await bankrunContextWrapper.moveTimeForward(ONE_WEEK_S.toNumber());

		// trigger the fee upduate
		const tx1 = await managerClient.managerUpdateFees(
			commonVaultKey,
			{
				timelockDuration: new BN(0),
				newManagementFee: null,
				newProfitShare: null,
				newHurdleRate: null,
			},
			{ noLut: true }
		);
		const events1 = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			tx1,
			false,
			// @ts-ignore
			vaultProgram
		);
		// Anchor 1.0 (velocity) emits event names camelCased; the IDL name is
		// PascalCase FeeUpdateRecord.
		const feeUpdateEvent = events1.find((e) => e.name === 'feeUpdateRecord');
		expect(feeUpdateEvent).not.to.be.null;
		expect(getVariant(feeUpdateEvent?.data.action)).to.deep.equal('applied');

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managementFee.toNumber()).to.deep.equal(
			TEN_PCT_FEE.toNumber()
		);
		expect(vaultAcct.profitShare).to.deep.equal(TEN_PCT_FEE.toNumber());
		expect(vaultAcct.hurdleRate).to.deep.equal(TWENTY_PCT_FEE.toNumber());
		expect(vaultAcct.feeUpdateStatus).to.deep.equal(FeeUpdateStatus.None);
	});

	it('manager can cancel fee updates', async () => {
		let vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		const timelockDuration = ONE_WEEK_S;

		await adminClient.adminInitFeeUpdate(commonVaultKey, { noLut: true });

		await managerClient.managerUpdateFees(
			commonVaultKey,
			{
				timelockDuration,
				newManagementFee: TEN_PCT_FEE,
				newProfitShare: TEN_PCT_FEE.toNumber(),
				newHurdleRate: TWENTY_PCT_FEE.toNumber(),
			},
			{ noLut: true }
		);

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.feeUpdateStatus).to.deep.equal(
			FeeUpdateStatus.PendingFeeUpdate
		);

		await managerClient.managerCancelFeeUpdate(commonVaultKey, { noLut: true });

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.feeUpdateStatus).to.deep.equal(FeeUpdateStatus.None);
	});

	it('admin can delete fee update account', async () => {
		await adminClient.adminInitFeeUpdate(commonVaultKey, { noLut: true });
		let vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);

		await adminClient.adminDeleteFeeUpdate(commonVaultKey, { noLut: true });
		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.feeUpdateStatus).to.deep.equal(FeeUpdateStatus.None);
	});
});
