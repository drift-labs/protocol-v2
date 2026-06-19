import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { expect } from 'chai';
import { BankrunContextWrapper } from './common/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import {
	VaultClient,
	getVaultAddressSync,
	encodeName,
	VAULT_PROGRAM_ID,
	IDL,
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
} from './common/testHelpers';
import { Keypair } from '@solana/web3.js';
import { mockOracleNoProgram } from './common/bankrunOracle';
import { BankrunProvider } from 'anchor-bankrun';

// ammInvariant == k == x * y
const mantissaSqrtScale = new BN(100_000);
const ammInitialQuoteAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);
const ammInitialBaseAssetReserve = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);

describe('velocityVaults', () => {
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

	let solPerpOracle: PublicKey;

	beforeEach(async () => {
		const context = await startAnchor('', [], []);

		// wrap the context to use it with the test helpers
		bankrunContextWrapper = new BankrunContextWrapper(context);

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
	});

	afterEach(async () => {
		await adminVelocityClient.unsubscribe();
		await adminClient.unsubscribe();
		await managerClient.unsubscribe();
		await managerVelocityClient.unsubscribe();
	});

	it('vaults initialized', async () => {
		const vault0 = await managerClient.program.account.vault.fetch(
			commonVaultKey
		);

		const newManager = Keypair.generate();
		await managerClient.managerUpdateVaultManager(
			commonVaultKey,
			newManager.publicKey,
			{ noLut: true }
		);

		const vault1 = await managerClient.program.account.vault.fetch(
			commonVaultKey
		);

		expect(vault0.manager.toString()).to.not.deep.equal(
			vault1.manager.toString()
		);
		expect(vault1.manager.toString()).to.deep.equal(
			newManager.publicKey.toString()
		);
	});
});
