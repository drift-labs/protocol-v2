import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { assert } from 'chai';
import { startAnchor } from 'solana-bankrun';
import { Keypair, PublicKey } from '@solana/web3.js';

import {
	BN,
	BASE_PRECISION,
	getMarketOrderParams,
	MarketStatus,
	OracleSource,
	PEG_PRECISION,
	PositionDirection,
	QUOTE_SPOT_MARKET_INDEX,
	SpecialUserStatus,
	TestClient,
} from '../../packages/sdk/src';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';
import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

describe('special user account', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let adminClient: TestClient;
	let velocityClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint;
	let userAccountPublicKey: PublicKey;
	let userSubaccount1PublicKey: PublicKey;
	let userUSDCAccount: Keypair;

	const usdcAmount = new BN(20 * 10 ** 6);
	const marketIndex = 0;
	const initialSolPrice = 50;
	const ammInitialQuoteAssetAmount = new BN(2 * 10 ** 9).mul(new BN(10 ** 5));
	const ammInitialBaseAssetAmount = new BN(2 * 10 ** 9).mul(new BN(10 ** 5));
	let solUsdOracle: PublicKey;

	const expectFail = async (fn: () => Promise<unknown>) => {
		try {
			await fn();
			assert.fail('Should have thrown');
		} catch (e) {
			const err = e as Error;
			assert(err.message.includes('custom program error'));
		}
	};

	const placePerpMarketOrder = async (
		direction: PositionDirection,
		baseAssetAmount: BN
	) => {
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		await velocityClient.placeAndTakePerpOrder(orderParams);
	};

	const flattenPosition = async (subAccountId = 0) => {
		const position = velocityClient
			.getUser(subAccountId)
			.getPerpPosition(marketIndex).baseAssetAmount;

		if (position.eq(new BN(0))) {
			return;
		}

		await velocityClient.switchActiveUser(subAccountId);
		await placePerpMarketOrder(
			position.gt(new BN(0)) ? PositionDirection.SHORT : PositionDirection.LONG,
			position.abs()
		);
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
		solUsdOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			initialSolPrice,
			-10,
			0.0005,
			10000
		);

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			txVersion: 'legacy',
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{ publicKey: solUsdOracle, source: OracleSource.PYTH_LAZER },
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		adminClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{ publicKey: solUsdOracle, source: OracleSource.PYTH_LAZER },
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();
		await adminClient.subscribe();

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(0);
		const periodicity = new BN(60 * 60);
		await velocityClient.initializePerpMarket(
			marketIndex,
			solUsdOracle,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(initialSolPrice).mul(PEG_PRECISION)
		);
		await velocityClient.updatePerpMarketStatus(
			marketIndex,
			MarketStatus.ACTIVE
		);

		await velocityClient.initializeUserAccount();
		userAccountPublicKey = await velocityClient.getUserAccountPublicKey();
		await velocityClient.initializeUserAccount(1);
		userSubaccount1PublicKey = await velocityClient.getUserAccountPublicKey(1);

		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.muln(2),
			bankrunContextWrapper,
			velocityClient.wallet.publicKey
		);
		await velocityClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);
		await velocityClient.switchActiveUser(1);
		await velocityClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);
		await velocityClient.switchActiveUser(0);

		await velocityClient.fetchAccounts();
	});

	after(async () => {
		await adminClient.unsubscribe();
		await velocityClient.unsubscribe();
	});

	it('defaults to no special status', async () => {
		await velocityClient.fetchAccounts();
		const userAccount = velocityClient.getUserAccount();
		assert(userAccount.specialUserStatus === 0);
	});

	it('sets vamm hedger flag', async () => {
		await adminClient.updateSpecialUserStatus(
			userAccountPublicKey,
			SpecialUserStatus.VAMM_HEDGER
		);
		await velocityClient.fetchAccounts();
		const userAccount = velocityClient.getUserAccount();
		assert(userAccount.specialUserStatus === SpecialUserStatus.VAMM_HEDGER);
	});

	it('clears special status back to zero', async () => {
		await adminClient.updateSpecialUserStatus(userAccountPublicKey, 0);
		await velocityClient.fetchAccounts();
		const userAccount = velocityClient.getUserAccount();
		assert(userAccount.specialUserStatus === 0);
	});

	it('rejects unknown status bits', async () => {
		let threw = false;
		try {
			await adminClient.updateSpecialUserStatus(userAccountPublicKey, 0xff);
		} catch (e) {
			threw = true;
		}
		assert(threw, 'should have thrown for invalid special user status bits');
	});

	it('fails transfer when user is not flagged special', async () => {
		await adminClient.updateSpecialUserStatus(userAccountPublicKey, 0);
		await placePerpMarketOrder(PositionDirection.LONG, BASE_PRECISION);
		await velocityClient.fetchAccounts();

		const userPositionBeforeTransfer = velocityClient
			.getUser()
			.getPerpPosition(marketIndex);

		assert(
			userPositionBeforeTransfer.baseAssetAmount.gt(new BN(0)),
			'user position should exist after placing long order'
		);

		await expectFail(() =>
			velocityClient.specialTransferPerpPositionToVamm(
				userAccountPublicKey,
				marketIndex
			)
		);

		await flattenPosition(0);
		await velocityClient.fetchAccounts();
	});

	it('fails transfer when position would increase vamm exposure', async () => {
		await adminClient.updateSpecialUserStatus(
			userAccountPublicKey,
			SpecialUserStatus.VAMM_HEDGER
		);
		await placePerpMarketOrder(PositionDirection.LONG, BASE_PRECISION.divn(2));
		await velocityClient.fetchAccounts();

		const userSubaccount0PositionBeforeInvalidTransfer = velocityClient
			.getUser(0)
			.getPerpPosition(marketIndex);

		assert(
			userSubaccount0PositionBeforeInvalidTransfer.baseAssetAmount.gt(
				new BN(0)
			),
			'subaccount 0 position should exist after placing long order'
		);

		await velocityClient.switchActiveUser(1);
		await adminClient.updateSpecialUserStatus(
			userSubaccount1PublicKey,
			SpecialUserStatus.VAMM_HEDGER
		);
		await placePerpMarketOrder(PositionDirection.SHORT, BASE_PRECISION.divn(4));
		await velocityClient.fetchAccounts();

		const marketBeforeInvalidTransfer =
			velocityClient.getPerpMarketAccount(marketIndex);

		const userSubaccount1PositionBeforeInvalidTransfer = velocityClient
			.getUser(1)
			.getPerpPosition(marketIndex);

		assert(
			userSubaccount1PositionBeforeInvalidTransfer.baseAssetAmount.lt(
				new BN(0)
			),
			'subaccount 1 position should exist after placing short order'
		);

		assert(
			marketBeforeInvalidTransfer.amm.baseAssetAmountWithAmm.gt(new BN(0)),
			'expected positive baseAssetAmountWithAmm before invalid transfer'
		);

		await expectFail(() =>
			velocityClient.specialTransferPerpPositionToVamm(
				userSubaccount1PublicKey,
				marketIndex
			)
		);

		await velocityClient.fetchAccounts();

		const marketAfterInvalidTransfer =
			velocityClient.getPerpMarketAccount(marketIndex);
		const userSubaccount1PositionAfterInvalidTransfer = velocityClient
			.getUser(1)
			.getPerpPosition(marketIndex);

		assert(
			marketAfterInvalidTransfer.amm.baseAssetAmountWithAmm.eq(
				marketBeforeInvalidTransfer.amm.baseAssetAmountWithAmm
			),
			'baseAssetAmountWithAmm should be unchanged when transfer fails'
		);
		assert(
			userSubaccount1PositionAfterInvalidTransfer.baseAssetAmount.eq(
				userSubaccount1PositionBeforeInvalidTransfer.baseAssetAmount
			),
			'user position should be unchanged when transfer fails'
		);

		await velocityClient.switchActiveUser(0);
		await flattenPosition(0);
		await velocityClient.switchActiveUser(1);
		await flattenPosition(1);
		await velocityClient.switchActiveUser(0);
		await velocityClient.fetchAccounts();
	});

	it('transfers 50% of position when amount is provided', async () => {
		await adminClient.updateSpecialUserStatus(
			userAccountPublicKey,
			SpecialUserStatus.VAMM_HEDGER
		);

		await placePerpMarketOrder(PositionDirection.LONG, BASE_PRECISION);
		await velocityClient.fetchAccounts();
		const userPositionAfterPlace = velocityClient
			.getUser()
			.getPerpPosition(marketIndex);
		assert(
			userPositionAfterPlace.baseAssetAmount.gt(new BN(0)),
			'user position should exist after placing long order'
		);

		const halfPosition = BASE_PRECISION.divn(2);
		const userPositionBeforeTransfer = userPositionAfterPlace;
		const marketBeforeTransfer =
			velocityClient.getPerpMarketAccount(marketIndex);

		await velocityClient.specialTransferPerpPositionToVamm(
			userAccountPublicKey,
			marketIndex,
			halfPosition
		);
		await velocityClient.fetchAccounts();

		const userPositionAfterTransfer = velocityClient
			.getUser()
			.getPerpPosition(marketIndex);
		assert(
			userPositionAfterTransfer.baseAssetAmount.eq(
				userPositionBeforeTransfer.baseAssetAmount.sub(halfPosition)
			),
			'special user position should be reduced by transfer amount'
		);

		const marketAfterTransfer =
			velocityClient.getPerpMarketAccount(marketIndex);
		assert(
			marketAfterTransfer.amm.baseAssetAmountWithAmm.eq(
				marketBeforeTransfer.amm.baseAssetAmountWithAmm.sub(halfPosition)
			),
			'baseAssetAmountWithAmm should be reduced by transfer amount'
		);

		await velocityClient.specialTransferPerpPositionToVamm(
			userAccountPublicKey,
			marketIndex
		);
		await velocityClient.fetchAccounts();

		const userPositionAfterFullTransfer = velocityClient
			.getUser()
			.getPerpPosition(marketIndex);
		assert(
			userPositionAfterFullTransfer.baseAssetAmount.eq(new BN(0)),
			'user should have no remaining perp position after full transfer'
		);
		assert(
			userPositionAfterFullTransfer.openOrders === 0,
			'user perp position should be effectively removed after full transfer'
		);
	});
});
