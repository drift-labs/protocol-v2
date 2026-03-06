import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
	TestClient,
	BN,
	OracleSource,
	QUOTE_SPOT_MARKET_INDEX,
	ZERO,
	getTokenAmount,
	SpotBalanceType,
} from '../sdk/src';
import {
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	mockOracleNoProgram,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import {
	BankrunContextWrapper,
	asBN,
} from '../sdk/src/bankrun/bankrunConnection';

describe('admin withdraw from insurance fund vault', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;
	let solOracle: PublicKey;

	const usdcAmount = new BN(1_000_000 * 10 ** 6);

	let secondUserDriftClient: TestClient;
	let secondUserDriftClientWSOLAccount: PublicKey;
	let secondUserDriftClientUSDCAccount: PublicKey;

	const solAmount = new BN(10_000 * 10 ** 9);

	let recipientKeypair: Keypair;
	let recipientUSDCAccount: Keypair;

	before(async () => {
		const context = await startAnchor('', [], []);
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)),
			bankrunContextWrapper
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 22500);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{ publicKey: solOracle, source: OracleSource.PYTH },
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);

		const subAccountId = 0;
		const name = 'ADMIN';
		await driftClient.initializeUserAccount(subAccountId, name);
		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		recipientKeypair = Keypair.generate();
		recipientUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			ZERO,
			bankrunContextWrapper,
			recipientKeypair.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		if (secondUserDriftClient) {
			await secondUserDriftClient.unsubscribe();
		}
	});

	it('set up borrow to generate revenue', async () => {
		await driftClient.updateSpotMarketIfFactor(
			QUOTE_SPOT_MARKET_INDEX,
			new BN(90_000),
			new BN(100_000)
		);

		[
			secondUserDriftClient,
			secondUserDriftClientWSOLAccount,
			secondUserDriftClientUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			solAmount,
			ZERO,
			[],
			[0, 1],
			[{ publicKey: solOracle, source: OracleSource.PYTH }],
			bulkAccountLoader
		);

		await secondUserDriftClient.deposit(
			solAmount,
			1,
			secondUserDriftClientWSOLAccount
		);

		const withdrawAmount = usdcAmount.div(new BN(2));
		await secondUserDriftClient.withdraw(
			withdrawAmount,
			QUOTE_SPOT_MARKET_INDEX,
			secondUserDriftClientUSDCAccount
		);

		await driftClient.fetchAccounts();
		const spotMarket = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);
		assert(spotMarket.borrowBalance.gt(ZERO));
	});

	it('accrue interest and settle revenue to insurance fund', async () => {
		await bankrunContextWrapper.moveTimeForward(3600);

		await driftClient.updateSpotMarketCumulativeInterest(
			QUOTE_SPOT_MARKET_INDEX
		);

		await driftClient.fetchAccounts();
		let spotMarket = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const revenuePoolBalance = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		console.log('revenue pool balance:', revenuePoolBalance.toString());
		assert(revenuePoolBalance.gt(ZERO), 'revenue pool must have balance after interest accrual');

		await driftClient.updateSpotMarketRevenueSettlePeriod(
			QUOTE_SPOT_MARKET_INDEX,
			new BN(1)
		);

		const txSig = await driftClient.settleRevenueToInsuranceFund(
			QUOTE_SPOT_MARKET_INDEX
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		spotMarket = driftClient.getSpotMarketAccount(QUOTE_SPOT_MARKET_INDEX);

		const protocolShares = spotMarket.insuranceFund.totalShares.sub(
			spotMarket.insuranceFund.userShares
		);
		console.log('protocol IF shares:', protocolShares.toString());
		console.log(
			'total IF shares:',
			spotMarket.insuranceFund.totalShares.toString()
		);
		console.log(
			'user IF shares:',
			spotMarket.insuranceFund.userShares.toString()
		);
		assert(protocolShares.gt(ZERO), 'protocol must own IF shares');
	});

	it('admin withdraws from insurance fund vault to recipient', async () => {
		await driftClient.fetchAccounts();
		const spotMarket = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const insuranceFundVault = spotMarket.insuranceFund.vault;

		const insuranceVaultAmountBefore = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					insuranceFundVault
				)
			).amount
		);
		console.log(
			'insurance vault before:',
			insuranceVaultAmountBefore.toString()
		);
		assert(
			insuranceVaultAmountBefore.gt(ZERO),
			'insurance vault must have tokens'
		);

		const recipientBalanceBefore = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					recipientUSDCAccount.publicKey
				)
			).amount
		);
		assert(
			recipientBalanceBefore.eq(ZERO),
			'recipient should start with 0'
		);

		const totalSharesBefore = spotMarket.insuranceFund.totalShares;
		const userSharesBefore = spotMarket.insuranceFund.userShares;
		const protocolSharesBefore = totalSharesBefore.sub(userSharesBefore);

		const withdrawAmount = insuranceVaultAmountBefore.div(new BN(2));
		console.log('withdraw amount:', withdrawAmount.toString());
		assert(withdrawAmount.gt(ZERO), 'withdraw amount must be > 0');

		const txSig = await driftClient.adminWithdrawFromInsuranceFundVault(
			QUOTE_SPOT_MARKET_INDEX,
			withdrawAmount,
			recipientUSDCAccount.publicKey
		);
		bankrunContextWrapper.printTxLogs(txSig);

		const insuranceVaultAmountAfter = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					insuranceFundVault
				)
			).amount
		);
		console.log(
			'insurance vault after:',
			insuranceVaultAmountAfter.toString()
		);

		const recipientBalanceAfter = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					recipientUSDCAccount.publicKey
				)
			).amount
		);
		console.log('recipient balance after:', recipientBalanceAfter.toString());

		assert(
			insuranceVaultAmountAfter.eq(
				insuranceVaultAmountBefore.sub(withdrawAmount)
			),
			`insurance vault should decrease by withdraw amount: expected ${insuranceVaultAmountBefore.sub(withdrawAmount).toString()}, got ${insuranceVaultAmountAfter.toString()}`
		);

		assert(
			recipientBalanceAfter.eq(
				recipientBalanceBefore.add(withdrawAmount)
			),
			`recipient should receive the withdrawn amount: expected ${recipientBalanceBefore.add(withdrawAmount).toString()}, got ${recipientBalanceAfter.toString()}`
		);

		await driftClient.fetchAccounts();
		const spotMarketAfter = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const protocolSharesAfter = spotMarketAfter.insuranceFund.totalShares.sub(
			spotMarketAfter.insuranceFund.userShares
		);
		console.log(
			'protocol shares before:',
			protocolSharesBefore.toString()
		);
		console.log('protocol shares after:', protocolSharesAfter.toString());
		assert(
			protocolSharesAfter.lt(protocolSharesBefore),
			'protocol shares should decrease after withdrawal'
		);

		assert(
			spotMarketAfter.insuranceFund.userShares.eq(userSharesBefore),
			'user shares should remain unchanged'
		);
	});
});
