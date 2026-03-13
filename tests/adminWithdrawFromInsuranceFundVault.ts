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
	getInsuranceFundVaultPublicKey,
	getSpotMarketPublicKey,
} from '../sdk/src';
import {
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	overWriteSpotMarket,
	overWriteTokenAccountBalance,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import {
	BankrunContextWrapper,
	asBN,
} from '../sdk/src/bankrun/bankrunConnection';

// Snapshot of mainnet USDC spot market + IF vault accounts.
const prodUsdcIfAccounts = {
	spotMarket: {
		data: 'ZLEIa6hBQSdUX6MOo7w/PClm2otsPf7406t9pXygIypU5KAmT//Dwn4XAskDe6KnOB2fuc5t8V0PxU10u3MRn4rxLxkMDhW+xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHmsHZFgFFAI49uEcLfeyYJqqXqJL+++g9w+I4yK2cfD1VTREMgICAgICAgICAgICAgICAgICAgICAgICAgICAgBkIPAAAAAAAkAAAAAAAAABcAAAAAAAAAOEIPAAAAAAANQg8AAAAAAMJ4tGkAAAAAQEIPAAAAAABAQg8AAAAAAEBCDwAAAAAAQEIPAAAAAAAAAAAAAAAAANQYq6auAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHkMifZGT+FrLhfKfHFav7xo95PrVMA7wMfE+znV7oD4/jrxfADAAAAAAAAAAAAAE5Se7KYAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAABOb7RpAAAAABAOAAAAAAAAoIYBAFzBAAAAAAAAAAAAAAAAAAAAAAAAQgeVHE8AiQEAAAAAAAAAACOHVHTMGqsAAAAAAAAAAACWpPvLAgAAAAAAAAAAAAAAQQhSQAMAAAAAAAAAAAAAAKHgZsUAAAAAAAAAAAAAAABBQWfFAAAAAAAAAAAAAAAAAJAexLwWAAAAQGNSv8YBABWYUggDegAAB64CKYY9AACcyQcAAAAAAPd4tGkAAAAA93i0aQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAADLWMIAAAAAABAnAAAQJwAAECcAABAnAAAAAAAAAAAAAIgTAAAANQwAFM0AAKC7DQAGAAAAAAAADwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMFwEAAAAAAADpQcxrAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
	},
	insuranceFundVault: {
		data: 'xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWEEZ7mGBc7ZyTAt/Oa1N07PLdI1dDDYngPgNxsKbazaMEioNMXxDwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	},
};

/** The designated recipient pubkey enforced by the program (anchor-test feature). */
const IF_WITHDRAWAL_RECIPIENT = new PublicKey(
	'1ucYHAGrBbi1PaecC4Ptq5ocZLWGLBmbGWysoDGNB1N'
);

describe('admin withdraw from insurance fund vault', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint: Keypair;
	let solOracle: PublicKey;

	/** Recipient token account owned by the program-designated treasury. */
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
			oracleInfos: [{ publicKey: solOracle, source: OracleSource.PYTH }],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);

		// --- Clone production IF vault state into the test-derived accounts ---

		const spotMarketPk = await getSpotMarketPublicKey(
			chProgram.programId,
			QUOTE_SPOT_MARKET_INDEX
		);
		const ifVaultPk = await getInsuranceFundVaultPublicKey(
			chProgram.programId,
			QUOTE_SPOT_MARKET_INDEX
		);

		// Decode production spot market and graft its insuranceFund onto the test spot market,
		// replacing the vault pubkey with the test-derived address so SDK lookups stay consistent.
		const prodSpotMarketData = Buffer.from(
			prodUsdcIfAccounts.spotMarket.data,
			'base64'
		);
		const prodSpotMarket = chProgram.coder.accounts.decode(
			'SpotMarket',
			prodSpotMarketData
		);

		await driftClient.fetchAccounts();
		const testSpotMarket = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		testSpotMarket.insuranceFund = {
			...prodSpotMarket.insuranceFund,
			vault: ifVaultPk,
		};
		await overWriteSpotMarket(
			driftClient,
			bankrunContextWrapper,
			spotMarketPk,
			testSpotMarket
		);

		// Set the IF vault token balance to the production amount.
		const prodIfVaultData = Buffer.from(
			prodUsdcIfAccounts.insuranceFundVault.data,
			'base64'
		);
		const prodIfVaultAmount = prodIfVaultData.readBigUInt64LE(64);
		await overWriteTokenAccountBalance(
			bankrunContextWrapper,
			ifVaultPk,
			prodIfVaultAmount
		);

		await driftClient.fetchAccounts();

		// Recipient must be owned by the program-designated treasury pubkey.
		recipientUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			ZERO,
			bankrunContextWrapper,
			IF_WITHDRAWAL_RECIPIENT
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
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
		assert(recipientBalanceBefore.eq(ZERO), 'recipient should start with 0');

		const totalSharesBefore = spotMarket.insuranceFund.totalShares;
		const userSharesBefore = spotMarket.insuranceFund.userShares;
		const protocolSharesBefore = totalSharesBefore.sub(userSharesBefore);

		// Withdraw half of the protocol-owned portion of the vault (well within the
		// protocol_shares limit enforced by the program).
		const withdrawAmount = insuranceVaultAmountBefore
			.mul(protocolSharesBefore)
			.div(totalSharesBefore)
			.div(new BN(2));
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
		console.log('insurance vault after:', insuranceVaultAmountAfter.toString());

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
			`insurance vault should decrease by withdraw amount: expected ${insuranceVaultAmountBefore
				.sub(withdrawAmount)
				.toString()}, got ${insuranceVaultAmountAfter.toString()}`
		);

		assert(
			recipientBalanceAfter.eq(recipientBalanceBefore.add(withdrawAmount)),
			`recipient should receive the withdrawn amount: expected ${recipientBalanceBefore
				.add(withdrawAmount)
				.toString()}, got ${recipientBalanceAfter.toString()}`
		);

		await driftClient.fetchAccounts();
		const spotMarketAfter = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const protocolSharesAfter = spotMarketAfter.insuranceFund.totalShares.sub(
			spotMarketAfter.insuranceFund.userShares
		);
		console.log('protocol shares before:', protocolSharesBefore.toString());
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
