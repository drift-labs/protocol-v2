import * as anchor from '@coral-xyz/anchor';
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
	VELOCITY_PROGRAM_ID as VELOCITY_PROGRAM_ID,
	VelocityClient,
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
import { readUnsignedBigInt64LE } from './common/bankrunHelpers';
import { Keypair } from '@solana/web3.js';
import { mockOracleNoProgram } from './common/bankrunOracle';
import { BankrunProvider } from 'anchor-bankrun';

// ammInvariant == k == x * y
const mantissaSqrtScale = new BN(100_000);
const ammInitialQuoteAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);
const ammInitialBaseAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);

describe('velocityVaults', () => {
	let vaultProgram: Program<Vaults>;
	const initialSolPerpPrice = 100;
	let adminVelocityClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint: Keypair;

	const vaultName = 'fuel distribution vault';
	const commonVaultKey = getVaultAddressSync(
		VAULT_PROGRAM_ID,
		encodeName(vaultName)
	);
	const usdcAmount = new BN(1_000_000_000).mul(QUOTE_PRECISION);

	const managerSigner = Keypair.generate();
	let managerClient: VaultClient;
	let managerVelocityClient: VelocityClient;

	let adminClient: VaultClient;

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

	let solPerpOracle: PublicKey;

	beforeEach(async () => {
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

		adminVelocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: new PublicKey(VELOCITY_PROGRAM_ID),
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
			// @ts-ignore
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
		user1UserUSDCAccount = user1Bootstrap.userUSDCAccount.publicKey;
		user1VaultDepositor = getVaultDepositorAddressSync(
			vaultProgram.programId,
			commonVaultKey,
			user1Signer.publicKey
		);

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
		user2UserUSDCAccount = user2Bootstrap.userUSDCAccount.publicKey;
		user2VaultDepositor = getVaultDepositorAddressSync(
			vaultProgram.programId,
			commonVaultKey,
			user2Signer.publicKey
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
		await user2Client.initializeVaultDepositor(
			commonVaultKey,
			user2Signer.publicKey,
			user2Signer.publicKey,
			{ noLut: true }
		);
	});

	afterEach(async () => {
		await adminVelocityClient.unsubscribe();
		await adminClient.unsubscribe();
		await managerClient.unsubscribe();
		await managerVelocityClient.unsubscribe();
		await user1Client.unsubscribe();
		await user1VelocityClient.unsubscribe();
		await user2Client.unsubscribe();
		await user2VelocityClient.unsubscribe();
	});

	it('vaults initialized', async () => {
		await user1Client.deposit(
			user1VaultDepositor,
			new BN(100_000 * QUOTE_PRECISION.toNumber()),
			undefined,
			{ noLut: true },
			user1UserUSDCAccount
		);
		await bankrunContextWrapper.moveTimeForward(1000);

		let vault = await user1Client.program.account.vault.fetch(commonVaultKey);
		// console.log(vault.totalShares.toString());
		// console.log(vault.userShares.toString());

		let vd1 = await user1Client.program.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		// console.log(vd1.vaultShares.toString());

		await user1VelocityClient.fetchAccounts();

		let vaultEquity = await managerClient.calculateVaultEquity({
			// address: commonVaultKey,
			// @ts-ignore
			vault,
		});
		// console.log(`Vault equity ${vaultEquity.toString()}`);
		// console.log('user 2 deposits 200k');

		await user2Client.deposit(
			user2VaultDepositor,
			new BN(200_000 * QUOTE_PRECISION.toNumber()),
			undefined,
			{ noLut: true },
			user2UserUSDCAccount
		);
		await bankrunContextWrapper.moveTimeForward(1000);

		vault = await user2Client.program.account.vault.fetch(commonVaultKey);
		// console.log('vault total shares', vault.totalShares.toString());
		// console.log('vault user shares', vault.userShares.toString());

		let vd2 = await user2Client.program.account.vaultDepositor.fetch(
			user2VaultDepositor
		);
		// console.log('vault2 shares', vd2.vaultShares.toString());

		await user2Client.syncVaultUsers();
		await user2VelocityClient.fetchAccounts();

		vaultEquity = await user2Client.calculateVaultEquity({
			address: commonVaultKey,
		});
		// console.log('vault equity', vaultEquity.toString());

		expect(vaultEquity.toString()).to.equal('300000000000');

		// console.log(vault.user);

		const updateVaultUserBalance = async (numerator: BN, denominator: BN) => {
			const vaultUser = await bankrunContextWrapper.connection.getAccountInfo(
				vault.user
			);
			const userBuffer = Buffer.from(vaultUser!.data!);
			const scaledBalance = readUnsignedBigInt64LE(userBuffer, 104);
			userBuffer.writeBigUInt64LE(
				BigInt(scaledBalance.mul(numerator).div(denominator).toString()),
				104
			);

			bankrunContextWrapper.context.setAccount(vault.user, {
				executable: vaultUser!.executable,
				owner: vaultUser!.owner,
				lamports: vaultUser!.lamports,
				data: userBuffer,
				rentEpoch: vaultUser!.rentEpoch,
			});
		};

		/// vault +10%
		await updateVaultUserBalance(new BN(110), new BN(100));

		await user2Client.syncVaultUsers();
		vaultEquity = await user2Client.calculateVaultEquity({
			address: commonVaultKey,
		});
		expect(vaultEquity.toString()).to.equal('330000000000');

		// user1 requests 100% withdraw
		await user1Client.syncVaultUsers();
		await user1VelocityClient.fetchAccounts();
		await user1Client.requestWithdraw(
			user1VaultDepositor,
			PERCENTAGE_PRECISION,
			WithdrawUnit.SHARES_PERCENT,
			{ noLut: true }
		);

		vd1 = await user1Client.program.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		// console.log(vd1);

		// vault +10%
		await updateVaultUserBalance(new BN(110), new BN(100));
		await user2Client.syncVaultUsers();
		vaultEquity = await user2Client.calculateVaultEquity({
			address: commonVaultKey,
		});
		expect(vaultEquity.toString()).to.equal('363000000000');

		await user1Client.cancelRequestWithdraw(user1VaultDepositor, {
			noLut: true,
		});

		vault = await user1Client.program.account.vault.fetch(commonVaultKey);
		// console.log(vault);

		vd1 = await user1Client.program.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		// console.log(vd1);

		vd2 = await user1Client.program.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		// console.log(vd2);

		// vault -10%
		await updateVaultUserBalance(new BN(90), new BN(100));
		await user2Client.syncVaultUsers();
		vaultEquity = await user2Client.calculateVaultEquity({
			address: commonVaultKey,
		});
		expect(vaultEquity.toString()).to.equal('326700000000');

		// user1 requests 100% withdraw
		await user1Client.syncVaultUsers();
		await user1VelocityClient.fetchAccounts();
		const tx0 = await user1Client.requestWithdraw(
			user1VaultDepositor,
			PERCENTAGE_PRECISION,
			WithdrawUnit.SHARES_PERCENT,
			{ noLut: true }
		);
		await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			tx0,
			true,
			// @ts-ignore
			user1Client.program
		);
		await bankrunContextWrapper.moveTimeForward(1000);

		// vault -50%
		await updateVaultUserBalance(new BN(50), new BN(100));
		await user2Client.syncVaultUsers();
		vaultEquity = await user2Client.calculateVaultEquity({
			address: commonVaultKey,
		});
		expect(vaultEquity.toString()).to.equal('163350000000');
		await bankrunContextWrapper.moveTimeForward(1000);

		await user1Client.syncVaultUsers();
		await user1VelocityClient.fetchAccounts();
		const tx = await user1Client.withdraw(user1VaultDepositor, { noLut: true });
		await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			tx,
			true,
			// @ts-ignore
			user1Client.program
		);

		vault = await user1Client.program.account.vault.fetch(commonVaultKey);
		// console.log('vault', vault);

		vd1 = await user1Client.program.account.vaultDepositor.fetch(
			user1VaultDepositor
		);
		// console.log('vd1', vd1);
		expect(vd1.vaultShares.toString()).to.equal('0');

		vd2 = await user2Client.program.account.vaultDepositor.fetch(
			user2VaultDepositor
		);
		// console.log('vd2', vd2);
		expect(vd2.vaultShares.toString()).to.equal('200000000000');

		await user2Client.syncVaultUsers();
		vaultEquity = await user2Client.calculateVaultEquity({
			address: commonVaultKey,
		});
		// console.log('vault equity', vaultEquity.toString());
		expect(vaultEquity.toString()).to.equal('113850000000');
	});
});
