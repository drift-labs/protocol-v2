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
	Vaults as DriftVaults,
	VAULT_PROGRAM_ID,
	IDL,
	isNormalVaultClass,
	isTrustedVaultClass,
} from '@velocity-exchange/vaults-sdk';
import {
	BulkAccountLoader,
	VELOCITY_PROGRAM_ID as DRIFT_PROGRAM_ID,
	VelocityClient as DriftClient,
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
	printTxLogs,
} from './common/testHelpers';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { mockOracleNoProgram } from './common/bankrunOracle';
import { BankrunProvider } from 'anchor-bankrun';
import { VaultClass } from '@velocity-exchange/vaults-sdk';

// ammInvariant == k == x * y
const mantissaSqrtScale = new BN(100_000);
const ammInitialQuoteAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);
const ammInitialBaseAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);

describe('TestTrustedVault', () => {
	let vaultProgram: Program<DriftVaults>;
	const initialSolPerpPrice = 100;
	let adminDriftClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint: Keypair;
	let solPerpOracle: PublicKey;
	const vaultName = 'fuel distribution vault';
	const commonVaultKey = getVaultAddressSync(
		VAULT_PROGRAM_ID,
		encodeName(vaultName)
	);
	const usdcAmount = new BN(1_000_000_000).mul(QUOTE_PRECISION);

	const managerSigner = Keypair.generate();
	let managerClient: VaultClient;
	let managerDriftClient: DriftClient;
	let managerUserUSDCAccount: PublicKey;

	let adminClient: VaultClient;

	const user1Signer = Keypair.generate();
	let user1Client: VaultClient;
	let user1DriftClient: DriftClient;
	let user1UserUSDCAccount: PublicKey;
	let user1VaultDepositor: PublicKey;

	beforeEach(async () => {
		const context = await startAnchor('', [], []);

		// wrap the context to use it with the test helpers
		bankrunContextWrapper = new BankrunContextWrapper(context);

		vaultProgram = new Program<DriftVaults>(
			IDL,
			bankrunContextWrapper.provider
		);

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
		);

		await bankrunContextWrapper.fundKeypair(
			adminWallet.payer,
			100 * LAMPORTS_PER_SOL
		);

		adminDriftClient = new TestClient({
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

		await adminDriftClient.initialize(usdcMint.publicKey, true);
		await adminDriftClient.subscribe();

		await initializeQuoteSpotMarket(adminDriftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(adminDriftClient, solPerpOracle);

		await adminDriftClient.initializePerpMarket(
			0,
			solPerpOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0), // 1 HOUR
			new BN(initialSolPerpPrice).mul(PEG_PRECISION)
		);

		await adminDriftClient.fetchAccounts();

		const managerBootstrap = await bootstrapSignerClientAndUserBankrun({
			bankrunContext: bankrunContextWrapper,
			programId: VAULT_PROGRAM_ID,
			signer: managerSigner,
			usdcMint: usdcMint,
			usdcAmount,
			vaultClientCliMode: true,
			driftClientConfig: {
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
		managerDriftClient = managerBootstrap.driftClient;
		managerUserUSDCAccount = managerBootstrap.userUSDCAccount.publicKey;

		const provider = new BankrunProvider(
			bankrunContextWrapper.context,
			adminDriftClient.wallet as anchor.Wallet
		);
		const program = new Program(IDL, provider);
		adminClient = new VaultClient({
			driftClient: adminDriftClient,
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
			driftClientConfig: {
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
		user1DriftClient = user1Bootstrap.driftClient;
		user1UserUSDCAccount = user1Bootstrap.userUSDCAccount.publicKey;
		user1VaultDepositor = getVaultDepositorAddressSync(
			vaultProgram.programId,
			commonVaultKey,
			user1Signer.publicKey
		);

		// initialize a vault and depositors
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
		await user1Client.initializeVaultDepositor(
			commonVaultKey,
			user1Signer.publicKey,
			user1Signer.publicKey,
			{ noLut: true }
		);
	});

	afterEach(async () => {
		await adminDriftClient.unsubscribe();
		await adminClient.unsubscribe();
		await managerClient.unsubscribe();
		await managerDriftClient.unsubscribe();
		await user1Client.unsubscribe();
		await user1DriftClient.unsubscribe();
	});

	it('vaults initialized', async () => {
		const vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.manager).to.deep.equal(managerSigner.publicKey);

		expect(isNormalVaultClass(vaultAcct.vaultClass)).to.deep.equal(true);

		const vaultDepositor = getVaultDepositorAddressSync(
			vaultProgram.programId,
			commonVaultKey,
			user1Signer.publicKey
		);
		const vdAcct = await vaultProgram.account.vaultDepositor.fetch(
			vaultDepositor
		);
		expect(vdAcct.vault).to.deep.equal(commonVaultKey);
	});

	it('admin can update vault class and borrow and repay', async () => {
		let vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.manager).to.deep.equal(managerSigner.publicKey);
		expect(isNormalVaultClass(vaultAcct.vaultClass)).to.deep.equal(true);

		await adminClient.updateMarginTradingEnabled(commonVaultKey, true, {
			noLut: true,
		});

		await adminClient.adminUpdateVaultClass(
			commonVaultKey,
			VaultClass.TRUSTED,
			{ noLut: true }
		);

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(isTrustedVaultClass(vaultAcct.vaultClass)).to.deep.equal(true);

		// user1 deposit sol into drift (for vault to borrow)
		await bankrunContextWrapper.fundKeypair(
			user1Signer,
			100 * LAMPORTS_PER_SOL
		);
		await user1DriftClient.deposit(
			new BN(100 * LAMPORTS_PER_SOL),
			1,
			user1Signer.publicKey,
			undefined,
			undefined
		);

		// user1 deposits usdcAmount into vault
		await user1Client.deposit(
			user1VaultDepositor,
			usdcAmount,
			undefined,
			{ noLut: true },
			user1UserUSDCAccount
		);

		const vaultEquityBefore = await adminClient.calculateVaultEquity({
			address: commonVaultKey,
		});
		expect(vaultEquityBefore.toString()).to.deep.equal(usdcAmount.toString());

		await adminDriftClient.fetchAccounts();
		const spotMarket1 = adminDriftClient.getSpotMarketAccount(1);
		expect(spotMarket1!.depositBalance.toNumber()).to.deep.equal(
			100 * LAMPORTS_PER_SOL
		);

		const managerSOLBalance0 =
			await bankrunContextWrapper.connection.getBalance(
				managerSigner.publicKey
			);

		// manager performs borrow of 50 SOL
		const b = await managerClient.managerBorrow(
			commonVaultKey,
			1,
			new BN(50 * LAMPORTS_PER_SOL),
			undefined,
			{ noLut: true, cuPriceMicroLamports: 0 }
		);
		const e = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			b,
			false,
			// @ts-ignore
			adminClient.program
		);
		expect(e.length).to.deep.equal(2);
		expect((e[0].data.borrowAmount as BN).toNumber()).to.deep.equal(
			50 * LAMPORTS_PER_SOL
		);
		expect((e[0].data.borrowValue as BN).toNumber()).to.deep.equal(5000 * 1e6);
		expect(e[0].data.borrowSpotMarketIndex).to.deep.equal(1);
		expect(e[0].data.depositSpotMarketIndex).to.deep.equal(0);

		const managerSOLBalance1 =
			await bankrunContextWrapper.connection.getBalance(
				managerSigner.publicKey
			);

		// check spot market recognizes borrows
		const spotMarket11 = adminDriftClient.getSpotMarketAccount(1);
		expect(spotMarket11!.borrowBalance.toNumber()).to.be.closeTo(
			50 * LAMPORTS_PER_SOL,
			5
		);

		// check manager borrowed SOL
		expect(
			(Number(managerSOLBalance1) - Number(managerSOLBalance0)) /
				LAMPORTS_PER_SOL
		).to.be.closeTo(50, 0.005);

		// check vault equity unchanged
		await adminClient.driftClient.fetchAccounts();
		const vaultEquityAfterBorrow = await adminClient.calculateVaultEquity({
			address: commonVaultKey,
		});
		// we repaid 10% less value, so expect vault equity to go down 10%
		expect(vaultEquityAfterBorrow.toNumber()).to.deep.equal(
			vaultEquityBefore.toNumber()
		);

		// check vault records manager's borrow in deposit asset value
		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managerBorrowedValue.toNumber()).to.deep.equal(5000 * 1e6);

		// manager repays in USDC
		const repayTx = await managerClient.managerRepay(
			commonVaultKey,
			0,
			new BN(4500 * 1e6), // repay 50 SOL * 100 - 10% = 4500 USDC
			new BN(5000 * 1e6), // zero out the borrow
			managerUserUSDCAccount,
			{ noLut: true, cuPriceMicroLamports: 0 }
		);
		const repayEvents = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			repayTx,
			false,
			// @ts-ignore
			adminClient.program
		);
		expect(repayEvents.length).to.deep.equal(2);
		expect(repayEvents[0].data.repayAmount.toNumber()).to.deep.equal(
			4500 * 1e6
		);
		expect(repayEvents[0].data.repayValue.toNumber()).to.deep.equal(5000 * 1e6);
		expect(repayEvents[0].data.repaySpotMarketIndex).to.deep.equal(0);
		expect(repayEvents[0].data.depositSpotMarketIndex).to.deep.equal(0);

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managerBorrowedValue.toNumber()).to.deep.equal(0);

		await adminClient.driftClient.fetchAccounts();
		const vaultEquityAfterRepay = await adminClient.calculateVaultEquity({
			address: commonVaultKey,
		});
		// we repaid 10% less value
		// expect final vault equity to go down by 10% of the borrowed value
		expect(vaultEquityAfterRepay.toNumber()).to.deep.equal(
			vaultEquityBefore.toNumber() - 5000 * 1e6 * 0.1
		);
	});

	it('admin can update vault class and update borrow', async () => {
		let vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.manager).to.deep.equal(managerSigner.publicKey);
		expect(isNormalVaultClass(vaultAcct.vaultClass)).to.deep.equal(true);

		await adminClient.updateMarginTradingEnabled(commonVaultKey, true, {
			noLut: true,
		});

		await adminClient.adminUpdateVaultClass(
			commonVaultKey,
			VaultClass.TRUSTED,
			{ noLut: true }
		);

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(isTrustedVaultClass(vaultAcct.vaultClass)).to.deep.equal(true);

		// user1 deposit sol into drift (for vault to borrow)
		await bankrunContextWrapper.fundKeypair(
			user1Signer,
			100 * LAMPORTS_PER_SOL
		);
		await user1DriftClient.deposit(
			new BN(100 * LAMPORTS_PER_SOL),
			1,
			user1Signer.publicKey,
			undefined,
			undefined
		);

		// user1 deposits usdcAmount into vault
		await user1Client.deposit(
			user1VaultDepositor,
			usdcAmount,
			undefined,
			{ noLut: true },
			user1UserUSDCAccount
		);

		const vaultEquityBefore = await adminClient.calculateVaultEquity({
			address: commonVaultKey,
		});
		expect(vaultEquityBefore.toString()).to.deep.equal(usdcAmount.toString());

		await adminDriftClient.fetchAccounts();
		const spotMarket1 = adminDriftClient.getSpotMarketAccount(1);
		expect(spotMarket1!.depositBalance.toNumber()).to.deep.equal(
			100 * LAMPORTS_PER_SOL
		);

		const managerSOLBalance0 =
			await bankrunContextWrapper.connection.getBalance(
				managerSigner.publicKey
			);

		// manager performs borrow of 50 SOL
		const b = await managerClient.managerBorrow(
			commonVaultKey,
			1,
			new BN(50 * LAMPORTS_PER_SOL),
			undefined,
			{ noLut: true, cuPriceMicroLamports: 0 }
		);
		const e = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			b,
			false,
			// @ts-ignore
			adminClient.program
		);
		expect(e.length).to.deep.equal(2);
		expect((e[0].data.borrowAmount as BN).toNumber()).to.deep.equal(
			50 * LAMPORTS_PER_SOL
		);
		expect((e[0].data.borrowValue as BN).toNumber()).to.deep.equal(5000 * 1e6);
		expect(e[0].data.borrowSpotMarketIndex).to.deep.equal(1);
		expect(e[0].data.depositSpotMarketIndex).to.deep.equal(0);

		const managerSOLBalance1 =
			await bankrunContextWrapper.connection.getBalance(
				managerSigner.publicKey
			);

		// check spot market recognizes borrows
		const spotMarket11 = adminDriftClient.getSpotMarketAccount(1);
		expect(spotMarket11!.borrowBalance.toNumber()).to.be.closeTo(
			50 * LAMPORTS_PER_SOL,
			5
		);

		// check manager borrowed SOL
		expect(
			(Number(managerSOLBalance1) - Number(managerSOLBalance0)) /
				LAMPORTS_PER_SOL
		).to.be.closeTo(50, 0.005);

		// check vault equity unchanged
		await adminClient.driftClient.fetchAccounts();
		const vaultEquityAfterBorrow = await adminClient.calculateVaultEquity({
			address: commonVaultKey,
		});
		// we repaid 10% less value, so expect vault equity to go down 10%
		expect(vaultEquityAfterBorrow.toNumber()).to.deep.equal(
			vaultEquityBefore.toNumber()
		);

		// check vault records manager's borrow in deposit asset value
		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managerBorrowedValue.toNumber()).to.deep.equal(5000 * 1e6);

		// manager repays in USDC
		await managerClient.managerUpdateBorrow(commonVaultKey, new BN(0), {
			noLut: true,
			cuPriceMicroLamports: 0,
		});

		vaultAcct = await vaultProgram.account.vault.fetch(commonVaultKey);
		expect(vaultAcct.managerBorrowedValue.toNumber()).to.deep.equal(0);

		await adminClient.driftClient.fetchAccounts();
		const vaultEquityAfterRepay = await adminClient.calculateVaultEquity({
			address: commonVaultKey,
		});
		// we repaid 10% less value
		// expect final vault equity to go down by 10% of the borrowed value
		expect(vaultEquityAfterRepay.toNumber()).to.deep.equal(
			vaultEquityBefore.toNumber() - 5000 * 1e6
		);
	});
});
