import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { assert } from 'chai';
import { startAnchor } from 'solana-bankrun';
import { Keypair, SystemProgram } from '@solana/web3.js';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	BN,
	getTokenAmount,
	HotRole,
	MarketType,
	OracleSource,
	PositionDirection,
	SpotBalanceType,
	TestClient,
	TransferFeeAndPnlPoolDirection,
	ZERO,
} from '../../packages/sdk/src';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

// End-to-end coverage of the explicit fee-carveout system:
// FeeStructure numerators -> FeeLedger pending accrual at fill ->
// sweep_perp_market_fees materialization -> recipient-locked withdrawal.
describe('protocol fees', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;
	let solUsd;

	const MARKET_INDEX = 0;
	const AMM_FEE_NUMERATOR = 10; // 10% of the remainder provisioned to the AMM
	const IF_FEE_NUMERATOR = 50; // 50% to insurance; protocol residual = 40%

	// ammInvariant == k == x * y (same curve as tests/velocityClient.ts: $1 SOL)
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetAmount = new BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new BN(5 * 10 ** 13).mul(mantissaSqrtScale);

	const usdcAmount = new BN(200 * 10 ** 6);
	const depositAmount = new BN(10 * 10 ** 6);
	const feePoolSeed = new BN(100 * 10 ** 6);

	const readTokens = (pool: { scaledBalance: BN }) =>
		getTokenAmount(
			pool.scaledBalance,
			velocityClient.getSpotMarketAccount(0),
			SpotBalanceType.DEPOSIT
		);

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
			usdcAmount,
			bankrunContextWrapper
		);
		solUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			1,
			-7,
			undefined,
			10000
		);

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [MARKET_INDEX],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH_LAZER }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);

		await velocityClient.initializePerpMarket(
			MARKET_INDEX,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			new BN(60 * 60)
		);

		const feeStructure = velocityClient.getStateAccount().perpFeeStructure;
		feeStructure.ammFeeNumerator = AMM_FEE_NUMERATOR;
		feeStructure.ifFeeNumerator = IF_FEE_NUMERATOR;
		await velocityClient.updatePerpFeeStructure(feeStructure);

		await velocityClient.initializeUserAccountAndDepositCollateral(
			depositAmount,
			userUSDCAccount.publicKey
		);
		await velocityClient.fetchAccounts();
	});

	after(async () => {
		await velocityClient.unsubscribe();
	});

	it('accrues FeeLedger pendings per the fee-structure split on an AMM fill', async () => {
		await velocityClient.openPosition(
			PositionDirection.LONG,
			new BN(48000000000),
			MARKET_INDEX
		);
		await velocityClient.fetchAccounts();

		const market = velocityClient.getPerpMarketAccount(MARKET_INDEX);
		const ledger = market.feeLedger;
		const grossFee = ledger.totalExchangeFee;
		assert(grossFee.gt(ZERO), 'no taker fee recorded');

		// no referrer / maker / filler on a placeAndTake AMM fill, so the
		// entire gross fee is the remainder being split three ways
		const expectedAmm = grossFee.muln(AMM_FEE_NUMERATOR).divn(100);
		const expectedIf = grossFee.muln(IF_FEE_NUMERATOR).divn(100);
		const expectedProtocol = grossFee.sub(expectedAmm).sub(expectedIf);

		assert(
			ledger.ammProtocolFeesReceived.eq(expectedAmm),
			`amm tranche ${ledger.ammProtocolFeesReceived} != ${expectedAmm}`
		);
		assert(
			ledger.pendingAmmProvision.eq(expectedAmm),
			`pending amm provision ${ledger.pendingAmmProvision} != ${expectedAmm}`
		);
		assert(
			ledger.pendingIfFee.eq(expectedIf),
			`pending if ${ledger.pendingIfFee} != ${expectedIf}`
		);
		assert(
			ledger.pendingProtocolFee.eq(expectedProtocol),
			`pending protocol ${ledger.pendingProtocolFee} != ${expectedProtocol}`
		);
		assert(
			ledger.pendingProtocolFee
				.add(ledger.pendingIfFee)
				.add(ledger.ammProtocolFeesReceived)
				.eq(grossFee),
			'three-way split does not reconstruct the gross fee'
		);
		// the AMM's books contain ONLY its own money: the provision (+ any
		// spread surplus), never the protocol/IF carveouts
		const tfmd = market.amm.totalFeeMinusDistributions;
		assert(
			tfmd.gte(expectedAmm) && tfmd.lt(expectedAmm.add(grossFee)),
			`tfmd ${tfmd} should be the amm cut (+surplus), not the remainder`
		);
	});

	it('sweep_perp_market_fees materializes pendings out of the pnl pool', async () => {
		// exercise the per-market buffer-target setter (init default 250 QUOTE
		// would block this small sweep entirely)
		const bufferTarget = new BN(1 * 10 ** 6);
		await velocityClient.updatePerpMarketFeePoolBufferTarget(
			MARKET_INDEX,
			bufferTarget
		);

		// seed the pnl pool with real tokens — the sweep's source is the pnl
		// pool (where fee value lands as fills settle), never the AMM's pools
		await velocityClient.depositIntoPerpMarketFeePool(
			MARKET_INDEX,
			feePoolSeed,
			userUSDCAccount.publicKey
		);
		await velocityClient.transferFeeAndPnlPool(
			MARKET_INDEX,
			MARKET_INDEX,
			feePoolSeed,
			TransferFeeAndPnlPoolDirection.FEE_TO_PNL_POOL
		);
		await velocityClient.fetchAccounts();

		const before = velocityClient.getPerpMarketAccount(MARKET_INDEX);
		const pendingProtocolBefore = before.feeLedger.pendingProtocolFee;
		const pendingIfBefore = before.feeLedger.pendingIfFee;
		const pendingProvisionBefore = before.feeLedger.pendingAmmProvision;
		const ammReceivedBefore = before.feeLedger.ammProtocolFeesReceived;
		const tfmdBefore = before.amm.totalFeeMinusDistributions;
		const protocolPoolBefore = readTokens(before.protocolFeePool);
		const ammFeePoolBefore = readTokens(before.amm.feePool);
		const revenuePoolBefore = readTokens(
			velocityClient.getSpotMarketAccount(0).revenuePool
		);
		assert(
			pendingProtocolBefore.gt(ZERO) &&
				pendingIfBefore.gt(ZERO) &&
				pendingProvisionBefore.gt(ZERO)
		);

		await velocityClient.sweepPerpMarketFees(MARKET_INDEX);
		await velocityClient.fetchAccounts();

		const after = velocityClient.getPerpMarketAccount(MARKET_INDEX);
		assert(
			after.feeLedger.pendingProtocolFee.eq(ZERO),
			'pending protocol fee not fully swept'
		);
		assert(
			after.feeLedger.pendingIfFee.eq(ZERO),
			'pending if fee not fully swept'
		);
		assert(
			after.feeLedger.pendingAmmProvision.eq(ZERO),
			'pending amm provision not fully tokenized'
		);
		// the clawback cap is NOT touched by the sweep, and tokenization is
		// balance-only: the AMM's books were credited at fill
		assert(after.feeLedger.ammProtocolFeesReceived.eq(ammReceivedBefore));
		assert(after.amm.totalFeeMinusDistributions.eq(tfmdBefore));

		const protocolPoolDelta = readTokens(after.protocolFeePool).sub(
			protocolPoolBefore
		);
		assert(
			protocolPoolDelta.eq(pendingProtocolBefore),
			`protocol_fee_pool got ${protocolPoolDelta}, expected ${pendingProtocolBefore}`
		);

		const ifDelta = readTokens(
			velocityClient.getSpotMarketAccount(0).revenuePool
		).sub(revenuePoolBefore);
		assert(
			ifDelta.eq(pendingIfBefore),
			`revenue_pool got ${ifDelta}, expected ${pendingIfBefore}`
		);

		const provisionDelta = readTokens(after.amm.feePool).sub(ammFeePoolBefore);
		assert(
			provisionDelta.eq(pendingProvisionBefore),
			`amm fee_pool got ${provisionDelta}, expected ${pendingProvisionBefore}`
		);
	});

	it('withdraws protocol fees to the recipient ATA via the FeeWithdraw hot key', async () => {
		// fresh recipient with NO token account — the ix must init the ATA
		const recipient = Keypair.generate();
		const recipientTokenAccount = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			recipient.publicKey,
			true
		);

		await velocityClient.updateProtocolFeeRecipient(
			recipient.publicKey,
			MarketType.PERP
		);
		// wallet doubles as the FeeWithdraw hot key
		await velocityClient.updateHotAdmin(
			HotRole.FeeWithdraw,
			velocityClient.wallet.publicKey
		);
		await velocityClient.fetchAccounts();

		const before = velocityClient.getPerpMarketAccount(MARKET_INDEX);
		const poolTokens = readTokens(before.protocolFeePool);
		assert(poolTokens.gt(ZERO), 'nothing to withdraw');

		// over-request: the withdrawal must be capped to the pool's balance,
		// never reaching into depositor backing
		await velocityClient.withdrawProtocolFeesPerp(
			MARKET_INDEX,
			poolTokens.muln(2)
		);
		await velocityClient.fetchAccounts();

		const recipientBalance =
			await bankrunContextWrapper.connection.getTokenAccount(
				recipientTokenAccount
			);
		assert(
			new BN(Number(recipientBalance.amount)).eq(poolTokens),
			`recipient got ${recipientBalance.amount}, expected ${poolTokens} (capped)`
		);

		const after = velocityClient.getPerpMarketAccount(MARKET_INDEX);
		assert(
			readTokens(after.protocolFeePool).eq(ZERO),
			'protocol_fee_pool not drained'
		);
	});

	it('rejects a recipient account that is not protocol_fee_recipient', async () => {
		await velocityClient.fetchAccounts();

		// hand-craft the ix with the wallet (NOT the configured recipient) as
		// the ATA wallet — the address constraint must reject it
		const fakeRecipient = velocityClient.wallet.publicKey;
		const fakeRecipientTokenAccount = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			fakeRecipient,
			true
		);
		const perpMarket = velocityClient.getPerpMarketAccount(MARKET_INDEX);
		const quoteSpotMarket = velocityClient.getSpotMarketAccount(0);

		const ix =
			await velocityClient.program.instruction.withdrawProtocolFeesPerp(
				MARKET_INDEX,
				new BN(1),
				{
					accounts: {
						state: await velocityClient.getStatePublicKey(),
						payer: velocityClient.wallet.publicKey,
						authority: velocityClient.wallet.publicKey,
						perpMarket: perpMarket.pubkey,
						quoteSpotMarket: quoteSpotMarket.pubkey,
						spotMarketVault: quoteSpotMarket.vault,
						mint: quoteSpotMarket.mint,
						recipient: fakeRecipient,
						recipientTokenAccount: fakeRecipientTokenAccount,
						tokenProgram: TOKEN_PROGRAM_ID,
						velocitySigner: velocityClient.getSignerPublicKey(),
						systemProgram: SystemProgram.programId,
						associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
					},
				}
			);

		let threw = false;
		try {
			const tx = await velocityClient.buildTransaction(ix);
			await velocityClient.sendTransaction(tx, [], velocityClient.opts);
		} catch (e) {
			threw = true;
			assert(
				e.message.includes('custom program error') ||
					e.message.includes('InvalidProtocolFeeRecipient') ||
					e.message.includes('0x18d0'),
				`unexpected error: ${e.message}`
			);
		}
		assert(threw, 'withdrawal with a non-recipient wallet succeeded');
	});
});
