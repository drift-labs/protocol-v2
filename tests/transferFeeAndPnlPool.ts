import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { assert } from 'chai';
import { startAnchor } from 'solana-bankrun';
import {
	BN,
	getTokenAmount,
	SpotBalanceType,
	TestClient,
	TransferFeeAndPnlPoolDirection,
} from '../sdk/src';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { Keypair } from '@solana/web3.js';
import { createTransferCheckedInstruction } from '@solana/spl-token';

describe('transfer fee and pnl pool', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint: Keypair;

	const SOL_PERP = 0;
	const ETH_PERP = 2;

	const readFeePool = (marketIndex: number) =>
		getTokenAmount(
			driftClient.getPerpMarketAccount(marketIndex).amm.feePool.scaledBalance,
			driftClient.getSpotMarketAccount(0),
			SpotBalanceType.DEPOSIT
		);

	const readPnlPool = (marketIndex: number) =>
		getTokenAmount(
			driftClient.getPerpMarketAccount(marketIndex).pnlPool.scaledBalance,
			driftClient.getSpotMarketAccount(0),
			SpotBalanceType.DEPOSIT
		);

	const expectFail = async (fn: () => Promise<any>) => {
		try {
			await fn();
			assert.fail('Should have thrown');
		} catch (e) {
			assert(e.message.includes('custom program error'));
		}
	};

	before(async () => {
		const context = await startAnchor('', [], []);
		bankrunContextWrapper = new BankrunContextWrapper(context as any);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [SOL_PERP, ETH_PERP],
			spotMarketIndexes: [0],
			subAccountIds: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);

		const solOracle = await mockOracleNoProgram(bankrunContextWrapper, 150);
		const placeholderOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			1
		);
		const ethOracle = await mockOracleNoProgram(bankrunContextWrapper, 2500);

		const periodicity = new BN(3600);
		await driftClient.initializePerpMarket(
			SOL_PERP,
			solOracle,
			new BN(1000),
			new BN(1000),
			periodicity
		);
		await driftClient.initializePerpMarket(
			1,
			placeholderOracle,
			new BN(1000),
			new BN(1000),
			periodicity
		);
		await driftClient.initializePerpMarket(
			ETH_PERP,
			ethOracle,
			new BN(1000),
			new BN(1000),
			periodicity
		);

		await driftClient.fetchAccounts();

		const fundAmount = new BN(100 * 10 ** 6);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			fundAmount.muln(10),
			bankrunContextWrapper,
			driftClient.wallet.publicKey
		);

		const quoteVault = driftClient.getSpotMarketAccount(0).vault;
		const splTransferIx = createTransferCheckedInstruction(
			userUSDCAccount.publicKey,
			usdcMint.publicKey,
			quoteVault,
			driftClient.wallet.publicKey,
			fundAmount.muln(4).toNumber(),
			6
		);
		const tx = await driftClient.buildTransaction(splTransferIx);
		//@ts-ignore
		await driftClient.sendTransaction(tx);

		await driftClient.depositIntoPerpMarketFeePool(
			SOL_PERP,
			fundAmount,
			userUSDCAccount.publicKey
		);
		await driftClient.depositIntoPerpMarketFeePool(
			ETH_PERP,
			fundAmount,
			userUSDCAccount.publicKey
		);
		await driftClient.updatePerpMarketPnlPool(SOL_PERP, fundAmount);
		await driftClient.updatePerpMarketPnlPool(ETH_PERP, fundAmount);

		await driftClient.fetchAccounts();
	});

	const amt = new BN(1_000_000); // 1 USDC
	const hugeAmt = new BN(1_000_000_000_000);

	it('same market fee -> pnl', async () => {
		const feeBefore = readFeePool(SOL_PERP);
		const pnlBefore = readPnlPool(SOL_PERP);
		await driftClient.transferFeeAndPnlPool(
			SOL_PERP,
			SOL_PERP,
			amt,
			TransferFeeAndPnlPoolDirection.FEE_TO_PNL_POOL
		);
		await driftClient.fetchAccounts();
		assert(readFeePool(SOL_PERP).eq(feeBefore.sub(amt)));
		assert(readPnlPool(SOL_PERP).eq(pnlBefore.add(amt)));
	});

	it('same market pnl -> fee', async () => {
		const feeBefore = readFeePool(SOL_PERP);
		const pnlBefore = readPnlPool(SOL_PERP);
		await driftClient.transferFeeAndPnlPool(
			SOL_PERP,
			SOL_PERP,
			amt,
			TransferFeeAndPnlPoolDirection.PNL_TO_FEE_POOL
		);
		await driftClient.fetchAccounts();
		assert(readFeePool(SOL_PERP).eq(feeBefore.add(amt)));
		assert(readPnlPool(SOL_PERP).eq(pnlBefore.sub(amt)));
	});

	it('cross market fee pool SOL -> pnl pool ETH', async () => {
		const feeBefore = readFeePool(SOL_PERP);
		const pnlBefore = readPnlPool(ETH_PERP);
		await driftClient.transferFeeAndPnlPool(
			SOL_PERP,
			ETH_PERP,
			amt,
			TransferFeeAndPnlPoolDirection.FEE_TO_PNL_POOL
		);
		await driftClient.fetchAccounts();
		assert(readFeePool(SOL_PERP).eq(feeBefore.sub(amt)));
		assert(readPnlPool(ETH_PERP).eq(pnlBefore.add(amt)));
	});

	it('cross market pnl pool ETH -> fee pool SOL', async () => {
		const feeBefore = readFeePool(SOL_PERP);
		const pnlBefore = readPnlPool(ETH_PERP);
		await driftClient.transferFeeAndPnlPool(
			SOL_PERP,
			ETH_PERP,
			amt,
			TransferFeeAndPnlPoolDirection.PNL_TO_FEE_POOL
		);
		await driftClient.fetchAccounts();
		assert(readFeePool(SOL_PERP).eq(feeBefore.add(amt)));
		assert(readPnlPool(ETH_PERP).eq(pnlBefore.sub(amt)));
	});

	it('cross market fee pool ETH -> pnl pool SOL', async () => {
		const feeBefore = readFeePool(ETH_PERP);
		const pnlBefore = readPnlPool(SOL_PERP);
		await driftClient.transferFeeAndPnlPool(
			ETH_PERP,
			SOL_PERP,
			amt,
			TransferFeeAndPnlPoolDirection.FEE_TO_PNL_POOL
		);
		await driftClient.fetchAccounts();
		assert(readFeePool(ETH_PERP).eq(feeBefore.sub(amt)));
		assert(readPnlPool(SOL_PERP).eq(pnlBefore.add(amt)));
	});

	it('cross market pnl pool SOL -> fee pool ETH', async () => {
		const feeBefore = readFeePool(ETH_PERP);
		const pnlBefore = readPnlPool(SOL_PERP);
		await driftClient.transferFeeAndPnlPool(
			ETH_PERP,
			SOL_PERP,
			amt,
			TransferFeeAndPnlPoolDirection.PNL_TO_FEE_POOL
		);
		await driftClient.fetchAccounts();
		assert(readFeePool(ETH_PERP).eq(feeBefore.add(amt)));
		assert(readPnlPool(SOL_PERP).eq(pnlBefore.sub(amt)));
	});

	it('rejects oversized fee -> pnl same market', async () => {
		await expectFail(() =>
			driftClient.transferFeeAndPnlPool(
				SOL_PERP,
				SOL_PERP,
				hugeAmt,
				TransferFeeAndPnlPoolDirection.FEE_TO_PNL_POOL
			)
		);
	});

	it('rejects oversized pnl -> fee same market', async () => {
		await expectFail(() =>
			driftClient.transferFeeAndPnlPool(
				SOL_PERP,
				SOL_PERP,
				hugeAmt,
				TransferFeeAndPnlPoolDirection.PNL_TO_FEE_POOL
			)
		);
	});

	it('rejects oversized fee -> pnl cross market', async () => {
		await expectFail(() =>
			driftClient.transferFeeAndPnlPool(
				SOL_PERP,
				ETH_PERP,
				hugeAmt,
				TransferFeeAndPnlPoolDirection.FEE_TO_PNL_POOL
			)
		);
	});

	it('rejects oversized pnl -> fee cross market', async () => {
		await expectFail(() =>
			driftClient.transferFeeAndPnlPool(
				SOL_PERP,
				ETH_PERP,
				hugeAmt,
				TransferFeeAndPnlPoolDirection.PNL_TO_FEE_POOL
			)
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});
});
