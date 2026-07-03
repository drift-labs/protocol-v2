/**
 * AdminClient — governance and protocol administration instruction builders.
 * Extends `VelocityClient`; all trading/keeper methods are also available.
 *
 * Covers: perp/spot market initialization and updates, oracle guard rail config,
 * fee structure updates, insurance fund operations, vault management, IF rebalancing,
 * pause/unpause exchange, and all admin instruction handlers in `instructions/admin.rs`.
 *
 * Most methods require a specific admin tier, enforced on-chain by `state.cold_admin` /
 * `state.warm_admin` / per-role `state.hot_*` keys (see `programs/velocity/src/auth.rs`).
 * Tiers are additive — cold ⊇ warm ⊇ hot(role) — so the cold admin can always call a
 * warm- or hot-gated instruction. Each method's doc below states the minimum tier
 * required by the on-chain constraint; passing a lower-tier wallet fails the transaction
 * with `Unauthorized`, not client-side.
 */
import {
	AccountMeta,
	AddressLookupTableAccount,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	SYSVAR_RENT_PUBKEY,
	TransactionInstruction,
	TransactionSignature,
} from '@solana/web3.js';
import {
	FeeStructure,
	OracleGuardRails,
	OracleSource,
	ExchangeStatus,
	SolvencyStatus,
	MarketStatus,
	ContractTier,
	AssetTier,
	TxParams,
	AddAmmConstituentMappingDatum,
	SwapReduceOnly,
	InitializeConstituentParams,
	ConstituentStatus,
	LPPoolAccount,
	TransferFeeAndPnlPoolDirection,
	MarketType,
	SpotMarketAccount,
} from './types';
import { DEFAULT_MARKET_NAME, encodeName } from './userName';
import { BN } from './isomorphic/anchor';
import * as anchor from './isomorphic/anchor';
import {
	getVelocityStateAccountPublicKeyAndNonce,
	getSpotMarketPublicKey,
	getSpotMarketVaultPublicKey,
	getPerpMarketPublicKey,
	getInsuranceFundVaultPublicKey,
	getPrelaunchOraclePublicKey,
	getUserStatsAccountPublicKey,
	getPythLazerOraclePublicKey,
	getTokenProgramForSpotMarket,
	getLpPoolPublicKey,
	getAmmConstituentMappingPublicKey,
	getConstituentTargetBasePublicKey,
	getConstituentPublicKey,
	getConstituentVaultPublicKey,
	getAmmCachePublicKey,
	getLpPoolTokenVaultPublicKey,
	getVelocitySignerPublicKey,
	getConstituentCorrelationsPublicKey,
} from './addresses/pda';
import { squareRootBN } from './math/utils';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	createInitializeMint2Instruction,
	createMintToInstruction,
	createTransferCheckedInstruction,
	getAssociatedTokenAddressSync,
	MINT_SIZE,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { VelocityClient } from './velocityClient';
import {
	PEG_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	ZERO,
	ONE,
	BASE_PRECISION,
	PRICE_PRECISION,
} from './constants/numericConstants';
import { calculateTargetPriceTrade } from './math/trade';
import { calculateAmmReservesAfterSwap, getSwapDirection } from './math/amm';
import { JupiterClient, QuoteResponse } from './jupiter/jupiterClient';
import { SwapMode } from './swap/UnifiedSwapClient';

export class AdminClient extends VelocityClient {
	/**
	 * Creates the protocol's singleton `State` account (one-time setup). Fails client-side
	 * if `State` already exists. On a real mainnet build the on-chain `Initialize` accounts
	 * struct additionally locks the signer to `ids::state_init_authority` so the one-time
	 * init cannot be front-run; on devnet/localnet or the `anchor-test` build any signer may
	 * call it. Seeds `cold_admin` and `warm_admin` to the calling wallet and `pause_admin` to
	 * the default (unassigned) pubkey — rotate them afterward via `updateAdmin` /
	 * `updateWarmAdmin` / `updatePauseAdmin`.
	 * @param usdcMint - Mint of the protocol's quote asset (must have 6 decimals; becomes
	 *   `state.quoteAssetMint`).
	 * @param _adminControlsPrices - Unused; retained for call-site compatibility.
	 * @returns Tuple containing the transaction signature.
	 */
	public async initialize(
		usdcMint: PublicKey,
		_adminControlsPrices: boolean
	): Promise<[TransactionSignature]> {
		const stateAccountRPCResponse = await this.connection.getParsedAccountInfo(
			await this.getStatePublicKey()
		);
		if (stateAccountRPCResponse.value !== null) {
			throw new Error('Clearing house already initialized');
		}

		const [velocityStatePublicKey] =
			await getVelocityStateAccountPublicKeyAndNonce(this.program.programId);

		const initializeIx = await this.program.instruction.initialize({
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: velocityStatePublicKey,
				quoteAssetMint: usdcMint,
				rent: SYSVAR_RENT_PUBKEY,
				velocitySigner: this.getSignerPublicKey(),
				systemProgram: anchor.web3.SystemProgram.programId,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});

		const tx = await this.buildTransaction(initializeIx);

		const { txSig } = await super.sendTransaction(tx, [], this.opts);

		return [txSig];
	}

	/**
	 * Initializes a new spot market: creates the `SpotMarket` PDA plus its token vault and
	 * insurance-fund vault, and appends it at `state.numberOfSpotMarkets` (or `marketIndex`
	 * if explicitly supplied — the on-chain handler asserts it matches the next sequential
	 * index). Requires warm admin (`check_warm`); if `activeStatus` is `true` the on-chain
	 * handler additionally requires the **cold** admin specifically (a market cannot be
	 * launched active by a warm-only signer). For `oracleSource: QuoteAsset` (used only for
	 * the index-0 quote market), `oracle` must be `PublicKey.default`.
	 * @param mint - Spot market's token mint. Must have >= 5 decimals (exactly 6 for the
	 *   quote/index-0 market).
	 * @param optimalUtilization - Utilization at the borrow-rate kink, SPOT_UTILIZATION_PRECISION (1e6, 100% = 1e6).
	 * @param optimalRate - Borrow rate at `optimalUtilization`, SPOT_RATE_PRECISION (1e6, 100% APR = 1e6).
	 * @param maxRate - Borrow rate at 100% utilization, SPOT_RATE_PRECISION (1e6).
	 * @param oracle - Oracle account for this market's price feed (`PublicKey.default` for `OracleSource.QuoteAsset`).
	 * @param oracleSource - Oracle provider/format for `oracle`.
	 * @param initialAssetWeight - Initial (deposit) asset weight, SPOT_WEIGHT_PRECISION (1e4, 100% = 1e4).
	 * @param maintenanceAssetWeight - Maintenance asset weight, SPOT_WEIGHT_PRECISION (1e4).
	 * @param initialLiabilityWeight - Initial (borrow) liability weight, SPOT_WEIGHT_PRECISION (1e4).
	 * @param maintenanceLiabilityWeight - Maintenance liability weight, SPOT_WEIGHT_PRECISION (1e4).
	 * @param imfFactor - Increases weight penalty as position size grows, SPOT_IMF_PRECISION (1e6). Default 0.
	 * @param liquidatorFee - Fee paid to liquidators, LIQUIDATION_FEE_PRECISION (1e6). Default 0.
	 * @param ifLiquidationFee - Portion of the liquidation fee routed to the insurance fund, LIQUIDATION_FEE_PRECISION (1e6). Default 0.
	 * @param activeStatus - If `true`, market is `Active` immediately; otherwise `Initialized` (trading disabled until a later status update). Requires cold admin when `true`. Default `true`.
	 * @param assetTier - Collateral tier gating cross-margin usability. Default `AssetTier.COLLATERAL`.
	 * @param scaleInitialAssetWeightStart - Deposit-token-amount threshold, QUOTE_PRECISION (1e6) equivalent notional, above which `initialAssetWeight` scales down. Default 0 (disabled).
	 * @param withdrawGuardThreshold - Token-amount threshold, market's native decimals, above which large single withdraws/borrows are blocked. Default 0.
	 * @param orderTickSize - Minimum price increment for spot orders, PRICE_PRECISION (1e6). Default 1.
	 * @param orderStepSize - Minimum base size increment for spot orders, market's native decimals. Also seeds `minOrderSize`. Default 1.
	 * @param ifTotalFactor - Insurance fund fee share of the total spot fee, IF_FACTOR_PRECISION (1e6). Default 0.
	 * @param name - Market display name, UTF-8 encoded and padded/truncated to 32 bytes. Default `DEFAULT_MARKET_NAME`.
	 * @param marketIndex - Explicit spot market index; defaults to `state.numberOfSpotMarkets` (the next free slot) when omitted.
	 * @returns Transaction signature.
	 */
	public async initializeSpotMarket(
		mint: PublicKey,
		optimalUtilization: number,
		optimalRate: number,
		maxRate: number,
		oracle: PublicKey,
		oracleSource: OracleSource,
		initialAssetWeight: number,
		maintenanceAssetWeight: number,
		initialLiabilityWeight: number,
		maintenanceLiabilityWeight: number,
		imfFactor = 0,
		liquidatorFee = 0,
		ifLiquidationFee = 0,
		activeStatus = true,
		assetTier = AssetTier.COLLATERAL,
		scaleInitialAssetWeightStart = ZERO,
		withdrawGuardThreshold = ZERO,
		orderTickSize = ONE,
		orderStepSize = ONE,
		ifTotalFactor = 0,
		name = DEFAULT_MARKET_NAME,
		marketIndex?: number
	): Promise<TransactionSignature> {
		const spotMarketIndex =
			marketIndex ?? this.getStateAccount().numberOfSpotMarkets;

		const initializeIx = await this.getInitializeSpotMarketIx(
			mint,
			optimalUtilization,
			optimalRate,
			maxRate,
			oracle,
			oracleSource,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			imfFactor,
			liquidatorFee,
			ifLiquidationFee,
			activeStatus,
			assetTier,
			scaleInitialAssetWeightStart,
			withdrawGuardThreshold,
			orderTickSize,
			orderStepSize,
			ifTotalFactor,
			name,
			marketIndex
		);

		const tx = await this.buildTransaction(initializeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		await this.accountSubscriber.addSpotMarket(spotMarketIndex);
		await this.accountSubscriber.addOracle({
			source: oracleSource,
			publicKey: oracle,
		});
		await this.accountSubscriber.setSpotOracleMap();

		return txSig;
	}

	/**
	 * Builds the `initializeSpotMarket` instruction without sending it. See `initializeSpotMarket`
	 * for parameter units and the cold-admin-if-`activeStatus` rule. Looks up `mint`'s owning
	 * token program on-chain (throws if the mint account doesn't exist) and resolves the admin
	 * signer to `wallet.publicKey` when `useHotWalletAdmin` is set, otherwise to `state.coldAdmin`
	 * (or the wallet if not yet subscribed).
	 * @returns The unsigned `initializeSpotMarket` instruction.
	 */
	public async getInitializeSpotMarketIx(
		mint: PublicKey,
		optimalUtilization: number,
		optimalRate: number,
		maxRate: number,
		oracle: PublicKey,
		oracleSource: OracleSource,
		initialAssetWeight: number,
		maintenanceAssetWeight: number,
		initialLiabilityWeight: number,
		maintenanceLiabilityWeight: number,
		imfFactor = 0,
		liquidatorFee = 0,
		ifLiquidationFee = 0,
		activeStatus = true,
		assetTier = AssetTier.COLLATERAL,
		scaleInitialAssetWeightStart = ZERO,
		withdrawGuardThreshold = ZERO,
		orderTickSize = ONE,
		orderStepSize = ONE,
		ifTotalFactor = 0,
		name = DEFAULT_MARKET_NAME,
		marketIndex?: number
	): Promise<TransactionInstruction> {
		const spotMarketIndex =
			marketIndex ?? this.getStateAccount().numberOfSpotMarkets;
		const spotMarket = await getSpotMarketPublicKey(
			this.program.programId,
			spotMarketIndex
		);

		const spotMarketVault = await getSpotMarketVaultPublicKey(
			this.program.programId,
			spotMarketIndex
		);

		const insuranceFundVault = await getInsuranceFundVaultPublicKey(
			this.program.programId,
			spotMarketIndex
		);

		const mintAccountInfo = await this.connection.getAccountInfo(mint);
		if (!mintAccountInfo) {
			throw new Error(`Mint account ${mint.toString()} not found`);
		}
		const tokenProgram = mintAccountInfo.owner;

		const nameBuffer = encodeName(name);
		const initializeIx = await this.program.instruction.initializeSpotMarket(
			optimalUtilization,
			optimalRate,
			maxRate,
			oracleSource,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			imfFactor,
			liquidatorFee,
			ifLiquidationFee,
			activeStatus,
			assetTier,
			scaleInitialAssetWeightStart,
			withdrawGuardThreshold,
			orderTickSize,
			orderStepSize,
			ifTotalFactor,
			nameBuffer,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket,
					spotMarketVault,
					insuranceFundVault,
					velocitySigner: this.getSignerPublicKey(),
					spotMarketMint: mint,
					oracle,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					tokenProgram,
				},
			}
		);

		return initializeIx;
	}

	/**
	 * Closes a mis-initialized spot market and refunds rent to the admin. Requires warm admin
	 * (`check_warm`). On-chain the handler only allows deleting the **most recently created**
	 * market (`marketIndex == state.numberOfSpotMarkets - 1`), still in `Initialized` status
	 * (never activated), with zero deposit and borrow balances and empty vaults — otherwise it
	 * throws `InvalidMarketAccountforDeletion`.
	 * @param marketIndex - Index of the spot market to delete; must be the last-created, unactivated, empty market.
	 * @returns Transaction signature.
	 */
	public async deleteInitializedSpotMarket(
		marketIndex: number
	): Promise<TransactionSignature> {
		const deleteInitializeMarketIx =
			await this.getDeleteInitializedSpotMarketIx(marketIndex);

		const tx = await this.buildTransaction(deleteInitializeMarketIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `deleteInitializedSpotMarket` instruction without sending it. See
	 * `deleteInitializedSpotMarket` for the on-chain preconditions.
	 * @param marketIndex - Index of the spot market to delete.
	 * @returns The unsigned `deleteInitializedSpotMarket` instruction.
	 */
	public async getDeleteInitializedSpotMarketIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const spotMarketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		const spotMarketVaultPublicKey = await getSpotMarketVaultPublicKey(
			this.program.programId,
			marketIndex
		);

		const insuranceFundVaultPublicKey = await getInsuranceFundVaultPublicKey(
			this.program.programId,
			marketIndex
		);

		return await this.program.instruction.deleteInitializedSpotMarket(
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					spotMarket: spotMarketPublicKey,
					spotMarketVault: spotMarketVaultPublicKey,
					insuranceFundVault: insuranceFundVaultPublicKey,
					velocitySigner: this.getSignerPublicKey(),
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);
	}

	/**
	 * Initializes a new perp market's `PerpMarket` PDA and seeds its AMM. Requires warm admin
	 * (`check_warm`); if `activeStatus` is `true` the on-chain handler additionally requires
	 * the **cold** admin (a market cannot launch active under a warm-only signer). The handler
	 * asserts `marketIndex === state.numberOfMarkets` (must be the next sequential index) and
	 * that `baseAssetReserve === quoteAssetReserve` (the initial mark price is exactly
	 * `pegMultiplier`). Does not add the market to the AMM cache — call `addMarketToAmmCache`
	 * separately (typically before the market can be traded/cranked).
	 * @param marketIndex - New market's index; must equal `state.numberOfMarkets`.
	 * @param priceOracle - Oracle account backing this market's price feed.
	 * @param baseAssetReserve - Initial AMM base reserve, BASE_PRECISION (1e9). Must equal `quoteAssetReserve`.
	 * @param quoteAssetReserve - Initial AMM quote reserve, BASE_PRECISION (1e9, AMM-internal units, not quote-asset dollars). Must equal `baseAssetReserve`.
	 * @param periodicity - Funding period, seconds (`market.marketStats.fundingPeriod`), as a BN.
	 * @param pegMultiplier - AMM peg, PEG_PRECISION (1e6). With equal reserves this fixes the initial mark price to `pegMultiplier`. Default `PEG_PRECISION` (price = 1.0).
	 * @param oracleSource - Oracle provider/format for `priceOracle`. Default `OracleSource.PYTH_LAZER`.
	 * @param contractTier - Risk/collateral tier for the contract. Default `ContractTier.SPECULATIVE`.
	 * @param marginRatioInitial - Initial margin ratio, MARGIN_PRECISION (1e4, e.g. 2000 = 20% = 5x max leverage). Default 2000.
	 * @param marginRatioMaintenance - Maintenance margin ratio, MARGIN_PRECISION (1e4). Default 500 (5%).
	 * @param liquidatorFee - Fee paid to liquidators, LIQUIDATION_FEE_PRECISION (1e6). Default 0.
	 * @param ifLiquidatorFee - Portion of the liquidation fee routed to the insurance fund, LIQUIDATION_FEE_PRECISION (1e6). Default 10000 (1%).
	 * @param imfFactor - Increases the effective margin requirement as position size grows, PERCENTAGE_PRECISION-scaled (1e6). Default 0.
	 * @param activeStatus - If `true`, market is `Active` immediately; otherwise `Initialized`. Requires cold admin when `true`. Default `true`.
	 * @param baseSpread - Base bid/ask spread around the AMM reserve price, BID_ASK_SPREAD_PRECISION (1e6). Default 0.
	 * @param maxSpread - Maximum allowed total spread, BID_ASK_SPREAD_PRECISION (1e6). Default 142500 (14.25%).
	 * @param maxOpenInterest - Cap on base-asset open interest, BASE_PRECISION (1e9). Default 0 (unlimited — treated as no cap by downstream checks).
	 * @param maxRevenueWithdrawPerPeriod - Cap on revenue-pool withdrawals per settlement period, QUOTE_PRECISION (1e6). Default 0.
	 * @param quoteMaxInsurance - Lifetime cap on insurance draws for this market, QUOTE_PRECISION (1e6). Default 0.
	 * @param orderStepSize - Minimum base-size increment for orders, BASE_PRECISION (1e9). Default `BASE_PRECISION / 10000`.
	 * @param orderTickSize - Minimum price increment for orders, PRICE_PRECISION (1e6). Default `PRICE_PRECISION / 100000`.
	 * @param minOrderSize - Minimum base order size, BASE_PRECISION (1e9). Default `BASE_PRECISION / 10000`.
	 * @param concentrationCoefScale - Unitless divisor controlling AMM liquidity concentration around the peg (`concentrationCoef = CONCENTRATION_PRECISION + (MAX_CONCENTRATION_COEFFICIENT - CONCENTRATION_PRECISION) / scale`; must be > 0). Default `ONE` (widest allowed concentration). Larger scale narrows the depth band.
	 * @param curveUpdateIntensity - 0-100 knob controlling how aggressively the AMM curve/peg re-centers on repegs. Default 0 (disabled).
	 * @param ammJitIntensity - 0-100 knob controlling how aggressively the AMM just-in-time-fills maker orders. Default 0 (disabled).
	 * @param name - Market display name, UTF-8 encoded and padded/truncated to 32 bytes. Default `DEFAULT_MARKET_NAME`.
	 * @param lpPoolId - LP pool this market's hedge exposure is routed to; 0 means unassigned. Default 0.
	 * @param fundingClampThreshold - Dead-zone half-width before funding ramps up, basis points (BPS_PRECISION, 1e4). 0 falls back on-chain to 5 bps. Default 0.
	 * @param fundingRampSlope - Slope applied to the price spread beyond the dead zone, PERCENTAGE_PRECISION (1e6, 1e6 = 1.0x). 0 falls back on-chain to 1e6 (1.0x). Default 0.
	 * @returns Transaction signature.
	 */
	public async initializePerpMarket(
		marketIndex: number,
		priceOracle: PublicKey,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_PRECISION,
		oracleSource: OracleSource = OracleSource.PYTH_LAZER,
		contractTier: ContractTier = ContractTier.SPECULATIVE,
		marginRatioInitial = 2000,
		marginRatioMaintenance = 500,
		liquidatorFee = 0,
		ifLiquidatorFee = 10000,
		imfFactor = 0,
		activeStatus = true,
		baseSpread = 0,
		maxSpread = 142500,
		maxOpenInterest = ZERO,
		maxRevenueWithdrawPerPeriod = ZERO,
		quoteMaxInsurance = ZERO,
		orderStepSize = BASE_PRECISION.divn(10000),
		orderTickSize = PRICE_PRECISION.divn(100000),
		minOrderSize = BASE_PRECISION.divn(10000),
		concentrationCoefScale = ONE,
		curveUpdateIntensity = 0,
		ammJitIntensity = 0,
		name = DEFAULT_MARKET_NAME,
		lpPoolId: number = 0,
		fundingClampThreshold = 0,
		fundingRampSlope = 0
	): Promise<TransactionSignature> {
		const currentPerpMarketIndex = this.getStateAccount().numberOfMarkets;

		const initializeMarketIxs = await this.getInitializePerpMarketIx(
			marketIndex,
			priceOracle,
			baseAssetReserve,
			quoteAssetReserve,
			periodicity,
			pegMultiplier,
			oracleSource,
			contractTier,
			marginRatioInitial,
			marginRatioMaintenance,
			liquidatorFee,
			ifLiquidatorFee,
			imfFactor,
			activeStatus,
			baseSpread,
			maxSpread,
			maxOpenInterest,
			maxRevenueWithdrawPerPeriod,
			quoteMaxInsurance,
			orderStepSize,
			orderTickSize,
			minOrderSize,
			concentrationCoefScale,
			curveUpdateIntensity,
			ammJitIntensity,
			name,
			lpPoolId,
			fundingClampThreshold,
			fundingRampSlope
		);
		const tx = await this.buildTransaction(initializeMarketIxs);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		while (this.getStateAccount().numberOfMarkets <= currentPerpMarketIndex) {
			await this.fetchAccounts();
		}

		await this.accountSubscriber.addPerpMarket(marketIndex);
		await this.accountSubscriber.addOracle({
			source: oracleSource,
			publicKey: priceOracle,
		});
		await this.accountSubscriber.setPerpOracleMap();

		return txSig;
	}

	/**
	 * Builds the `initializePerpMarket` instruction without sending it. See `initializePerpMarket`
	 * for parameter units and the cold-admin-if-`activeStatus` rule.
	 * @returns Single-element array containing the unsigned `initializePerpMarket` instruction.
	 */
	public async getInitializePerpMarketIx(
		marketIndex: number,
		priceOracle: PublicKey,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_PRECISION,
		oracleSource: OracleSource = OracleSource.PYTH_LAZER,
		contractTier: ContractTier = ContractTier.SPECULATIVE,
		marginRatioInitial = 2000,
		marginRatioMaintenance = 500,
		liquidatorFee = 0,
		ifLiquidatorFee = 10000,
		imfFactor = 0,
		activeStatus = true,
		baseSpread = 0,
		maxSpread = 142500,
		maxOpenInterest = ZERO,
		maxRevenueWithdrawPerPeriod = ZERO,
		quoteMaxInsurance = ZERO,
		orderStepSize = BASE_PRECISION.divn(10000),
		orderTickSize = PRICE_PRECISION.divn(100000),
		minOrderSize = BASE_PRECISION.divn(10000),
		concentrationCoefScale = ONE,
		curveUpdateIntensity = 0,
		ammJitIntensity = 0,
		name = DEFAULT_MARKET_NAME,
		lpPoolId: number = 0,
		fundingClampThreshold = 0,
		fundingRampSlope = 0
	): Promise<TransactionInstruction[]> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		const ixs: TransactionInstruction[] = [];

		const nameBuffer = encodeName(name);
		const initPerpIx = await this.program.instruction.initializePerpMarket(
			marketIndex,
			baseAssetReserve,
			quoteAssetReserve,
			periodicity,
			pegMultiplier,
			oracleSource,
			contractTier,
			marginRatioInitial,
			marginRatioMaintenance,
			liquidatorFee,
			ifLiquidatorFee,
			imfFactor,
			activeStatus,
			baseSpread,
			maxSpread,
			maxOpenInterest,
			maxRevenueWithdrawPerPeriod,
			quoteMaxInsurance,
			orderStepSize,
			orderTickSize,
			minOrderSize,
			concentrationCoefScale,
			curveUpdateIntensity,
			ammJitIntensity,
			nameBuffer,
			lpPoolId,
			fundingClampThreshold,
			fundingRampSlope,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					oracle: priceOracle,
					perpMarket: perpMarketPublicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
				},
			}
		);
		ixs.push(initPerpIx);
		return ixs;
	}

	/**
	 * Creates the protocol-wide singleton `AmmCache` PDA (one-time setup, empty until
	 * `addMarketToAmmCache` is called per market). Requires warm admin (`check_warm`).
	 * @returns Transaction signature.
	 */
	public async initializeAmmCache(
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const initializeAmmCacheIx = await this.getInitializeAmmCacheIx();

		const tx = await this.buildTransaction(initializeAmmCacheIx, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `initializeAmmCache` instruction without sending it. See `initializeAmmCache`.
	 * @returns The unsigned `initializeAmmCache` instruction.
	 */
	public async getInitializeAmmCacheIx(): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeAmmCache({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				rent: SYSVAR_RENT_PUBKEY,
				ammCache: getAmmCachePublicKey(this.program.programId),
				systemProgram: anchor.web3.SystemProgram.programId,
			},
		});
	}

	/**
	 * Appends a perp market's entry to the `AmmCache` (reallocating it larger by one slot).
	 * Requires warm admin (`check_warm`). Throws `DefaultError` on-chain if the market index
	 * is already present in the cache. A market must be added here before keeper cranks that
	 * rely on the AMM cache (e.g. LP-pool settlement) can process it.
	 * @param perpMarketIndex - Index of the perp market to add.
	 * @returns Transaction signature.
	 */
	public async addMarketToAmmCache(
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const initializeAmmCacheIx = await this.getAddMarketToAmmCacheIx(
			perpMarketIndex
		);

		const tx = await this.buildTransaction(initializeAmmCacheIx, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `addMarketToAmmCache` instruction without sending it. See `addMarketToAmmCache`.
	 * @param perpMarketIndex - Index of the perp market to add. Throws if the market is not
	 *   already tracked by the local account subscriber.
	 * @returns The unsigned `addMarketToAmmCache` instruction.
	 */
	public async getAddMarketToAmmCacheIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		return await this.program.instruction.addMarketToAmmCache({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				perpMarket: perpMarketAccount.pubkey,
				ammCache: getAmmCachePublicKey(this.program.programId),
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
			},
		});
	}

	/**
	 * Closes the `AmmCache` PDA, refunding rent to the admin. Requires warm admin
	 * (`check_warm`). Removes tracking for every market at once — there is no per-market
	 * inverse of `addMarketToAmmCache`.
	 * @returns Transaction signature.
	 */
	public async deleteAmmCache(
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const deleteAmmCacheIx = await this.getDeleteAmmCacheIx();

		const tx = await this.buildTransaction(deleteAmmCacheIx, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `deleteAmmCache` instruction without sending it. See `deleteAmmCache`.
	 * @returns The unsigned `deleteAmmCache` instruction.
	 */
	public async getDeleteAmmCacheIx(): Promise<TransactionInstruction> {
		return await this.program.instruction.deleteAmmCache({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				ammCache: getAmmCachePublicKey(this.program.programId),
			},
		});
	}

	/**
	 * Refreshes the `AmmCache` entries for the given perp markets from their current on-chain
	 * state and oracle price (market stats, MM-oracle price/validity). Requires the `LpCache`
	 * hot key (or warm/cold). `perpMarketIndexes` are passed as readable perp markets in
	 * `remainingAccounts` (each market's oracle account must be resolvable via the local
	 * account subscriber); the quote spot market (index 0) is always included as readable.
	 * @param perpMarketIndexes - Perp market indexes to refresh in the cache.
	 * @returns Transaction signature.
	 */
	public async updateInitialAmmCacheInfo(
		perpMarketIndexes: number[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const initializeAmmCacheIx = await this.getUpdateInitialAmmCacheInfoIx(
			perpMarketIndexes
		);

		const tx = await this.buildTransaction(initializeAmmCacheIx, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateInitialAmmCacheInfo` instruction without sending it. See
	 * `updateInitialAmmCacheInfo`.
	 * @param perpMarketIndexes - Perp market indexes to refresh in the cache.
	 * @returns The unsigned `updateInitialAmmCacheInfo` instruction.
	 */
	public async getUpdateInitialAmmCacheInfoIx(
		perpMarketIndexes: number[]
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			readablePerpMarketIndex: perpMarketIndexes,
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});
		return await this.program.instruction.updateInitialAmmCacheInfo({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				ammCache: getAmmCachePublicKey(this.program.programId),
			},
			remainingAccounts,
		});
	}

	/**
	 * Force-overwrites one market's `AmmCache` entry fields (admin escape hatch, e.g. to
	 * recover from a bad cache after an incident). Requires the `LpCache` hot key (or
	 * warm/cold). Only fields present in `params` are changed; omitted fields keep their
	 * current cached value. No-op (does not throw) if `perpMarketIndex` has no cache entry yet.
	 *
	 * Caution: despite its name, `params.lastSettleTs` is **not** forwarded to the
	 * instruction — `getOverrideAmmCacheInfoIx` expects `lastSettleSlot` and this wrapper
	 * passes `params` straight through, so any `lastSettleTs` value is silently dropped and
	 * the cache's `lastSettleSlot` is left unchanged. Call `getOverrideAmmCacheInfoIx` directly
	 * with `lastSettleSlot` if that field needs to be overridden.
	 * @param perpMarketIndex - Perp market whose cache entry to override.
	 * @param params.quoteOwedFromLpPool - Quote owed from the LP pool to this market's hedge, QUOTE_PRECISION (1e6), signed.
	 * @param params.lastSettleTs - Not applied by this method; see caution above.
	 * @param params.lastFeePoolTokenAmount - Cached fee-pool token balance, quote spot market's native decimals.
	 * @param params.lastNetPnlPoolTokenAmount - Cached net PnL-pool token balance, quote spot market's native decimals, signed.
	 * @param params.ammPositionScalar - Unitless 0-100 scalar applied to the AMM's hedge position sizing.
	 * @param params.ammInventoryLimit - Inventory limit for the AMM's hedge position, BASE_PRECISION (1e9), signed.
	 * @returns Transaction signature.
	 */
	public async overrideAmmCacheInfo(
		perpMarketIndex: number,
		params: {
			quoteOwedFromLpPool?: BN;
			lastSettleTs?: BN;
			lastFeePoolTokenAmount?: BN;
			lastNetPnlPoolTokenAmount?: BN;
			ammPositionScalar?: number;
			ammInventoryLimit?: BN;
		},
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const initializeAmmCacheIx = await this.getOverrideAmmCacheInfoIx(
			perpMarketIndex,
			params
		);
		const tx = await this.buildTransaction(initializeAmmCacheIx, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `overrideAmmCacheInfo` instruction without sending it. Unlike `overrideAmmCacheInfo`,
	 * this overload's `params` correctly uses `lastSettleSlot` (not `lastSettleTs`) and does
	 * forward it. See `overrideAmmCacheInfo` for field units.
	 * @returns The unsigned `overrideAmmCacheInfo` instruction.
	 */
	public async getOverrideAmmCacheInfoIx(
		perpMarketIndex: number,
		params: {
			quoteOwedFromLpPool?: BN;
			lastSettleSlot?: BN;
			lastFeePoolTokenAmount?: BN;
			lastNetPnlPoolTokenAmount?: BN;
			ammPositionScalar?: number;
			ammInventoryLimit?: BN;
		}
	): Promise<TransactionInstruction> {
		return this.program.instruction.overrideAmmCacheInfo(
			perpMarketIndex,
			Object.assign(
				{},
				{
					quoteOwedFromLpPool: null,
					lastSettleSlot: null,
					lastFeePoolTokenAmount: null,
					lastNetPnlPoolTokenAmount: null,
					ammPositionScalar: null,
					ammInventoryLimit: null,
				},
				params
			),
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					ammCache: getAmmCachePublicKey(this.program.programId),
				},
			}
		);
	}

	/**
	 * Intended to reallocate the `AmmCache` to `state.numberOfMarkets` entries and reset it
	 * (`ResetAmmCache` accounts struct is gated on the `LpCache` hot key, or warm/cold, per
	 * `programs/velocity/src/instructions/admin.rs`). **Currently non-functional**: no
	 * `reset_amm_cache` handler is wired into the program's instruction dispatch, so this
	 * instruction does not exist in the IDL — `getResetAmmCacheIx` casts to `any` to bypass
	 * the missing type, but calling it throws at runtime (`program.instruction.resetAmmCache`
	 * is `undefined`). Use `deleteAmmCache` + `initializeAmmCache` + `addMarketToAmmCache` per
	 * market to achieve the same effect until this is wired up on-chain.
	 * @returns Transaction signature (in practice: throws before a transaction is built).
	 */
	public async resetAmmCache(
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const initializeAmmCacheIx = await this.getResetAmmCacheIx();
		const tx = await this.buildTransaction(initializeAmmCacheIx, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the (currently non-existent) `resetAmmCache` instruction. See `resetAmmCache` —
	 * this throws because the program does not expose a `resetAmmCache` instruction.
	 * @returns Never resolves successfully; throws when the missing instruction is invoked.
	 */
	public async getResetAmmCacheIx(): Promise<TransactionInstruction> {
		return (this.program.instruction as any).resetAmmCache({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				ammCache: getAmmCachePublicKey(this.program.programId),
				systemProgram: anchor.web3.SystemProgram.programId,
			},
		});
	}

	/**
	 * Closes a mis-initialized perp market and refunds rent to the admin. Requires warm admin
	 * (`check_warm`). On-chain the handler only allows deleting the **most recently created**
	 * market (`marketIndex == state.numberOfMarkets - 1`), still in `Initialized` status
	 * (never activated), with zero users — otherwise it throws `InvalidMarketAccountforDeletion`.
	 * @param marketIndex - Index of the perp market to delete; must be the last-created, unactivated, userless market.
	 * @returns Transaction signature.
	 */
	public async deleteInitializedPerpMarket(
		marketIndex: number
	): Promise<TransactionSignature> {
		const deleteInitializeMarketIx =
			await this.getDeleteInitializedPerpMarketIx(marketIndex);

		const tx = await this.buildTransaction(deleteInitializeMarketIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `deleteInitializedPerpMarket` instruction without sending it. See
	 * `deleteInitializedPerpMarket` for the on-chain preconditions.
	 * @param marketIndex - Index of the perp market to delete.
	 * @returns The unsigned `deleteInitializedPerpMarket` instruction.
	 */
	public async getDeleteInitializedPerpMarketIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		return await this.program.instruction.deleteInitializedPerpMarket(
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	/**
	 * Directly overwrites the AMM's base/quote reserves and `sqrtK` for a perp market — an
	 * admin escape hatch to force the AMM mark price (`quoteAssetReserve / baseAssetReserve *
	 * pegMultiplier`) without going through a repeg. Requires warm admin (`check_warm`).
	 * Re-derives min/max base reserve bounds from the new `sqrtK` and re-validates the market
	 * (`validate_perp_market`) before committing, so an inconsistent reserve/peg combination
	 * fails the transaction.
	 * @param perpMarketIndex - Perp market to move.
	 * @param baseAssetReserve - New AMM base reserve, BASE_PRECISION (1e9).
	 * @param quoteAssetReserve - New AMM quote reserve, BASE_PRECISION (1e9, AMM-internal units).
	 * @param sqrtK - New invariant `sqrt(baseAssetReserve * quoteAssetReserve)`, BASE_PRECISION (1e9). Defaults to the exact square root of `baseAssetReserve * quoteAssetReserve` when omitted.
	 * @returns Transaction signature.
	 */
	public async moveAmmPrice(
		perpMarketIndex: number,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		sqrtK?: BN
	): Promise<TransactionSignature> {
		const moveAmmPriceIx = await this.getMoveAmmPriceIx(
			perpMarketIndex,
			baseAssetReserve,
			quoteAssetReserve,
			sqrtK
		);

		const tx = await this.buildTransaction(moveAmmPriceIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `moveAmmPrice` instruction without sending it. See `moveAmmPrice` for units
	 * and the `sqrtK` default.
	 * @returns The unsigned `moveAmmPrice` instruction.
	 */
	public async getMoveAmmPriceIx(
		perpMarketIndex: number,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		sqrtK?: BN
	): Promise<TransactionInstruction> {
		const marketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		if (sqrtK == undefined) {
			sqrtK = squareRootBN(baseAssetReserve.mul(quoteAssetReserve));
		}

		return await this.program.instruction.moveAmmPrice(
			baseAssetReserve,
			quoteAssetReserve,
			sqrtK,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					perpMarket: marketPublicKey,
				},
			}
		);
	}

	/**
	 * Rescales a perp market's AMM invariant (`sqrtK`) while holding the mark price
	 * approximately constant, widening or tightening depth around the current peg. Requires
	 * warm admin (`check_warm`). On-chain, increasing `sqrtK` must cost the AMM's fee reserve
	 * a non-negative amount (charged against `totalFeeMinusDistributions`, capped at that
	 * balance) and decreasing it must yield a non-positive cost; the resulting price move must
	 * stay within `MAX_UPDATE_K_PRICE_CHANGE` and `sqrtK` may not increase past `MAX_SQRT_K` —
	 * violating any of these throws `InvalidUpdateK`.
	 * @param perpMarketIndex - Perp market to rescale.
	 * @param sqrtK - New invariant, BASE_PRECISION (1e9).
	 * @returns Transaction signature.
	 */
	public async updateK(
		perpMarketIndex: number,
		sqrtK: BN
	): Promise<TransactionSignature> {
		const updateKIx = await this.getUpdateKIx(perpMarketIndex, sqrtK);

		const tx = await this.buildTransaction(updateKIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateK` instruction without sending it. See `updateK` for units and the
	 * on-chain cost/price-change constraints.
	 * @returns The unsigned `updateK` instruction.
	 */
	public async getUpdateKIx(
		perpMarketIndex: number,
		sqrtK: BN
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		return await this.program.instruction.updateK(sqrtK, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
				oracle: perpMarketAccount.oracle,
			},
		});
	}

	/**
	 * Re-centers a perp market's AMM around a new peg and invariant while keeping the AMM's
	 * net position unchanged (`amm.recenter`) — the admin-driven counterpart of an automatic
	 * repeg, typically used to realign the AMM to the oracle after a large price move.
	 * Requires warm admin (`check_warm`). Re-derives min/max base reserve bounds and
	 * re-validates the market before committing.
	 * @param perpMarketIndex - Perp market to recenter.
	 * @param pegMultiplier - New AMM peg, PEG_PRECISION (1e6).
	 * @param sqrtK - New invariant, BASE_PRECISION (1e9).
	 * @returns Transaction signature.
	 */
	public async recenterPerpMarketAmm(
		perpMarketIndex: number,
		pegMultiplier: BN,
		sqrtK: BN
	): Promise<TransactionSignature> {
		const recenterPerpMarketAmmIx = await this.getRecenterPerpMarketAmmIx(
			perpMarketIndex,
			pegMultiplier,
			sqrtK
		);

		const tx = await this.buildTransaction(recenterPerpMarketAmmIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `recenterPerpMarketAmm` instruction without sending it. See
	 * `recenterPerpMarketAmm` for units.
	 * @returns The unsigned `recenterPerpMarketAmm` instruction.
	 */
	public async getRecenterPerpMarketAmmIx(
		perpMarketIndex: number,
		pegMultiplier: BN,
		sqrtK: BN
	): Promise<TransactionInstruction> {
		const marketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.recenterPerpMarketAmm(
			pegMultiplier,
			sqrtK,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					perpMarket: marketPublicKey,
				},
			}
		);
	}

	/**
	 * Keeper-cranked variant of `recenterPerpMarketAmm`: derives the target peg/invariant from
	 * the current oracle price (and an optional target depth) instead of taking them as
	 * explicit params. Requires the `AmmCrank` hot key (or warm/cold).
	 * @param perpMarketIndex - Perp market to recenter.
	 * @param depth - Optional target liquidity depth to recenter around, BASE_PRECISION (1e9). Omit to use the market's existing depth.
	 * @returns Transaction signature.
	 */
	public async recenterPerpMarketAmmCrank(
		perpMarketIndex: number,
		depth?: BN
	): Promise<TransactionSignature> {
		const recenterPerpMarketAmmIx = await this.getRecenterPerpMarketAmmCrankIx(
			perpMarketIndex,
			depth
		);

		const tx = await this.buildTransaction(recenterPerpMarketAmmIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `recenterPerpMarketAmmCrank` instruction without sending it. See
	 * `recenterPerpMarketAmmCrank`.
	 * @returns The unsigned `recenterPerpMarketAmmCrank` instruction.
	 */
	public async getRecenterPerpMarketAmmCrankIx(
		perpMarketIndex: number,
		depth?: BN
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		return await this.program.instruction.recenterPerpMarketAmmCrank(
			depth ?? null,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						QUOTE_SPOT_MARKET_INDEX
					),
					oracle: perpMarketAccount.oracle,
				},
			}
		);
	}

	/**
	 * Updates a perp market's AMM concentration coefficient, changing how tightly liquidity
	 * is concentrated around the peg (calls the on-chain `updatePerpMarketConcentrationCoef`
	 * instruction). Requires warm admin (`check_warm`).
	 * @param perpMarketIndex - Perp market to update.
	 * @param concentrationScale - Unitless divisor, must be > 0 (`concentrationCoef = CONCENTRATION_PRECISION + (MAX_CONCENTRATION_COEFFICIENT - CONCENTRATION_PRECISION) / concentrationScale`). Larger scale narrows the depth band; `1` yields the widest allowed concentration.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketConcentrationScale(
		perpMarketIndex: number,
		concentrationScale: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketConcentrationCoefIx =
			await this.getUpdatePerpMarketConcentrationScaleIx(
				perpMarketIndex,
				concentrationScale
			);

		const tx = await this.buildTransaction(updatePerpMarketConcentrationCoefIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketConcentrationCoef` instruction without sending it. See
	 * `updatePerpMarketConcentrationScale`.
	 * @returns The unsigned `updatePerpMarketConcentrationCoef` instruction.
	 */
	public async getUpdatePerpMarketConcentrationScaleIx(
		perpMarketIndex: number,
		concentrationScale: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketConcentrationCoef(
			concentrationScale,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets which LP pool a perp market's hedge exposure (`hedgeConfig.poolId`) is routed to.
	 * Requires warm admin (`check_warm`).
	 * @param perpMarketIndex - Perp market to update.
	 * @param lpPoolId - Target LP pool id; 0 means unassigned.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketLpPoolId(
		perpMarketIndex: number,
		lpPoolId: number
	) {
		const updatePerpMarketLpPoolIIx = await this.getUpdatePerpMarketLpPoolIdIx(
			perpMarketIndex,
			lpPoolId
		);

		const tx = await this.buildTransaction(updatePerpMarketLpPoolIIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketLpPoolId` instruction without sending it. See
	 * `updatePerpMarketLpPoolId`.
	 * @returns The unsigned `updatePerpMarketLpPoolId` instruction.
	 */
	public async getUpdatePerpMarketLpPoolIdIx(
		perpMarketIndex: number,
		lpPoolId: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketLpPoolId(lpPoolId, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	/**
	 * Sets a perp market's LP-pool hedge status (`hedgeConfig.status`) and immediately
	 * refreshes its `AmmCache` entry from the new market state. Requires warm admin
	 * (`check_warm`).
	 * @param perpMarketIndex - Perp market to update.
	 * @param lpStatus - New hedge status bitmask/value for `hedgeConfig.status`.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketLpPoolStatus(
		perpMarketIndex: number,
		lpStatus: number
	) {
		const updatePerpMarketLpPoolStatusIx =
			await this.getUpdatePerpMarketLpPoolStatusIx(perpMarketIndex, lpStatus);

		const tx = await this.buildTransaction(updatePerpMarketLpPoolStatusIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketLpPoolStatus` instruction without sending it. See
	 * `updatePerpMarketLpPoolStatus`.
	 * @returns The unsigned `updatePerpMarketLpPoolStatus` instruction.
	 */
	public async getUpdatePerpMarketLpPoolStatusIx(
		perpMarketIndex: number,
		lpStatus: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketLpPoolStatus(
			lpStatus,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
					ammCache: getAmmCachePublicKey(this.program.programId),
				},
			}
		);
	}

	/**
	 * Convenience wrapper around `moveAmmPrice`: computes, from the locally cached
	 * `PerpMarket` account, the base/quote reserves that move the AMM's mark price to
	 * `targetPrice` (holding `sqrtK` fixed at its current value) and sends that instruction.
	 * Requires warm admin (`check_warm`, same as `moveAmmPrice`). Throws if the market isn't
	 * tracked by the local account subscriber.
	 * @param perpMarketIndex - Perp market to move.
	 * @param targetPrice - Desired AMM mark price, PRICE_PRECISION (1e6).
	 * @returns Transaction signature.
	 */
	public async moveAmmToPrice(
		perpMarketIndex: number,
		targetPrice: BN
	): Promise<TransactionSignature> {
		const moveAmmPriceIx = await this.getMoveAmmToPriceIx(
			perpMarketIndex,
			targetPrice
		);

		const tx = await this.buildTransaction(moveAmmPriceIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the underlying `moveAmmPrice` instruction that moves the AMM to `targetPrice`.
	 * See `moveAmmToPrice`.
	 * @returns The unsigned `moveAmmPrice` instruction.
	 */
	public async getMoveAmmToPriceIx(
		perpMarketIndex: number,
		targetPrice: BN
	): Promise<TransactionInstruction> {
		const perpMarket = this.getPerpMarketAccountOrThrow(perpMarketIndex);

		const [direction, tradeSize, _] = calculateTargetPriceTrade(
			perpMarket,
			targetPrice,
			new BN(1000),
			'quote',
			undefined //todo
		);

		const [newQuoteAssetAmount, newBaseAssetAmount] =
			calculateAmmReservesAfterSwap(
				perpMarket.amm,
				'quote',
				tradeSize,
				getSwapDirection('quote', direction)
			);

		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.moveAmmPrice(
			newBaseAssetAmount,
			newQuoteAssetAmount,
			perpMarket.amm.sqrtK,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	/**
	 * Repegs a perp market's AMM toward `newPeg`, adjusting reserves to keep the invariant
	 * (`sqrtK`) fixed while moving the mark price. Requires warm admin (`check_warm`). The
	 * on-chain `repeg` routine validates the oracle (per `state.oracleGuardRails`) and charges
	 * the reserve/fee-pool the resulting `adjustment_cost`; emits `AmmCurveChanged`.
	 * @param newPeg - Candidate new AMM peg, PEG_PRECISION (1e6).
	 * @param perpMarketIndex - Perp market to repeg.
	 * @returns Transaction signature.
	 */
	public async repegAmmCurve(
		newPeg: BN,
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const repegAmmCurveIx = await this.getRepegAmmCurveIx(
			newPeg,
			perpMarketIndex
		);

		const tx = await this.buildTransaction(repegAmmCurveIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `repegAmmCurve` instruction without sending it. See `repegAmmCurve`. Throws
	 * if `perpMarketIndex` isn't tracked by the local account subscriber (needed to resolve
	 * the market's oracle account).
	 * @returns The unsigned `repegAmmCurve` instruction.
	 */
	public async getRepegAmmCurveIx(
		newPeg: BN,
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);

		return await this.program.instruction.repegAmmCurve(newPeg, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				oracle: perpMarketAccount.oracle,
				perpMarket: perpMarketPublicKey,
			},
		});
	}

	/**
	 * Nudges a perp market's cached oracle TWAP (`marketStats.historicalOracleData.lastOraclePriceTwap`,
	 * PRICE_PRECISION 1e6) toward the freshly-sampled oracle TWAP, but only accepts the move
	 * if it narrows the mark/oracle TWAP gap or flips its sign (otherwise clamps the cached
	 * TWAP to the mark TWAP). Requires warm admin (`check_warm`); throws `PriceBandsBreached`
	 * on-chain if the new gap would be strictly larger with the same sign, and `InvalidOracle`
	 * if the oracle can't be read.
	 * @param perpMarketIndex - Perp market to update.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketAmmOracleTwap(
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const updatePerpMarketAmmOracleTwapIx =
			await this.getUpdatePerpMarketAmmOracleTwapIx(perpMarketIndex);

		const tx = await this.buildTransaction(updatePerpMarketAmmOracleTwapIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketAmmOracleTwap` instruction without sending it. See
	 * `updatePerpMarketAmmOracleTwap`.
	 * @returns The unsigned `updatePerpMarketAmmOracleTwap` instruction.
	 */
	public async getUpdatePerpMarketAmmOracleTwapIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				oracle: perpMarketAccount.oracle,
				perpMarket: perpMarketPublicKey,
			},
		});
	}

	/**
	 * Admin failsafe that force-resets a perp market's cached oracle TWAP to the current mark
	 * TWAP (unconditionally, unlike `updatePerpMarketAmmOracleTwap`'s gap-narrowing check).
	 * Requires warm admin (`check_warm`). Use when the oracle TWAP has drifted badly (e.g.
	 * after an oracle outage) and funding needs to be re-anchored immediately.
	 * @param perpMarketIndex - Perp market to reset.
	 * @returns Transaction signature.
	 */
	public async resetPerpMarketAmmOracleTwap(
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const resetPerpMarketAmmOracleTwapIx =
			await this.getResetPerpMarketAmmOracleTwapIx(perpMarketIndex);

		const tx = await this.buildTransaction(resetPerpMarketAmmOracleTwapIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `resetPerpMarketAmmOracleTwap` instruction without sending it. See
	 * `resetPerpMarketAmmOracleTwap`.
	 * @returns The unsigned `resetPerpMarketAmmOracleTwap` instruction.
	 */
	public async getResetPerpMarketAmmOracleTwapIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.resetPerpMarketAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				oracle: perpMarketAccount.oracle,
				perpMarket: perpMarketPublicKey,
			},
		});
	}

	/**
	 * Tops up a perp market's AMM fee pool: transfers `amount` from `sourceVault` (a token
	 * account the caller controls) into the quote spot market's vault via CPI, and credits
	 * the same amount to `perpMarket.amm.totalFeeMinusDistributions` / `amm.feePool`. Requires
	 * the `VaultDeposit` hot key (or warm/cold).
	 * @param perpMarketIndex - Perp market whose fee pool to credit.
	 * @param amount - Amount to deposit, quote spot market's native decimals (QUOTE_PRECISION, 1e6, for the standard USDC quote market).
	 * @param sourceVault - Token account to transfer `amount` from; `admin` must be its authority.
	 * @returns Transaction signature.
	 */
	public async depositIntoPerpMarketFeePool(
		perpMarketIndex: number,
		amount: BN,
		sourceVault: PublicKey
	): Promise<TransactionSignature> {
		const depositIntoPerpMarketFeePoolIx =
			await this.getDepositIntoPerpMarketFeePoolIx(
				perpMarketIndex,
				amount,
				sourceVault
			);

		const tx = await this.buildTransaction(depositIntoPerpMarketFeePoolIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `depositIntoPerpMarketFeePool` instruction without sending it. See
	 * `depositIntoPerpMarketFeePool`.
	 * @returns The unsigned `depositIntoPerpMarketFeePool` instruction.
	 */
	public async getDepositIntoPerpMarketFeePoolIx(
		perpMarketIndex: number,
		amount: BN,
		sourceVault: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarket = this.getQuoteSpotMarketAccount();
		const remainingAccounts = [
			{
				pubkey: spotMarket.mint,
				isWritable: false,
				isSigner: false,
			},
		];

		return await this.program.instruction.depositIntoPerpMarketFeePool(amount, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
				sourceVault,
				velocitySigner: this.getSignerPublicKey(),
				quoteSpotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts,
		});
	}

	/**
	 * Credits `amount` to a perp market's PnL pool balance as pure internal accounting — it
	 * does **not** move any tokens. On-chain the handler only validates that the quote spot
	 * market's actual vault balance still covers the resulting internal balances
	 * (`validate_spot_market_vault_amount`); it does not itself deposit the backing tokens, so
	 * call this only after (or together with) a real deposit that gets the tokens into the
	 * vault. Requires warm admin (`check_warm`).
	 * @param perpMarketIndex - Perp market whose PnL pool to credit.
	 * @param amount - Amount to credit, quote spot market's native decimals (QUOTE_PRECISION, 1e6, for the standard USDC quote market).
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketPnlPool(
		perpMarketIndex: number,
		amount: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketPnlPoolIx = await this.getUpdatePerpMarketPnlPoolIx(
			perpMarketIndex,
			amount
		);

		const tx = await this.buildTransaction(updatePerpMarketPnlPoolIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketPnlPool` instruction without sending it. See
	 * `updatePerpMarketPnlPool` — no tokens are moved by this instruction.
	 * @returns The unsigned `updatePerpMarketPnlPool` instruction.
	 */
	public async getUpdatePerpMarketPnlPoolIx(
		perpMarketIndex: number,
		amount: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketPnlPool(amount, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
				spotMarket: this.getQuoteSpotMarketAccount().pubkey,
				spotMarketVault: this.getQuoteSpotMarketAccount().vault,
			},
		});
	}

	/**
	 * Deposits `amount` from `sourceVault` (a token account the caller controls) directly into
	 * a spot market's vault via CPI and credits the market's deposit balance accordingly.
	 * Requires the `VaultDeposit` hot key (or warm/cold). Throws on-chain if the spot market
	 * has deposits paused (`SpotOperation::Deposit`).
	 * @param spotMarketIndex - Spot market whose vault to deposit into.
	 * @param amount - Amount to deposit, the spot market's native token decimals.
	 * @param sourceVault - Token account to transfer `amount` from; `admin` must be its authority.
	 * @returns Transaction signature.
	 */
	public async depositIntoSpotMarketVault(
		spotMarketIndex: number,
		amount: BN,
		sourceVault: PublicKey
	): Promise<TransactionSignature> {
		const depositIntoPerpMarketFeePoolIx =
			await this.getDepositIntoSpotMarketVaultIx(
				spotMarketIndex,
				amount,
				sourceVault
			);

		const tx = await this.buildTransaction(depositIntoPerpMarketFeePoolIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `depositIntoSpotMarketVault` instruction without sending it. See
	 * `depositIntoSpotMarketVault`. Automatically appends transfer-hook extra account metas
	 * when the mint requires them.
	 * @returns The unsigned `depositIntoSpotMarketVault` instruction.
	 */
	public async getDepositIntoSpotMarketVaultIx(
		spotMarketIndex: number,
		amount: BN,
		sourceVault: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccountOrThrow(spotMarketIndex);

		const remainingAccounts: AccountMeta[] = [];
		this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);
		if (this.isTransferHook(spotMarket)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarket.mint,
				remainingAccounts
			);
		}

		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarket);
		return await this.program.instruction.depositIntoSpotMarketVault(amount, {
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				state: await this.getStatePublicKey(),
				sourceVault,
				spotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
				tokenProgram,
			},
			remainingAccounts,
		});
	}

	/**
	 * Rotates the root (`state.coldAdmin`) authority — the top of the cold ⊇ warm ⊇
	 * hot(role) tier hierarchy. Cold-only: the `ColdAdminUpdateState` context requires
	 * the current signer to equal `state.coldAdmin`. This is the one-time-per-rotation
	 * root key change; `warmAdmin` and `pauseAdmin` are rotated separately via
	 * `updateWarmAdmin`/`updatePauseAdmin` (also cold-only).
	 * @param admin - New cold admin pubkey.
	 * @returns Transaction signature.
	 */
	public async updateAdmin(admin: PublicKey): Promise<TransactionSignature> {
		const updateAdminIx = await this.getUpdateAdminIx(admin);

		const tx = await this.buildTransaction(updateAdminIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateAdmin` instruction without sending it. See `updateAdmin`.
	 * @returns The unsigned `updateAdmin` instruction.
	 */
	public async getUpdateAdminIx(
		admin: PublicKey
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateAdmin(admin, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	/**
	 * Sets how aggressively a perp market's AMM curve auto-adjusts. Requires the market's
	 * `HotAdminUpdatePerpMarket` gate — the `check_warm` constraint on that context currently
	 * accepts cold or warm admin only (no dedicated hot role is wired to it). On-chain, values
	 * `0..=100` control repeg/formulaic-k intensity and `101..=200` additionally enable
	 * reference-price-offset intensity; values above 200 throw `DefaultError`.
	 * @param perpMarketIndex - Perp market to update.
	 * @param curveUpdateIntensity - 0-200 intensity knob (see above for the two sub-ranges).
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketCurveUpdateIntensity(
		perpMarketIndex: number,
		curveUpdateIntensity: number
	): Promise<TransactionSignature> {
		const updatePerpMarketCurveUpdateIntensityIx =
			await this.getUpdatePerpMarketCurveUpdateIntensityIx(
				perpMarketIndex,
				curveUpdateIntensity
			);

		const tx = await this.buildTransaction(
			updatePerpMarketCurveUpdateIntensityIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketCurveUpdateIntensity` instruction without sending it. See
	 * `updatePerpMarketCurveUpdateIntensity`.
	 * @returns The unsigned `updatePerpMarketCurveUpdateIntensity` instruction.
	 */
	public async getUpdatePerpMarketCurveUpdateIntensityIx(
		perpMarketIndex: number,
		curveUpdateIntensity: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketCurveUpdateIntensity(
			curveUpdateIntensity,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets the dead-band, as a percent of price, within which the AMM's reference-price offset
	 * (used to bias the AMM's quoted price away from the raw oracle/mark price) is suppressed.
	 * Gated the same as `updatePerpMarketCurveUpdateIntensity` (warm admin via
	 * `HotAdminUpdatePerpMarket`'s `check_warm` constraint). Throws `DefaultError` on-chain if
	 * `referencePriceOffsetDeadbandPct > 100`.
	 * @param perpMarketIndex - Perp market to update.
	 * @param referencePriceOffsetDeadbandPct - 0-100 percent dead-band.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketReferencePriceOffsetDeadbandPct(
		perpMarketIndex: number,
		referencePriceOffsetDeadbandPct: number
	): Promise<TransactionSignature> {
		const updatePerpMarketReferencePriceOffsetDeadbandPctIx =
			await this.getUpdatePerpMarketReferencePriceOffsetDeadbandPctIx(
				perpMarketIndex,
				referencePriceOffsetDeadbandPct
			);

		const tx = await this.buildTransaction(
			updatePerpMarketReferencePriceOffsetDeadbandPctIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketReferencePriceOffsetDeadbandPct` instruction without sending
	 * it. See `updatePerpMarketReferencePriceOffsetDeadbandPct`.
	 * @returns The unsigned `updatePerpMarketReferencePriceOffsetDeadbandPct` instruction.
	 */
	public async getUpdatePerpMarketReferencePriceOffsetDeadbandPctIx(
		perpMarketIndex: number,
		referencePriceOffsetDeadbandPct: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketReferencePriceOffsetDeadbandPct(
			referencePriceOffsetDeadbandPct,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * **Currently non-functional**: the program does not expose an
	 * `update_perp_market_target_base_asset_amount_per_lp` instruction (no such handler is
	 * wired into `lib.rs`, and it's absent from the generated IDL). `getUpdatePerpMarketTargetBaseAssetAmountPerLpIx`
	 * casts `this.program.instruction` to `any` to bypass the missing type, but the call
	 * throws at runtime. `targetBaseAssetAmountPerLp` exists only as a legacy field in
	 * `test_utils/legacy_snapshot.rs`, not on the live `PerpMarket`/`AMM` struct.
	 * @param perpMarketIndex - Perp market that would be updated.
	 * @param targetBaseAssetAmountPerLP - Intended target base-asset-amount-per-LP value.
	 * @returns Transaction signature (in practice: throws before a transaction is built).
	 */
	public async updatePerpMarketTargetBaseAssetAmountPerLp(
		perpMarketIndex: number,
		targetBaseAssetAmountPerLP: number
	): Promise<TransactionSignature> {
		const updatePerpMarketTargetBaseAssetAmountPerLpIx =
			await this.getUpdatePerpMarketTargetBaseAssetAmountPerLpIx(
				perpMarketIndex,
				targetBaseAssetAmountPerLP
			);

		const tx = await this.buildTransaction(
			updatePerpMarketTargetBaseAssetAmountPerLpIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Admin recalibration of a perp market's AMM fee-accounting summary stats. Requires the
	 * `AmmCrank` hot key (or warm/cold). If `netUnsettledFundingPnl` is provided it directly
	 * overwrites `perpMarket.netUnsettledFundingPnl`. If `updateAmmSummaryStats` is `true`,
	 * recomputes `amm.totalFeeMinusDistributions` from current market/spot-market/oracle state
	 * and applies the resulting delta to `amm.totalFee` and `amm.totalMmFee`; omitted or
	 * `false` leaves fee accounting untouched. Re-validates the market before committing.
	 * @param perpMarketIndex - Perp market to recalibrate.
	 * @param updateAmmSummaryStats - If `true`, recompute and correct AMM fee-accounting totals. Default: unset (no correction).
	 * @param netUnsettledFundingPnl - Overwrite for `perpMarket.netUnsettledFundingPnl`, QUOTE_PRECISION (1e6), signed. Default: unset (unchanged).
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketAmmSummaryStats(
		perpMarketIndex: number,
		updateAmmSummaryStats?: boolean,
		netUnsettledFundingPnl?: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketMarginRatioIx =
			await this.getUpdatePerpMarketAmmSummaryStatsIx(
				perpMarketIndex,
				updateAmmSummaryStats,
				netUnsettledFundingPnl
			);

		const tx = await this.buildTransaction(updatePerpMarketMarginRatioIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketAmmSummaryStats` instruction without sending it. See
	 * `updatePerpMarketAmmSummaryStats`. Throws if `perpMarketIndex` isn't tracked by the
	 * local account subscriber (needed to resolve the market's oracle account).
	 * @returns The unsigned `updatePerpMarketAmmSummaryStats` instruction.
	 */
	public async getUpdatePerpMarketAmmSummaryStatsIx(
		perpMarketIndex: number,
		updateAmmSummaryStats?: boolean,
		netUnsettledFundingPnl?: BN
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		return await this.program.instruction.updatePerpMarketAmmSummaryStats(
			{
				updateAmmSummaryStats: updateAmmSummaryStats ?? null,
				netUnsettledFundingPnl: netUnsettledFundingPnl ?? null,
			},
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						QUOTE_SPOT_MARKET_INDEX
					),
					oracle: perpMarketAccount.oracle,
				},
			}
		);
	}

	/**
	 * Builds the (currently non-existent) `updatePerpMarketTargetBaseAssetAmountPerLp`
	 * instruction. See `updatePerpMarketTargetBaseAssetAmountPerLp` — this throws because the
	 * program does not expose that instruction.
	 * @returns Never resolves successfully; throws when the missing instruction is invoked.
	 */
	public async getUpdatePerpMarketTargetBaseAssetAmountPerLpIx(
		perpMarketIndex: number,
		targetBaseAssetAmountPerLP: number
	): Promise<TransactionInstruction> {
		return await (
			this.program.instruction as any
		).updatePerpMarketTargetBaseAssetAmountPerLp(targetBaseAssetAmountPerLP, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	/**
	 * Sets a perp market's initial and maintenance margin ratios (max leverage and
	 * liquidation threshold). Requires warm admin (`check_warm`). On-chain, validates the pair
	 * is internally consistent and compatible with the market's current `liquidatorFee`
	 * (`amm.validate_compatible_with_margin_ratio`) before committing.
	 * @param perpMarketIndex - Perp market to update.
	 * @param marginRatioInitial - Initial margin ratio, MARGIN_PRECISION (1e4, e.g. 2000 = 20% = 5x max leverage). Must be >= `marginRatioMaintenance`.
	 * @param marginRatioMaintenance - Maintenance margin ratio, MARGIN_PRECISION (1e4).
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketMarginRatio(
		perpMarketIndex: number,
		marginRatioInitial: number,
		marginRatioMaintenance: number
	): Promise<TransactionSignature> {
		const updatePerpMarketMarginRatioIx =
			await this.getUpdatePerpMarketMarginRatioIx(
				perpMarketIndex,
				marginRatioInitial,
				marginRatioMaintenance
			);

		const tx = await this.buildTransaction(updatePerpMarketMarginRatioIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketMarginRatio` instruction without sending it. See
	 * `updatePerpMarketMarginRatio`.
	 * @returns The unsigned `updatePerpMarketMarginRatio` instruction.
	 */
	public async getUpdatePerpMarketMarginRatioIx(
		perpMarketIndex: number,
		marginRatioInitial: number,
		marginRatioMaintenance: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketMarginRatio(
			marginRatioInitial,
			marginRatioMaintenance,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a perp market's funding dead-zone: the band around the oracle TWAP within which no
	 * funding premium accrues, and the ramp applied to the premium beyond that band. Requires
	 * warm admin (`check_warm`). Unlike `initializePerpMarket` (where `0` silently falls back
	 * to defaults), the update handler validates its inputs directly and throws `DefaultError`
	 * if `fundingClampThreshold >= BPS_PRECISION` (i.e. must be < 100%) or if
	 * `fundingRampSlope === 0` (a zero slope would flatten every premium past the band to the
	 * funding-rate offset).
	 * @param perpMarketIndex - Perp market to update.
	 * @param fundingClampThreshold - Dead-zone half-width, basis points (BPS_PRECISION, 1e4). Must be < 10000.
	 * @param fundingRampSlope - Slope applied beyond the dead zone, PERCENTAGE_PRECISION (1e6, 1e6 = 1.0x). Must be > 0.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketFundingDeadZone(
		perpMarketIndex: number,
		fundingClampThreshold: number,
		fundingRampSlope: number
	): Promise<TransactionSignature> {
		const updatePerpMarketFundingDeadZoneIx =
			await this.getUpdatePerpMarketFundingDeadZoneIx(
				perpMarketIndex,
				fundingClampThreshold,
				fundingRampSlope
			);

		const tx = await this.buildTransaction(updatePerpMarketFundingDeadZoneIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketFundingDeadZone` instruction without sending it. See
	 * `updatePerpMarketFundingDeadZone` for units and validation.
	 * @returns The unsigned `updatePerpMarketFundingDeadZone` instruction.
	 */
	public async getUpdatePerpMarketFundingDeadZoneIx(
		perpMarketIndex: number,
		fundingClampThreshold: number,
		fundingRampSlope: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketFundingDeadZone(
			fundingClampThreshold,
			fundingRampSlope,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a perp market's IMF factors, which increase the effective margin requirement (and
	 * shrink unrealized-PnL asset weight) as position size grows. Requires warm admin
	 * (`check_warm`). Throws `DefaultError` on-chain if either value exceeds `SPOT_IMF_PRECISION` (1e6).
	 * @param perpMarketIndex - Perp market to update.
	 * @param imfFactor - Position-size margin penalty factor, SPOT_IMF_PRECISION (1e6). Must be <= 1e6.
	 * @param unrealizedPnlImfFactor - Position-size penalty factor applied to unrealized-PnL asset weight, SPOT_IMF_PRECISION (1e6). Must be <= 1e6.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketImfFactor(
		perpMarketIndex: number,
		imfFactor: number,
		unrealizedPnlImfFactor: number
	): Promise<TransactionSignature> {
		const updatePerpMarketImfFactorIx =
			await this.getUpdatePerpMarketImfFactorIx(
				perpMarketIndex,
				imfFactor,
				unrealizedPnlImfFactor
			);

		const tx = await this.buildTransaction(updatePerpMarketImfFactorIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketImfFactor` instruction without sending it. See
	 * `updatePerpMarketImfFactor`.
	 * @returns The unsigned `updatePerpMarketImfFactor` instruction.
	 */
	public async getUpdatePerpMarketImfFactorIx(
		perpMarketIndex: number,
		imfFactor: number,
		unrealizedPnlImfFactor: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketImfFactor(
			imfFactor,
			unrealizedPnlImfFactor,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a perp market's base bid/ask spread around the AMM reserve price. Requires warm
	 * admin (`check_warm`). The AMM's cached `longSpread`/`shortSpread` are refreshed from
	 * this value on the next quote/fill rather than immediately.
	 * @param perpMarketIndex - Perp market to update.
	 * @param baseSpread - New base spread, BID_ASK_SPREAD_PRECISION (1e6).
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketBaseSpread(
		perpMarketIndex: number,
		baseSpread: number
	): Promise<TransactionSignature> {
		const updatePerpMarketBaseSpreadIx =
			await this.getUpdatePerpMarketBaseSpreadIx(perpMarketIndex, baseSpread);

		const tx = await this.buildTransaction(updatePerpMarketBaseSpreadIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketBaseSpread` instruction without sending it. See
	 * `updatePerpMarketBaseSpread`.
	 * @returns The unsigned `updatePerpMarketBaseSpread` instruction.
	 */
	public async getUpdatePerpMarketBaseSpreadIx(
		perpMarketIndex: number,
		baseSpread: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketBaseSpread(
			baseSpread,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets how aggressively the AMM just-in-time-fills incoming taker orders against its own
	 * inventory before routing to the DLOB. Gated the same as `updatePerpMarketCurveUpdateIntensity`
	 * (warm admin via `HotAdminUpdatePerpMarket`'s `check_warm` constraint). Throws
	 * `DefaultError` on-chain if outside `0..=100`.
	 * @param perpMarketIndex - Perp market to update.
	 * @param ammJitIntensity - 0-100 intensity; 0 disables AMM JIT fills.
	 * @returns Transaction signature.
	 */
	public async updateAmmJitIntensity(
		perpMarketIndex: number,
		ammJitIntensity: number
	): Promise<TransactionSignature> {
		const updateAmmJitIntensityIx = await this.getUpdateAmmJitIntensityIx(
			perpMarketIndex,
			ammJitIntensity
		);

		const tx = await this.buildTransaction(updateAmmJitIntensityIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateAmmJitIntensity` instruction without sending it. See
	 * `updateAmmJitIntensity`.
	 * @returns The unsigned `updateAmmJitIntensity` instruction.
	 */
	public async getUpdateAmmJitIntensityIx(
		perpMarketIndex: number,
		ammJitIntensity: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateAmmJitIntensity(
			ammJitIntensity,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a perp market's display name. Requires warm admin (`check_warm`).
	 * @param perpMarketIndex - Perp market to rename.
	 * @param name - New display name, UTF-8 encoded and padded/truncated to 32 bytes.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketName(
		perpMarketIndex: number,
		name: string
	): Promise<TransactionSignature> {
		const updatePerpMarketNameIx = await this.getUpdatePerpMarketNameIx(
			perpMarketIndex,
			name
		);

		const tx = await this.buildTransaction(updatePerpMarketNameIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketName` instruction without sending it. See `updatePerpMarketName`.
	 * @returns The unsigned `updatePerpMarketName` instruction.
	 */
	public async getUpdatePerpMarketNameIx(
		perpMarketIndex: number,
		name: string
	): Promise<TransactionInstruction> {
		const nameBuffer = encodeName(name);
		return await this.program.instruction.updatePerpMarketName(nameBuffer, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	/**
	 * Sets a spot market's display name. Requires warm admin (`check_warm`).
	 * @param spotMarketIndex - Spot market to rename.
	 * @param name - New display name, UTF-8 encoded and padded/truncated to 32 bytes.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketName(
		spotMarketIndex: number,
		name: string
	): Promise<TransactionSignature> {
		const updateSpotMarketNameIx = await this.getUpdateSpotMarketNameIx(
			spotMarketIndex,
			name
		);

		const tx = await this.buildTransaction(updateSpotMarketNameIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketName` instruction without sending it. See `updateSpotMarketName`.
	 * @returns The unsigned `updateSpotMarketName` instruction.
	 */
	public async getUpdateSpotMarketNameIx(
		spotMarketIndex: number,
		name: string
	): Promise<TransactionInstruction> {
		const nameBuffer = encodeName(name);
		return await this.program.instruction.updateSpotMarketName(nameBuffer, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

	/**
	 * Sets which pool a spot market belongs to (used to segment markets, e.g. for LP-pool
	 * constituent grouping). Requires warm admin (`check_warm`).
	 * @param spotMarketIndex - Spot market to update.
	 * @param poolId - Target pool id.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketPoolId(
		spotMarketIndex: number,
		poolId: number
	): Promise<TransactionSignature> {
		const updateSpotMarketPoolIdIx = await this.getUpdateSpotMarketPoolIdIx(
			spotMarketIndex,
			poolId
		);

		const tx = await this.buildTransaction(updateSpotMarketPoolIdIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketPoolId` instruction without sending it. See `updateSpotMarketPoolId`.
	 * @returns The unsigned `updateSpotMarketPoolId` instruction.
	 */
	public async getUpdateSpotMarketPoolIdIx(
		spotMarketIndex: number,
		poolId: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketPoolId(poolId, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

	/**
	 * Sets a perp market's maximum allowed total bid/ask spread. Gated the same as
	 * `updatePerpMarketCurveUpdateIntensity` (warm admin via `HotAdminUpdatePerpMarket`'s
	 * `check_warm` constraint). Throws `DefaultError` on-chain if `maxSpread` is below the
	 * market's current `baseSpread` or exceeds `marginRatioInitial * 100`.
	 * @param perpMarketIndex - Perp market to update.
	 * @param maxSpread - New max spread, BID_ASK_SPREAD_PRECISION (1e6). Must be >= `baseSpread` and <= `marginRatioInitial * 100`.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketMaxSpread(
		perpMarketIndex: number,
		maxSpread: number
	): Promise<TransactionSignature> {
		const updatePerpMarketMaxSpreadIx =
			await this.getUpdatePerpMarketMaxSpreadIx(perpMarketIndex, maxSpread);

		const tx = await this.buildTransaction(updatePerpMarketMaxSpreadIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketMaxSpread` instruction without sending it. See
	 * `updatePerpMarketMaxSpread` for units and validation.
	 * @returns The unsigned `updatePerpMarketMaxSpread` instruction.
	 */
	public async getUpdatePerpMarketMaxSpreadIx(
		perpMarketIndex: number,
		maxSpread: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketMaxSpread(maxSpread, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
			},
		});
	}

	/**
	 * Replaces the protocol-wide perp `FeeStructure` (fee tiers, filler reward, AMM/IF
	 * fee split) wholesale. Requires warm admin (`check_warm`). On-chain,
	 * `validate_fee_structure` rejects a structure whose `amm_fee_numerator +
	 * if_fee_numerator` (both FEE_PERCENTAGE_DENOMINATOR-scaled) exceeds 100% of the
	 * trade-fee remainder, among other tier sanity checks.
	 * @param feeStructure - Full replacement fee structure (not a partial patch).
	 * @returns Transaction signature.
	 */
	public async updatePerpFeeStructure(
		feeStructure: FeeStructure
	): Promise<TransactionSignature> {
		const updatePerpFeeStructureIx = await this.getUpdatePerpFeeStructureIx(
			feeStructure
		);

		const tx = await this.buildTransaction(updatePerpFeeStructureIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpFeeStructure` instruction without sending it. See
	 * `updatePerpFeeStructure`.
	 * @returns The unsigned `updatePerpFeeStructure` instruction.
	 */
	public async getUpdatePerpFeeStructureIx(
		feeStructure: FeeStructure
	): Promise<TransactionInstruction> {
		return this.program.instruction.updatePerpFeeStructure(feeStructure, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	/**
	 * Replaces the protocol-wide spot `FeeStructure` wholesale. Requires warm admin
	 * (`check_warm`); see `updatePerpFeeStructure` for validation.
	 * @param feeStructure - Full replacement fee structure (not a partial patch).
	 * @returns Transaction signature.
	 */
	public async updateSpotFeeStructure(
		feeStructure: FeeStructure
	): Promise<TransactionSignature> {
		const updateSpotFeeStructureIx = await this.getUpdateSpotFeeStructureIx(
			feeStructure
		);

		const tx = await this.buildTransaction(updateSpotFeeStructureIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotFeeStructure` instruction without sending it. See
	 * `updateSpotFeeStructure`.
	 * @returns The unsigned `updateSpotFeeStructure` instruction.
	 */
	public async getUpdateSpotFeeStructureIx(
		feeStructure: FeeStructure
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotFeeStructure(feeStructure, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	/**
	 * Sets the fraction of a liquidatable position that may be closed immediately
	 * (before the `updateLiquidationDuration` ramp phases in the rest). Requires warm
	 * admin (`check_warm`). On-chain the liquidatable fraction ramps linearly from this
	 * floor up to 100% over `liquidationDuration` slots since the user's last active
	 * slot (see `calculate_max_pct_to_liquidate`); shortages under 50 QUOTE_PRECISION
	 * always liquidate in full regardless of this setting.
	 * @param initialPctToLiquidate - Initial liquidatable fraction, LIQUIDATION_PCT_PRECISION (1e4, e.g. 2500 = 25%).
	 * @returns Transaction signature.
	 */
	public async updateInitialPctToLiquidate(
		initialPctToLiquidate: number
	): Promise<TransactionSignature> {
		const updateInitialPctToLiquidateIx =
			await this.getUpdateInitialPctToLiquidateIx(initialPctToLiquidate);

		const tx = await this.buildTransaction(updateInitialPctToLiquidateIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateInitialPctToLiquidate` instruction without sending it. See
	 * `updateInitialPctToLiquidate`.
	 * @returns The unsigned `updateInitialPctToLiquidate` instruction.
	 */
	public async getUpdateInitialPctToLiquidateIx(
		initialPctToLiquidate: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateInitialPctToLiquidate(
			initialPctToLiquidate,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets how many slots it takes for a liquidation's max-closeable fraction to ramp
	 * from `initialPctToLiquidate` up to 100% (see `updateInitialPctToLiquidate`).
	 * Requires warm admin (`check_warm`).
	 * @param liquidationDuration - Ramp duration, slots (comment in `calculate_max_pct_to_liquidate` notes ~150 slots ≈ 1 minute at 400ms/slot).
	 * @returns Transaction signature.
	 */
	public async updateLiquidationDuration(
		liquidationDuration: number
	): Promise<TransactionSignature> {
		const updateLiquidationDurationIx =
			await this.getUpdateLiquidationDurationIx(liquidationDuration);

		const tx = await this.buildTransaction(updateLiquidationDurationIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateLiquidationDuration` instruction without sending it. See
	 * `updateLiquidationDuration`.
	 * @returns The unsigned `updateLiquidationDuration` instruction.
	 */
	public async getUpdateLiquidationDurationIx(
		liquidationDuration: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateLiquidationDuration(
			liquidationDuration,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets the extra maintenance-margin buffer applied when deciding whether a user is
	 * liquidatable, on top of the market's own maintenance margin ratio — a safety
	 * margin so liquidation triggers before a user is fully underwater. Requires warm
	 * admin (`check_warm`).
	 * @param updateLiquidationMarginBufferRatio - Extra margin buffer, MARGIN_PRECISION (1e4).
	 * @returns Transaction signature.
	 */
	public async updateLiquidationMarginBufferRatio(
		updateLiquidationMarginBufferRatio: number
	): Promise<TransactionSignature> {
		const updateLiquidationMarginBufferRatioIx =
			await this.getUpdateLiquidationMarginBufferRatioIx(
				updateLiquidationMarginBufferRatio
			);

		const tx = await this.buildTransaction(
			updateLiquidationMarginBufferRatioIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateLiquidationMarginBufferRatio` instruction without sending it.
	 * See `updateLiquidationMarginBufferRatio`.
	 * @returns The unsigned `updateLiquidationMarginBufferRatio` instruction.
	 */
	public async getUpdateLiquidationMarginBufferRatioIx(
		updateLiquidationMarginBufferRatio: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateLiquidationMarginBufferRatio(
			updateLiquidationMarginBufferRatio,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Replaces the protocol-wide `OracleGuardRails` (validity/confidence/divergence
	 * thresholds used to gate oracle-price-driven actions across every market).
	 * Requires warm admin (`check_warm`).
	 * @param oracleGuardRails - Full replacement guard-rail config (not a partial patch).
	 * @returns Transaction signature.
	 */
	public async updateOracleGuardRails(
		oracleGuardRails: OracleGuardRails
	): Promise<TransactionSignature> {
		const updateOracleGuardRailsIx = await this.getUpdateOracleGuardRailsIx(
			oracleGuardRails
		);

		const tx = await this.buildTransaction(updateOracleGuardRailsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateOracleGuardRails` instruction without sending it. See
	 * `updateOracleGuardRails`.
	 * @returns The unsigned `updateOracleGuardRails` instruction.
	 */
	public async getUpdateOracleGuardRailsIx(
		oracleGuardRails: OracleGuardRails
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateOracleGuardRails(
			oracleGuardRails,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets the buffer (past a perp market's `expiry_ts`) that must elapse before user
	 * positions in a `Settlement`-status market can be settled at the expiry price.
	 * Requires warm admin (`check_warm`).
	 * @param settlementDuration - Post-expiry settlement buffer, seconds.
	 * @returns Transaction signature.
	 */
	public async updateStateSettlementDuration(
		settlementDuration: number
	): Promise<TransactionSignature> {
		const updateStateSettlementDurationIx =
			await this.getUpdateStateSettlementDurationIx(settlementDuration);

		const tx = await this.buildTransaction(updateStateSettlementDurationIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateStateSettlementDuration` instruction without sending it. See
	 * `updateStateSettlementDuration`.
	 * @returns The unsigned `updateStateSettlementDuration` instruction.
	 */
	public async getUpdateStateSettlementDurationIx(
		settlementDuration: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateStateSettlementDuration(
			settlementDuration,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets the protocol-wide cap on sub-accounts per authority
	 * (`state.maxNumberOfSubAccounts`) and, via `get_init_user_fee`, the denominator
	 * against which `state.numberOfSubAccounts` utilization phases in the
	 * `initializeUser` anti-spam fee (see `updateStateMaxInitializeUserFee`). Requires
	 * warm admin (`check_warm`).
	 * @param maxNumberOfSubAccounts - New protocol-wide sub-account cap.
	 * @returns Transaction signature.
	 */
	public async updateStateMaxNumberOfSubAccounts(
		maxNumberOfSubAccounts: number
	): Promise<TransactionSignature> {
		const updateStateMaxNumberOfSubAccountsIx =
			await this.getUpdateStateMaxNumberOfSubAccountsIx(maxNumberOfSubAccounts);

		const tx = await this.buildTransaction(updateStateMaxNumberOfSubAccountsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateStateMaxNumberOfSubAccounts` instruction without sending it.
	 * See `updateStateMaxNumberOfSubAccounts`.
	 * @returns The unsigned `updateStateMaxNumberOfSubAccounts` instruction.
	 */
	public async getUpdateStateMaxNumberOfSubAccountsIx(
		maxNumberOfSubAccounts: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateStateMaxNumberOfSubAccounts(
			maxNumberOfSubAccounts,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets the cap on the anti-spam fee `initializeUser` may charge as
	 * `state.numberOfSubAccounts` approaches `state.maxNumberOfSubAccounts`. On-chain
	 * (`State::get_init_user_fee`) the fee is 0 below ~80% utilization and then scales
	 * up to this cap by the time the cap is reached; `0` disables the fee entirely.
	 * Requires warm admin (`check_warm`).
	 * @param maxInitializeUserFee - Fee cap, hundredths of a SOL (e.g. `100` = 1 SOL, `1` = 0.01 SOL).
	 * @returns Transaction signature.
	 */
	public async updateStateMaxInitializeUserFee(
		maxInitializeUserFee: number
	): Promise<TransactionSignature> {
		const updateStateMaxInitializeUserFeeIx =
			await this.getUpdateStateMaxInitializeUserFeeIx(maxInitializeUserFee);

		const tx = await this.buildTransaction(updateStateMaxInitializeUserFeeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateStateMaxInitializeUserFee` instruction without sending it. See
	 * `updateStateMaxInitializeUserFee`.
	 * @returns The unsigned `updateStateMaxInitializeUserFee` instruction.
	 */
	public async getUpdateStateMaxInitializeUserFeeIx(
		maxInitializeUserFee: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateStateMaxInitializeUserFee(
			maxInitializeUserFee,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets a spot market's withdraw guard threshold — the token-amount cap above which a
	 * single withdraw/borrow is blocked. Requires warm admin (`check_warm`, on the
	 * `AdminUpdateSpotMarketWithdrawGuardThreshold` context). On-chain the notional is priced
	 * with the max of the live oracle price and the 5-minute oracle TWAP (`StrictOraclePrice`),
	 * so a momentarily-manipulated-down oracle can't let an oversized threshold through;
	 * `validate_withdraw_guard_threshold` then re-derives the implied cap and rejects an
	 * inconsistent value.
	 * @param spotMarketIndex - Spot market to update.
	 * @param withdrawGuardThreshold - New threshold, the market's native token decimals.
	 * @param oracle - Must equal `spotMarket.oracle` — the account struct's `has_one = oracle`
	 *   constraint (`ErrorCode::InvalidOracle`) enforces this on-chain, so it is not a way to
	 *   point at a different price feed. When omitted, this is resolved automatically from the
	 *   local account cache (or, if not subscribed, by fetching and decoding the `SpotMarket`
	 *   account directly) — pass it explicitly only to avoid that extra lookup.
	 * @returns Transaction signature.
	 */
	public async updateWithdrawGuardThreshold(
		spotMarketIndex: number,
		withdrawGuardThreshold: BN,
		oracle?: PublicKey
	): Promise<TransactionSignature> {
		const updateWithdrawGuardThresholdIx =
			await this.getUpdateWithdrawGuardThresholdIx(
				spotMarketIndex,
				withdrawGuardThreshold,
				oracle
			);

		const tx = await this.buildTransaction(updateWithdrawGuardThresholdIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateWithdrawGuardThreshold` instruction without sending it. See
	 * `updateWithdrawGuardThreshold` — in particular, the `oracle` param must equal
	 * `spotMarket.oracle` (enforced by the `has_one` constraint) and is auto-resolved when
	 * omitted. Throws if the spot market account can't be found when not subscribed.
	 * @returns The unsigned `updateWithdrawGuardThreshold` instruction.
	 */
	public async getUpdateWithdrawGuardThresholdIx(
		spotMarketIndex: number,
		withdrawGuardThreshold: BN,
		oracle?: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			spotMarketIndex
		);

		if (!oracle) {
			const cachedSpotMarket = this.isSubscribed
				? this.getSpotMarketAccount(spotMarketIndex)
				: undefined;
			if (cachedSpotMarket) {
				oracle = cachedSpotMarket.oracle;
			} else {
				const accountInfo = await this.connection.getAccountInfo(
					spotMarketPublicKey
				);
				if (!accountInfo) {
					throw new Error(
						`Spot market account not found: ${spotMarketPublicKey.toString()}`
					);
				}
				const spotMarket = (
					this.program.account as any
				).spotMarket.coder.accounts.decodeUnchecked(
					'spotMarket',
					accountInfo.data
				) as SpotMarketAccount;
				oracle = spotMarket.oracle;
			}
		}

		return await this.program.instruction.updateWithdrawGuardThreshold(
			withdrawGuardThreshold,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketPublicKey,
					oracle,
				},
			}
		);
	}

	/**
	 * Sets a spot market's lending-gain carveouts: the share of deposit interest routed to the
	 * insurance fund (`ifFeeFactor`) and to the withdrawable protocol fee pool
	 * (`protocolFeeFactor`); lenders keep the remainder. Requires warm admin (`check_warm`).
	 * Throws `DefaultError` on-chain if the two factors don't sum to strictly less than 100%
	 * (a full 100% carveout would zero out lender interest and freeze the entire accrual path,
	 * including the IF/protocol credits themselves).
	 * @param spotMarketIndex - Spot market to update; must match the market account passed.
	 * @param ifFeeFactor - Insurance-fund carveout, IF_FACTOR_PRECISION (1e6).
	 * @param protocolFeeFactor - Protocol-fee-pool carveout, IF_FACTOR_PRECISION (1e6). `ifFeeFactor + protocolFeeFactor` must be < 1e6.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketIfFactor(
		spotMarketIndex: number,
		ifFeeFactor: number,
		protocolFeeFactor: number
	): Promise<TransactionSignature> {
		const updateSpotMarketIfFactorIx = await this.getUpdateSpotMarketIfFactorIx(
			spotMarketIndex,
			ifFeeFactor,
			protocolFeeFactor
		);

		const tx = await this.buildTransaction(updateSpotMarketIfFactorIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketIfFactor` instruction without sending it. See
	 * `updateSpotMarketIfFactor` for units and validation.
	 * @returns The unsigned `updateSpotMarketIfFactor` instruction.
	 */
	public async getUpdateSpotMarketIfFactorIx(
		spotMarketIndex: number,
		ifFeeFactor: number,
		protocolFeeFactor: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketIfFactor(
			spotMarketIndex,
			ifFeeFactor,
			protocolFeeFactor,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets how often a spot market's revenue pool may be settled to the insurance fund.
	 * Requires warm admin (`check_warm`).
	 * @param spotMarketIndex - Spot market to update.
	 * @param revenueSettlePeriod - Minimum interval between revenue settlements, seconds.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketRevenueSettlePeriod(
		spotMarketIndex: number,
		revenueSettlePeriod: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketRevenueSettlePeriodIx =
			await this.getUpdateSpotMarketRevenueSettlePeriodIx(
				spotMarketIndex,
				revenueSettlePeriod
			);

		const tx = await this.buildTransaction(
			updateSpotMarketRevenueSettlePeriodIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketRevenueSettlePeriod` instruction without sending it. See
	 * `updateSpotMarketRevenueSettlePeriod`.
	 * @returns The unsigned `updateSpotMarketRevenueSettlePeriod` instruction.
	 */
	public async getUpdateSpotMarketRevenueSettlePeriodIx(
		spotMarketIndex: number,
		revenueSettlePeriod: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketRevenueSettlePeriod(
			revenueSettlePeriod,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a spot market's maximum total deposit balance. Requires warm admin (`check_warm`).
	 * @param spotMarketIndex - Spot market to update.
	 * @param maxTokenDeposits - New deposit cap, the market's native token decimals. `0` disables the cap.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketMaxTokenDeposits(
		spotMarketIndex: number,
		maxTokenDeposits: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketMaxTokenDepositsIx =
			await this.getUpdateSpotMarketMaxTokenDepositsIx(
				spotMarketIndex,
				maxTokenDeposits
			);

		const tx = await this.buildTransaction(updateSpotMarketMaxTokenDepositsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketMaxTokenDeposits` instruction without sending it. See
	 * `updateSpotMarketMaxTokenDeposits`.
	 * @returns The unsigned `updateSpotMarketMaxTokenDeposits` instruction.
	 */
	public async getUpdateSpotMarketMaxTokenDepositsIx(
		spotMarketIndex: number,
		maxTokenDeposits: BN
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateSpotMarketMaxTokenDeposits(
			maxTokenDeposits,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Caps a spot market's total borrows as a fraction of its `maxTokenDeposits`, rather than
	 * an absolute token amount. Requires warm admin (`check_warm`). On-chain, the effective cap
	 * is `maxTokenDeposits * maxTokenBorrowsFraction / 10000`; the handler throws
	 * `InvalidSpotMarketInitialization` if current borrows already exceed the new cap.
	 * @param spotMarketIndex - Spot market to update.
	 * @param maxTokenBorrowsFraction - Fraction of `maxTokenDeposits` borrowable, in hundredths of a percent (10000 = 100%).
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketMaxTokenBorrows(
		spotMarketIndex: number,
		maxTokenBorrowsFraction: number
	): Promise<TransactionSignature> {
		const updateSpotMarketMaxTokenBorrowsIx =
			await this.getUpdateSpotMarketMaxTokenBorrowsIx(
				spotMarketIndex,
				maxTokenBorrowsFraction
			);

		const tx = await this.buildTransaction(updateSpotMarketMaxTokenBorrowsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketMaxTokenBorrows` instruction without sending it. See
	 * `updateSpotMarketMaxTokenBorrows`.
	 * @returns The unsigned `updateSpotMarketMaxTokenBorrows` instruction.
	 */
	public async getUpdateSpotMarketMaxTokenBorrowsIx(
		spotMarketIndex: number,
		maxTokenBorrowsFraction: number
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateSpotMarketMaxTokenBorrows(
			maxTokenBorrowsFraction,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets the deposit-notional threshold above which a spot market's `initialAssetWeight`
	 * scales down (see `initializeSpotMarket`'s `scaleInitialAssetWeightStart`). Requires warm
	 * admin (`check_warm`). `0` disables scaling.
	 * @param spotMarketIndex - Spot market to update.
	 * @param scaleInitialAssetWeightStart - Deposit-notional threshold, QUOTE_PRECISION (1e6). `0` disables scaling.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketScaleInitialAssetWeightStart(
		spotMarketIndex: number,
		scaleInitialAssetWeightStart: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketScaleInitialAssetWeightStartIx =
			await this.getUpdateSpotMarketScaleInitialAssetWeightStartIx(
				spotMarketIndex,
				scaleInitialAssetWeightStart
			);

		const tx = await this.buildTransaction(
			updateSpotMarketScaleInitialAssetWeightStartIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketScaleInitialAssetWeightStart` instruction without sending it.
	 * See `updateSpotMarketScaleInitialAssetWeightStart`.
	 * @returns The unsigned `updateSpotMarketScaleInitialAssetWeightStart` instruction.
	 */
	public async getUpdateSpotMarketScaleInitialAssetWeightStartIx(
		spotMarketIndex: number,
		scaleInitialAssetWeightStart: BN
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateSpotMarketScaleInitialAssetWeightStart(
			scaleInitialAssetWeightStart,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets how long an insurance-fund staker's unstake request must sit in escrow before it can
	 * be completed for a given spot market. Requires warm admin (`check_warm`).
	 * @param spotMarketIndex - Spot market whose insurance fund to update.
	 * @param insuranceWithdrawEscrowPeriod - Unstaking escrow duration, seconds.
	 * @returns Transaction signature.
	 */
	public async updateInsuranceFundUnstakingPeriod(
		spotMarketIndex: number,
		insuranceWithdrawEscrowPeriod: BN
	): Promise<TransactionSignature> {
		const updateInsuranceFundUnstakingPeriodIx =
			await this.getUpdateInsuranceFundUnstakingPeriodIx(
				spotMarketIndex,
				insuranceWithdrawEscrowPeriod
			);

		const tx = await this.buildTransaction(
			updateInsuranceFundUnstakingPeriodIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateInsuranceFundUnstakingPeriod` instruction without sending it. See
	 * `updateInsuranceFundUnstakingPeriod`.
	 * @returns The unsigned `updateInsuranceFundUnstakingPeriod` instruction.
	 */
	public async getUpdateInsuranceFundUnstakingPeriodIx(
		spotMarketIndex: number,
		insuranceWithdrawEscrowPeriod: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateInsuranceFundUnstakingPeriod(
			insuranceWithdrawEscrowPeriod,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Swaps a perp market's oracle account/source. Requires **cold** admin
	 * (`AdminUpdatePerpMarketOracle`'s `check_cold` constraint) — a lesser admin swapping the
	 * oracle could re-price margin/liquidation math and any `AmmCache`-derived value at will.
	 * On-chain the handler reads both the new and current (`oldOracle`) oracle prices and,
	 * unless `skipInvaraintCheck` is `true`, throws `DefaultError` if the new price is
	 * non-positive or diverges more than 10% from the old one. If the market is present in the
	 * `AmmCache`, its cached fields are refreshed from the new oracle in the same instruction.
	 * @param perpMarketIndex - Perp market to update.
	 * @param oracle - New oracle account.
	 * @param oracleSource - Oracle provider/format for `oracle`.
	 * @param skipInvaraintCheck - If `true`, skips the on-chain non-positive/10%-divergence sanity check against the current oracle price. Default `false`.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketOracle(
		perpMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource,
		skipInvaraintCheck = false
	): Promise<TransactionSignature> {
		const updatePerpMarketOracleIx = await this.getUpdatePerpMarketOracleIx(
			perpMarketIndex,
			oracle,
			oracleSource,
			skipInvaraintCheck
		);

		const tx = await this.buildTransaction(updatePerpMarketOracleIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketOracle` instruction without sending it. See
	 * `updatePerpMarketOracle`. Resolves `oldOracle` from the locally-cached perp market account
	 * (throws if `perpMarketIndex` isn't tracked by the account subscriber) and passes the
	 * program's singleton `AmmCache` PDA.
	 * @returns The unsigned `updatePerpMarketOracle` instruction.
	 */
	public async getUpdatePerpMarketOracleIx(
		perpMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource,
		skipInvaraintCheck = false
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		return await this.program.instruction.updatePerpMarketOracle(
			oracle,
			oracleSource,
			skipInvaraintCheck,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
					oracle: oracle,
					oldOracle: perpMarketAccount.oracle,
					ammCache: getAmmCachePublicKey(this.program.programId),
				},
			}
		);
	}

	/**
	 * Sets a perp market's minimum base-size increment and minimum price increment for orders.
	 * Requires warm admin (`check_warm`). On-chain, throws `DefaultError` unless both are > 0
	 * and `stepSize <= 2_000_000_000` (kept below `i32::MAX` for the LP's remainder-base-asset
	 * accounting).
	 * @param perpMarketIndex - Perp market to update.
	 * @param stepSize - Minimum base-size increment, BASE_PRECISION (1e9).
	 * @param tickSize - Minimum price increment, PRICE_PRECISION (1e6).
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketStepSizeAndTickSize(
		perpMarketIndex: number,
		stepSize: BN,
		tickSize: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketStepSizeAndTickSizeIx =
			await this.getUpdatePerpMarketStepSizeAndTickSizeIx(
				perpMarketIndex,
				stepSize,
				tickSize
			);

		const tx = await this.buildTransaction(
			updatePerpMarketStepSizeAndTickSizeIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketStepSizeAndTickSize` instruction without sending it. See
	 * `updatePerpMarketStepSizeAndTickSize`.
	 * @returns The unsigned `updatePerpMarketStepSizeAndTickSize` instruction.
	 */
	public async getUpdatePerpMarketStepSizeAndTickSizeIx(
		perpMarketIndex: number,
		stepSize: BN,
		tickSize: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketStepSizeAndTickSize(
			stepSize,
			tickSize,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a perp market's minimum order base size (`market.marketStats.minOrderSize`). Requires
	 * warm admin (`check_warm`). On-chain, throws `DefaultError` unless `orderSize > 0`.
	 * @param perpMarketIndex - Perp market to update.
	 * @param orderSize - Minimum base order size, BASE_PRECISION (1e9).
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketMinOrderSize(
		perpMarketIndex: number,
		orderSize: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketMinOrderSizeIx =
			await this.getUpdatePerpMarketMinOrderSizeIx(perpMarketIndex, orderSize);

		const tx = await this.buildTransaction(updatePerpMarketMinOrderSizeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketMinOrderSize` instruction without sending it. See
	 * `updatePerpMarketMinOrderSize`.
	 * @returns The unsigned `updatePerpMarketMinOrderSize` instruction.
	 */
	public async getUpdatePerpMarketMinOrderSizeIx(
		perpMarketIndex: number,
		orderSize: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketMinOrderSize(
			orderSize,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a spot market's minimum base-size increment and minimum price increment for orders.
	 * Requires warm admin (`check_warm`). On-chain, the quote/index-0 market (`marketIndex ===
	 * 0`) is exempt from the `> 0` check other spot markets must satisfy.
	 * @param spotMarketIndex - Spot market to update.
	 * @param stepSize - Minimum base-size increment, market's native token decimals.
	 * @param tickSize - Minimum price increment, PRICE_PRECISION (1e6).
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketStepSizeAndTickSize(
		spotMarketIndex: number,
		stepSize: BN,
		tickSize: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketStepSizeAndTickSizeIx =
			await this.getUpdateSpotMarketStepSizeAndTickSizeIx(
				spotMarketIndex,
				stepSize,
				tickSize
			);

		const tx = await this.buildTransaction(
			updateSpotMarketStepSizeAndTickSizeIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketStepSizeAndTickSize` instruction without sending it. See
	 * `updateSpotMarketStepSizeAndTickSize`.
	 * @returns The unsigned `updateSpotMarketStepSizeAndTickSize` instruction.
	 */
	public async getUpdateSpotMarketStepSizeAndTickSizeIx(
		spotMarketIndex: number,
		stepSize: BN,
		tickSize: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketStepSizeAndTickSize(
			stepSize,
			tickSize,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a spot market's minimum order base size. Requires warm admin (`check_warm`). On-chain,
	 * the quote/index-0 market is exempt from the `> 0` check other spot markets must satisfy.
	 * @param spotMarketIndex - Spot market to update.
	 * @param orderSize - Minimum base order size, market's native token decimals.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketMinOrderSize(
		spotMarketIndex: number,
		orderSize: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketMinOrderSizeIx =
			await this.program.instruction.updateSpotMarketMinOrderSize(orderSize, {
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			});

		const tx = await this.buildTransaction(updateSpotMarketMinOrderSizeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketMinOrderSize` instruction without sending it. See
	 * `updateSpotMarketMinOrderSize`.
	 * @returns The unsigned `updateSpotMarketMinOrderSize` instruction.
	 */
	public async getUpdateSpotMarketMinOrderSizeIx(
		spotMarketIndex: number,
		orderSize: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketMinOrderSize(
			orderSize,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Schedules a perp market for expiry: sets `expiryTs` and immediately flips the market to
	 * `MarketStatus.ReduceOnly` (existing positions can only be reduced from this point).
	 * Requires warm admin (`check_warm`). Throws `DefaultError` on-chain if `expiryTs` is not
	 * strictly after the current on-chain clock timestamp. This does not settle or delist the
	 * market — see `settleExpiredMarketPoolsToRevenuePool` for the later teardown step.
	 * @param perpMarketIndex - Perp market to schedule for expiry.
	 * @param expiryTs - Unix timestamp (seconds) after which the market is expired; must be in the future.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketExpiry(
		perpMarketIndex: number,
		expiryTs: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketExpiryIx = await this.getUpdatePerpMarketExpiryIx(
			perpMarketIndex,
			expiryTs
		);
		const tx = await this.buildTransaction(updatePerpMarketExpiryIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketExpiry` instruction without sending it. See
	 * `updatePerpMarketExpiry`.
	 * @returns The unsigned `updatePerpMarketExpiry` instruction.
	 */
	public async getUpdatePerpMarketExpiryIx(
		perpMarketIndex: number,
		expiryTs: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketExpiry(expiryTs, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	/**
	 * Swaps a spot market's oracle account/source. Requires **cold** admin
	 * (`AdminUpdateSpotMarketOracle`'s `check_cold` constraint) — a lesser admin swapping the
	 * oracle could re-price the withdraw guard threshold notional cap and all margin math at
	 * will. On-chain the handler reads both the new and current (`oldOracle`) oracle prices and,
	 * unless `skipInvaraintCheck` is `true`, throws `DefaultError` if the new price is
	 * non-positive or diverges more than 10% from the old one.
	 * @param spotMarketIndex - Spot market to update.
	 * @param oracle - New oracle account.
	 * @param oracleSource - Oracle provider/format for `oracle`.
	 * @param skipInvaraintCheck - If `true`, skips the on-chain non-positive/10%-divergence sanity check against the current oracle price. Default `false`.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketOracle(
		spotMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource,
		skipInvaraintCheck = false
	): Promise<TransactionSignature> {
		const updateSpotMarketOracleIx = await this.getUpdateSpotMarketOracleIx(
			spotMarketIndex,
			oracle,
			oracleSource,
			skipInvaraintCheck
		);

		const tx = await this.buildTransaction(updateSpotMarketOracleIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketOracle` instruction without sending it. See
	 * `updateSpotMarketOracle`. Resolves `oldOracle` from the locally-cached spot market account
	 * (throws if `spotMarketIndex` isn't tracked by the account subscriber).
	 * @returns The unsigned `updateSpotMarketOracle` instruction.
	 */
	public async getUpdateSpotMarketOracleIx(
		spotMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource,
		skipInvaraintCheck = false
	): Promise<TransactionInstruction> {
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(spotMarketIndex);
		return await this.program.instruction.updateSpotMarketOracle(
			oracle,
			oracleSource,
			skipInvaraintCheck,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
					oracle: oracle,
					oldOracle: spotMarketAccount.oracle,
				},
			}
		);
	}

	/**
	 * Enables or disables limit-order placement/fills on a spot market (`spotMarket.ordersEnabled`).
	 * Requires warm admin (`check_warm`).
	 * @param spotMarketIndex - Spot market to update.
	 * @param ordersEnabled - Whether spot orders are enabled for this market.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketOrdersEnabled(
		spotMarketIndex: number,
		ordersEnabled: boolean
	): Promise<TransactionSignature> {
		const updateSpotMarketOrdersEnabledIx =
			await this.getUpdateSpotMarketOrdersEnabledIx(
				spotMarketIndex,
				ordersEnabled
			);

		const tx = await this.buildTransaction(updateSpotMarketOrdersEnabledIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketOrdersEnabled` instruction without sending it. See
	 * `updateSpotMarketOrdersEnabled`.
	 * @returns The unsigned `updateSpotMarketOrdersEnabled` instruction.
	 */
	public async getUpdateSpotMarketOrdersEnabledIx(
		spotMarketIndex: number,
		ordersEnabled: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketOrdersEnabled(
			ordersEnabled,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a spot market's insurance-fund operation pause bitmask (`InsuranceFundOperation`:
	 * `Init` 0b0001, `Add` 0b0010, `RequestRemove` 0b0100, `Remove` 0b1000). Gated by
	 * `PauseAdminUpdateSpotMarket` — callable by cold, warm, or the dedicated `pause_admin`; a
	 * caller authorized only via `pause_admin` (not warm/cold) may only *add* pause bits, never
	 * clear existing ones (`require_pause_only_added`).
	 * @param spotMarketIndex - Spot market to update.
	 * @param pausedOperations - New `InsuranceFundOperation` bitmask.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketIfPausedOperations(
		spotMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionSignature> {
		const updateSpotMarketIfStakingDisabledIx =
			await this.getUpdateSpotMarketIfPausedOperationsIx(
				spotMarketIndex,
				pausedOperations
			);

		const tx = await this.buildTransaction(updateSpotMarketIfStakingDisabledIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketIfPausedOperations` instruction without sending it. See
	 * `updateSpotMarketIfPausedOperations`.
	 * @returns The unsigned `updateSpotMarketIfPausedOperations` instruction.
	 */
	public async getUpdateSpotMarketIfPausedOperationsIx(
		spotMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketIfPausedOperations(
			pausedOperations,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Schedules a spot market for expiry: sets `expiryTs` and immediately flips the market to
	 * `MarketStatus.ReduceOnly`. Requires warm admin (`check_warm`). Throws `DefaultError`
	 * on-chain if `expiryTs` is not strictly after the current on-chain clock timestamp.
	 * @param spotMarketIndex - Spot market to schedule for expiry.
	 * @param expiryTs - Unix timestamp (seconds) after which the market is expired; must be in the future.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketExpiry(
		spotMarketIndex: number,
		expiryTs: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketExpiryIx = await this.getUpdateSpotMarketExpiryIx(
			spotMarketIndex,
			expiryTs
		);

		const tx = await this.buildTransaction(updateSpotMarketExpiryIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketExpiry` instruction without sending it. See
	 * `updateSpotMarketExpiry`.
	 * @returns The unsigned `updateSpotMarketExpiry` instruction.
	 */
	public async getUpdateSpotMarketExpiryIx(
		spotMarketIndex: number,
		expiryTs: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketExpiry(expiryTs, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

	/**
	 * @deprecated The `update_whitelist_mint` instruction handler exists in the Rust
	 * program (`handle_update_whitelist_mint`) but its `#[program]` entry point is
	 * currently commented out in `lib.rs`, so it is absent from the deployed program
	 * and from the generated IDL. Calling this (or `getUpdateWhitelistMintIx`) throws
	 * at runtime — `this.program.instruction` has no `updateWhitelistMint` member —
	 * regardless of the `as any` cast used to bypass the TS type check. Do not call
	 * until the on-chain entry point is re-enabled.
	 * @param whitelistMint - Intended new `state.whitelistMint` (unused while dead).
	 * @returns Transaction signature (never reached).
	 */
	public async updateWhitelistMint(
		whitelistMint?: PublicKey
	): Promise<TransactionSignature> {
		const updateWhitelistMintIx = await this.getUpdateWhitelistMintIx(
			whitelistMint
		);

		const tx = await this.buildTransaction(updateWhitelistMintIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * @deprecated See `updateWhitelistMint` — the underlying `update_whitelist_mint`
	 * instruction is not wired up on-chain and is missing from the IDL; this throws
	 * at runtime.
	 * @returns Never resolves successfully.
	 */
	public async getUpdateWhitelistMintIx(
		whitelistMint?: PublicKey
	): Promise<TransactionInstruction> {
		return await (this.program.instruction as any).updateWhitelistMint(
			whitelistMint,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets `state.discountMint` — a token that grants trade-fee discounts to holders
	 * (checked against the `FeeTier` discount rules at fill time). Requires warm admin
	 * (`check_warm`).
	 * @param discountMint - New discount-token mint.
	 * @returns Transaction signature.
	 */
	public async updateDiscountMint(
		discountMint: PublicKey
	): Promise<TransactionSignature> {
		const updateDiscountMintIx = await this.getUpdateDiscountMintIx(
			discountMint
		);

		const tx = await this.buildTransaction(updateDiscountMintIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateDiscountMint` instruction without sending it. See
	 * `updateDiscountMint`.
	 * @returns The unsigned `updateDiscountMint` instruction.
	 */
	public async getUpdateDiscountMintIx(
		discountMint: PublicKey
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateDiscountMint(discountMint, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	/**
	 * Sets a spot market's deposit/borrow margin weights and IMF factor. Requires warm admin
	 * (`check_warm`). On-chain, `validate_margin_weights` enforces the standard invariants
	 * (asset weights <= SPOT_WEIGHT_PRECISION, liability weights >= SPOT_WEIGHT_PRECISION,
	 * initial at least as conservative as maintenance, and consistency with `imfFactor`).
	 * @param spotMarketIndex - Spot market to update.
	 * @param initialAssetWeight - Initial (deposit) asset weight, SPOT_WEIGHT_PRECISION (1e4).
	 * @param maintenanceAssetWeight - Maintenance asset weight, SPOT_WEIGHT_PRECISION (1e4).
	 * @param initialLiabilityWeight - Initial (borrow) liability weight, SPOT_WEIGHT_PRECISION (1e4).
	 * @param maintenanceLiabilityWeight - Maintenance liability weight, SPOT_WEIGHT_PRECISION (1e4).
	 * @param imfFactor - Increases weight penalty as position size grows, SPOT_IMF_PRECISION (1e6). Default 0.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketMarginWeights(
		spotMarketIndex: number,
		initialAssetWeight: number,
		maintenanceAssetWeight: number,
		initialLiabilityWeight: number,
		maintenanceLiabilityWeight: number,
		imfFactor = 0
	): Promise<TransactionSignature> {
		const updateSpotMarketMarginWeightsIx =
			await this.getUpdateSpotMarketMarginWeightsIx(
				spotMarketIndex,
				initialAssetWeight,
				maintenanceAssetWeight,
				initialLiabilityWeight,
				maintenanceLiabilityWeight,
				imfFactor
			);

		const tx = await this.buildTransaction(updateSpotMarketMarginWeightsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketMarginWeights` instruction without sending it. See
	 * `updateSpotMarketMarginWeights`.
	 * @returns The unsigned `updateSpotMarketMarginWeights` instruction.
	 */
	public async getUpdateSpotMarketMarginWeightsIx(
		spotMarketIndex: number,
		initialAssetWeight: number,
		maintenanceAssetWeight: number,
		initialLiabilityWeight: number,
		maintenanceLiabilityWeight: number,
		imfFactor = 0
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketMarginWeights(
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			imfFactor,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a spot market's interest-rate curve: the utilization/rate kink plus the max rate at
	 * 100% utilization. Requires warm admin (`check_warm`). On-chain, `validate_borrow_rate`
	 * checks the curve is well-formed (kink within bounds, rates monotonically increasing,
	 * `min_borrow_rate` at or below `optimal_borrow_rate`).
	 * @param spotMarketIndex - Spot market to update.
	 * @param optimalUtilization - Utilization at the borrow-rate kink, SPOT_UTILIZATION_PRECISION (1e6, 100% = 1e6).
	 * @param optimalBorrowRate - Borrow rate at `optimalUtilization`, SPOT_RATE_PRECISION (1e6, 100% APR = 1e6).
	 * @param optimalMaxRate - Borrow rate at 100% utilization, SPOT_RATE_PRECISION (1e6).
	 * @param minBorrowRate - Floor borrow rate at 0% utilization, in units of 0.5% (i.e. `SPOT_RATE_PRECISION / 200` per unit); omit to leave `spotMarket.minBorrowRate` unchanged.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketBorrowRate(
		spotMarketIndex: number,
		optimalUtilization: number,
		optimalBorrowRate: number,
		optimalMaxRate: number,
		minBorrowRate?: number | undefined
	): Promise<TransactionSignature> {
		const updateSpotMarketBorrowRateIx =
			await this.getUpdateSpotMarketBorrowRateIx(
				spotMarketIndex,
				optimalUtilization,
				optimalBorrowRate,
				optimalMaxRate,
				minBorrowRate
			);

		const tx = await this.buildTransaction(updateSpotMarketBorrowRateIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketBorrowRate` instruction without sending it. See
	 * `updateSpotMarketBorrowRate`.
	 * @returns The unsigned `updateSpotMarketBorrowRate` instruction.
	 */
	public async getUpdateSpotMarketBorrowRateIx(
		spotMarketIndex: number,
		optimalUtilization: number,
		optimalBorrowRate: number,
		optimalMaxRate: number,
		minBorrowRate?: number | undefined
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketBorrowRate(
			optimalUtilization,
			optimalBorrowRate,
			optimalMaxRate,
			minBorrowRate,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a spot market's `AssetTier` (collateral-usability gate for cross-margin). Requires
	 * warm admin (`check_warm`). On-chain, if `spotMarket.initialAssetWeight > 0` (the market is
	 * currently usable as collateral), the new tier must be `AssetTier.COLLATERAL` or
	 * `AssetTier.PROTECTED` — otherwise it throws `DefaultError`; zero the initial asset weight
	 * first to move a market to a lesser tier.
	 * @param spotMarketIndex - Spot market to update.
	 * @param assetTier - New asset tier.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketAssetTier(
		spotMarketIndex: number,
		assetTier: AssetTier
	): Promise<TransactionSignature> {
		const updateSpotMarketAssetTierIx =
			await this.getUpdateSpotMarketAssetTierIx(spotMarketIndex, assetTier);

		const tx = await this.buildTransaction(updateSpotMarketAssetTierIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketAssetTier` instruction without sending it. See
	 * `updateSpotMarketAssetTier`.
	 * @returns The unsigned `updateSpotMarketAssetTier` instruction.
	 */
	public async getUpdateSpotMarketAssetTierIx(
		spotMarketIndex: number,
		assetTier: AssetTier
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketAssetTier(assetTier, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

	/**
	 * Sets a spot market's `MarketStatus` directly. Requires warm admin (`check_warm`). Unlike
	 * `updatePerpMarketStatus`, the spot handler applies no restriction on the target status —
	 * `Delisted`/`Settlement` can be set here directly (there is no separate spot
	 * settlement-teardown instruction).
	 * @param spotMarketIndex - Spot market to update.
	 * @param marketStatus - New market status.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketStatus(
		spotMarketIndex: number,
		marketStatus: MarketStatus
	): Promise<TransactionSignature> {
		const updateSpotMarketStatusIx = await this.getUpdateSpotMarketStatusIx(
			spotMarketIndex,
			marketStatus
		);

		const tx = await this.buildTransaction(updateSpotMarketStatusIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketStatus` instruction without sending it. See
	 * `updateSpotMarketStatus`.
	 * @returns The unsigned `updateSpotMarketStatus` instruction.
	 */
	public async getUpdateSpotMarketStatusIx(
		spotMarketIndex: number,
		marketStatus: MarketStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketStatus(marketStatus, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

	/**
	 * Sets a spot market's operation pause bitmask (`SpotOperation`: `UpdateCumulativeInterest`
	 * 0b00001, `Fill` 0b00010, `Deposit` 0b00100, `Withdraw` 0b01000, `Liquidation` 0b10000).
	 * Gated by `PauseAdminUpdateSpotMarket` — callable by cold, warm, or the dedicated
	 * `pause_admin`; a caller authorized only via `pause_admin` may only *add* pause bits, never
	 * clear existing ones (`require_pause_only_added`).
	 * @param spotMarketIndex - Spot market to update.
	 * @param pausedOperations - New `SpotOperation` bitmask.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketPausedOperations(
		spotMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionSignature> {
		const updateSpotMarketPausedOperationsIx =
			await this.getUpdateSpotMarketPausedOperationsIx(
				spotMarketIndex,
				pausedOperations
			);

		const tx = await this.buildTransaction(updateSpotMarketPausedOperationsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketPausedOperations` instruction without sending it. See
	 * `updateSpotMarketPausedOperations`.
	 * @returns The unsigned `updateSpotMarketPausedOperations` instruction.
	 */
	public async getUpdateSpotMarketPausedOperationsIx(
		spotMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketPausedOperations(
			pausedOperations,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a perp market's `MarketStatus` directly. Requires warm admin (`check_warm`). On-chain,
	 * throws `DefaultError` if the target status is `Delisted` or `Settlement` — those are only
	 * reached through the market-expiry lifecycle (`updatePerpMarketExpiry` -> `ReduceOnly`,
	 * then the keeper's `settleExpiredMarket` -> `Settlement`, then
	 * `settleExpiredMarketPoolsToRevenuePool` -> `Delisted`), never set directly here.
	 * @param perpMarketIndex - Perp market to update.
	 * @param marketStatus - New market status; must not be `Delisted` or `Settlement`.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketStatus(
		perpMarketIndex: number,
		marketStatus: MarketStatus
	): Promise<TransactionSignature> {
		const updatePerpMarketStatusIx = await this.getUpdatePerpMarketStatusIx(
			perpMarketIndex,
			marketStatus
		);

		const tx = await this.buildTransaction(updatePerpMarketStatusIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketStatus` instruction without sending it. See
	 * `updatePerpMarketStatus`.
	 * @returns The unsigned `updatePerpMarketStatus` instruction.
	 */
	public async getUpdatePerpMarketStatusIx(
		perpMarketIndex: number,
		marketStatus: MarketStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketStatus(marketStatus, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	/**
	 * Sets a perp market's operation pause bitmask (`PerpOperation`: `UpdateFunding` 0b00000001,
	 * `AmmFill` 0b00000010, `Fill` 0b00000100, `SettlePnl` 0b00001000, `SettlePnlWithPosition`
	 * 0b00010000, `Liquidation` 0b00100000, `AmmImmediateFill` 0b01000000, `SettleRevPool`
	 * 0b10000000). Gated by `PauseAdminUpdatePerpMarket` — callable by cold, warm, or the
	 * dedicated `pause_admin`. Authority matrix on-chain: **cold** may set any value; **warm**
	 * may only flip the `UpdateFunding` / `SettleRevPool` bits, all others must be preserved
	 * (throws `DefaultError` otherwise); **pause_admin** may set any bit but only *add* pause
	 * bits, never clear them (`require_pause_only_added`).
	 * @param perpMarketIndex - Perp market to update.
	 * @param pausedOperations - New `PerpOperation` bitmask.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketPausedOperations(
		perpMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionSignature> {
		const updatePerpMarketPausedOperationsIx =
			await this.getUpdatePerpMarketPausedOperationsIx(
				perpMarketIndex,
				pausedOperations
			);

		const tx = await this.buildTransaction(updatePerpMarketPausedOperationsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketPausedOperations` instruction without sending it. See
	 * `updatePerpMarketPausedOperations`.
	 * @returns The unsigned `updatePerpMarketPausedOperations` instruction.
	 */
	public async getUpdatePerpMarketPausedOperationsIx(
		perpMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketPausedOperations(
			pausedOperations,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a perp market's `ContractTier` (risk/collateral classification). Requires warm admin
	 * (`check_warm`).
	 * @param perpMarketIndex - Perp market to update.
	 * @param contractTier - New contract tier.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketContractTier(
		perpMarketIndex: number,
		contractTier: ContractTier
	): Promise<TransactionSignature> {
		const updatePerpMarketContractTierIx =
			await this.getUpdatePerpMarketContractTierIx(
				perpMarketIndex,
				contractTier
			);

		const tx = await this.buildTransaction(updatePerpMarketContractTierIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketContractTier` instruction without sending it. See
	 * `updatePerpMarketContractTier`.
	 * @returns The unsigned `updatePerpMarketContractTier` instruction.
	 */
	public async getUpdatePerpMarketContractTierIx(
		perpMarketIndex: number,
		contractTier: ContractTier
	): Promise<TransactionInstruction> {
		return await (this.program.instruction as any).updatePerpMarketContractTier(
			contractTier,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
					ammCache: getAmmCachePublicKey(this.program.programId),
				},
			}
		);
	}

	/**
	 * Sets `state.exchangeStatus`, the protocol-wide pause bitmask (`ExchangeStatus`).
	 * Reachable by cold, warm, or `pauseAdmin` (`PauseAdminUpdateState`'s
	 * `check_pause`), but the handler enforces `require_pause_only_added`: a caller
	 * authorised only via `pauseAdmin` (not warm/cold) may add pause bits but never
	 * clear one — cold/warm can set any value, including unpausing. The `admin`
	 * account below defaults to `coldAdmin`; a pause-admin-only caller must override it
	 * with their own pubkey.
	 * @param exchangeStatus - New pause bitmask, `ExchangeStatus` (bit values; `PAUSED` = 255 pauses everything).
	 * @returns Transaction signature.
	 */
	public async updateExchangeStatus(
		exchangeStatus: ExchangeStatus
	): Promise<TransactionSignature> {
		const updateExchangeStatusIx = await this.getUpdateExchangeStatusIx(
			exchangeStatus
		);

		const tx = await this.buildTransaction(updateExchangeStatusIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateExchangeStatus` instruction without sending it. See
	 * `updateExchangeStatus`.
	 * @returns The unsigned `updateExchangeStatus` instruction.
	 */
	public async getUpdateExchangeStatusIx(
		exchangeStatus: ExchangeStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateExchangeStatus(exchangeStatus, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	/**
	 * Sets `state.solvencyStatus` (`SolvencyStatus`), gating internal solvency-repair
	 * flows (bankruptcy / pnl-deficit resolution) independently of
	 * `ExchangeStatus.WITHDRAW_PAUSED`. Cold-only — unlike `updateExchangeStatus`, the
	 * `ColdAdminUpdateState` context accepts only `state.coldAdmin`; there is no
	 * pause-admin or warm-admin path and no bit-add-only restriction.
	 * @param solvencyStatus - New bitmask, `SolvencyStatus` (currently one bit: `SOLVENCY_REPAIR_PAUSED`).
	 * @returns Transaction signature.
	 */
	public async updateSolvencyStatus(
		solvencyStatus: SolvencyStatus
	): Promise<TransactionSignature> {
		const updateSolvencyStatusIx = await this.getUpdateSolvencyStatusIx(
			solvencyStatus
		);

		const tx = await this.buildTransaction(updateSolvencyStatusIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSolvencyStatus` instruction without sending it. See
	 * `updateSolvencyStatus`.
	 * @returns The unsigned `updateSolvencyStatus` instruction.
	 */
	public async getUpdateSolvencyStatusIx(
		solvencyStatus: SolvencyStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSolvencyStatus(solvencyStatus, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	/**
	 * Sets the protocol-wide default minimum perp-order auction duration
	 * (`state.minPerpAuctionDuration`) — orders placed without an explicit longer
	 * auction fall back to this floor. Requires warm admin (`check_warm`).
	 * @param minDuration - Minimum auction duration, slots.
	 * @returns Transaction signature.
	 */
	public async updatePerpAuctionDuration(
		minDuration: BN | number
	): Promise<TransactionSignature> {
		const updatePerpAuctionDurationIx =
			await this.getUpdatePerpAuctionDurationIx(minDuration);

		const tx = await this.buildTransaction(updatePerpAuctionDurationIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpAuctionDuration` instruction without sending it. See
	 * `updatePerpAuctionDuration`.
	 * @returns The unsigned `updatePerpAuctionDuration` instruction.
	 */
	public async getUpdatePerpAuctionDurationIx(
		minDuration: BN | number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpAuctionDuration(
			typeof minDuration === 'number' ? minDuration : minDuration.toNumber(),
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets the protocol-wide default spot-order auction duration
	 * (`state.defaultSpotAuctionDuration`). Requires warm admin (`check_warm`).
	 * @param defaultAuctionDuration - Default auction duration, slots.
	 * @returns Transaction signature.
	 */
	public async updateSpotAuctionDuration(
		defaultAuctionDuration: number
	): Promise<TransactionSignature> {
		const updateSpotAuctionDurationIx =
			await this.getUpdateSpotAuctionDurationIx(defaultAuctionDuration);

		const tx = await this.buildTransaction(updateSpotAuctionDurationIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotAuctionDuration` instruction without sending it. See
	 * `updateSpotAuctionDuration`.
	 * @returns The unsigned `updateSpotAuctionDuration` instruction.
	 */
	public async getUpdateSpotAuctionDurationIx(
		defaultAuctionDuration: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotAuctionDuration(
			defaultAuctionDuration,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets the fraction of a perp market's AMM base reserve a single fill may consume
	 * (`amm.maxFillReserveFraction`; a single fill is capped at
	 * `baseAssetReserve / maxFillReserveFraction`, further bounded by half the AMM's
	 * per-side available liquidity). Requires warm admin (`check_warm`). Throws `DefaultError`
	 * on-chain if `maxBaseAssetAmountRatio` is 0. Smaller values allow larger single fills.
	 * @param perpMarketIndex - Perp market to update.
	 * @param maxBaseAssetAmountRatio - Divisor applied to `baseAssetReserve` to cap a single fill's size; must be > 0.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketMaxFillReserveFraction(
		perpMarketIndex: number,
		maxBaseAssetAmountRatio: number
	): Promise<TransactionSignature> {
		const updatePerpMarketMaxFillReserveFractionIx =
			await this.getUpdatePerpMarketMaxFillReserveFractionIx(
				perpMarketIndex,
				maxBaseAssetAmountRatio
			);

		const tx = await this.buildTransaction(
			updatePerpMarketMaxFillReserveFractionIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketMaxFillReserveFraction` instruction without sending it. See
	 * `updatePerpMarketMaxFillReserveFraction`.
	 * @returns The unsigned `updatePerpMarketMaxFillReserveFraction` instruction.
	 */
	public async getUpdatePerpMarketMaxFillReserveFractionIx(
		perpMarketIndex: number,
		maxBaseAssetAmountRatio: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketMaxFillReserveFraction(
			maxBaseAssetAmountRatio,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * **Currently broken and a dead config knob even if fixed.** Intended to set a perp market's
	 * `amm.maxSlippageRatio` (on-chain default 50, i.e. ~2% per the seed comment in
	 * `initializePerpMarket`'s default config) — but `getUpdateMaxSlippageRatioIx` calls
	 * `this.program.instruction.updateMaxSlippageRatio` (cast to `any` to bypass the missing
	 * type); the actual on-chain/IDL instruction is named `updatePerpMarketMaxSlippageRatio`, so
	 * this throws at runtime (`... is not a function`). Separately, even the correctly-named
	 * instruction's target field, `amm.maxSlippageRatio`, is not read by any fill/slippage-check
	 * path in the program — it is write-only. Requires warm admin (`check_warm`) on the
	 * `update_perp_market_max_slippage_ratio` handler.
	 * @param perpMarketIndex - Perp market that would be updated.
	 * @param maxSlippageRatio - Intended `amm.maxSlippageRatio` value, unitless (would validate `> 0`).
	 * @returns Transaction signature (in practice: throws before a transaction is built).
	 */
	public async updateMaxSlippageRatio(
		perpMarketIndex: number,
		maxSlippageRatio: number
	): Promise<TransactionSignature> {
		const updateMaxSlippageRatioIx = await this.getUpdateMaxSlippageRatioIx(
			perpMarketIndex,
			maxSlippageRatio
		);

		const tx = await this.buildTransaction(updateMaxSlippageRatioIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the (currently broken) `updateMaxSlippageRatio` instruction. See
	 * `updateMaxSlippageRatio` — this throws because the program has no `updateMaxSlippageRatio`
	 * instruction (the real name is `updatePerpMarketMaxSlippageRatio`). Throws if
	 * `perpMarketIndex` isn't tracked by the local account subscriber, before it even reaches
	 * the bad instruction-name call.
	 * @returns Never resolves successfully; throws when the missing instruction is invoked.
	 */
	public async getUpdateMaxSlippageRatioIx(
		perpMarketIndex: number,
		maxSlippageRatio: number
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		return await (this.program.instruction as any).updateMaxSlippageRatio(
			maxSlippageRatio,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketAccount.pubkey,
				},
			}
		);
	}

	/**
	 * Sets the asset weights applied to a user's unrealized (unsettled) perp PnL when it counts
	 * toward free collateral. Requires warm admin (`check_warm`). On-chain, both weights must be
	 * <= SPOT_WEIGHT_PRECISION and `unrealizedInitialAssetWeight <= unrealizedMaintenanceAssetWeight`,
	 * or the handler throws `DefaultError`.
	 * @param perpMarketIndex - Perp market to update.
	 * @param unrealizedInitialAssetWeight - Initial-margin weight on unrealized PnL, SPOT_WEIGHT_PRECISION (1e4).
	 * @param unrealizedMaintenanceAssetWeight - Maintenance-margin weight on unrealized PnL, SPOT_WEIGHT_PRECISION (1e4). Must be >= the initial weight.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketUnrealizedAssetWeight(
		perpMarketIndex: number,
		unrealizedInitialAssetWeight: number,
		unrealizedMaintenanceAssetWeight: number
	): Promise<TransactionSignature> {
		const updatePerpMarketUnrealizedAssetWeightIx =
			await this.getUpdatePerpMarketUnrealizedAssetWeightIx(
				perpMarketIndex,
				unrealizedInitialAssetWeight,
				unrealizedMaintenanceAssetWeight
			);

		const tx = await this.buildTransaction(
			updatePerpMarketUnrealizedAssetWeightIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketUnrealizedAssetWeight` instruction without sending it. See
	 * `updatePerpMarketUnrealizedAssetWeight`.
	 * @returns The unsigned `updatePerpMarketUnrealizedAssetWeight` instruction.
	 */
	public async getUpdatePerpMarketUnrealizedAssetWeightIx(
		perpMarketIndex: number,
		unrealizedInitialAssetWeight: number,
		unrealizedMaintenanceAssetWeight: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketUnrealizedAssetWeight(
			unrealizedInitialAssetWeight,
			unrealizedMaintenanceAssetWeight,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a perp market's insurance/revenue-pool caps. Requires warm admin (`check_warm`).
	 * On-chain, all three are bounded by the tier-specific `INSURANCE_{A,B,C,SPECULATIVE}_MAX`
	 * constant for the market's current `contractTier` (`maxRevenueWithdrawPerPeriod` may
	 * alternatively be as large as `FEE_POOL_TO_REVENUE_POOL_THRESHOLD` if that's bigger than
	 * the tier max), and `quoteMaxInsurance` must be >= the market's already-settled insurance
	 * claim — violating either throws `DefaultError`.
	 * @param perpMarketIndex - Perp market to update.
	 * @param unrealizedMaxImbalance - Cap on unrealized-PnL imbalance eligible for insurance backing, QUOTE_PRECISION (1e6).
	 * @param maxRevenueWithdrawPerPeriod - Cap on revenue-pool withdrawals per settlement period, QUOTE_PRECISION (1e6).
	 * @param quoteMaxInsurance - Lifetime cap on insurance draws for this market, QUOTE_PRECISION (1e6). Must be >= the market's already-settled insurance claim.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketMaxImbalances(
		perpMarketIndex: number,
		unrealizedMaxImbalance: BN,
		maxRevenueWithdrawPerPeriod: BN,
		quoteMaxInsurance: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketMaxImabalancesIx =
			await this.getUpdatePerpMarketMaxImbalancesIx(
				perpMarketIndex,
				unrealizedMaxImbalance,
				maxRevenueWithdrawPerPeriod,
				quoteMaxInsurance
			);

		const tx = await this.buildTransaction(updatePerpMarketMaxImabalancesIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketMaxImbalances` instruction without sending it. See
	 * `updatePerpMarketMaxImbalances`.
	 * @returns The unsigned `updatePerpMarketMaxImbalances` instruction.
	 */
	public async getUpdatePerpMarketMaxImbalancesIx(
		perpMarketIndex: number,
		unrealizedMaxImbalance: BN,
		maxRevenueWithdrawPerPeriod: BN,
		quoteMaxInsurance: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketMaxImbalances(
			unrealizedMaxImbalance,
			maxRevenueWithdrawPerPeriod,
			quoteMaxInsurance,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets a perp market's open-interest cap. Requires warm admin (`check_warm`). Throws
	 * `DefaultError` on-chain unless `maxOpenInterest` is an exact multiple of the market's
	 * `orderStepSize`.
	 * @param perpMarketIndex - Perp market to update.
	 * @param maxOpenInterest - Cap on base-asset open interest, BASE_PRECISION (1e9). Must be a multiple of `orderStepSize`.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketMaxOpenInterest(
		perpMarketIndex: number,
		maxOpenInterest: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketMaxOpenInterestIx =
			await this.getUpdatePerpMarketMaxOpenInterestIx(
				perpMarketIndex,
				maxOpenInterest
			);

		const tx = await this.buildTransaction(updatePerpMarketMaxOpenInterestIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketMaxOpenInterest` instruction without sending it. See
	 * `updatePerpMarketMaxOpenInterest`.
	 * @returns The unsigned `updatePerpMarketMaxOpenInterest` instruction.
	 */
	public async getUpdatePerpMarketMaxOpenInterestIx(
		perpMarketIndex: number,
		maxOpenInterest: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketMaxOpenInterest(
			maxOpenInterest,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Directly overwrites a perp market's user-count counters (`numberOfUsers` /
	 * `numberOfUsersWithBase`), used to correct drift from the incrementally-maintained
	 * counters. Requires warm admin (`check_warm`). Either counter can be omitted to leave it
	 * unchanged. On-chain, throws `DefaultError` if the resulting `numberOfUsers <
	 * numberOfUsersWithBase`.
	 * @param perpMarketIndex - Perp market to update.
	 * @param numberOfUsers - New total open-position-or-order user count. Omit to leave unchanged.
	 * @param numberOfUsersWithBase - New count of users with a nonzero base position. Omit to leave unchanged. Must not exceed `numberOfUsers`.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketNumberOfUser(
		perpMarketIndex: number,
		numberOfUsers?: number,
		numberOfUsersWithBase?: number
	): Promise<TransactionSignature> {
		const updatepPerpMarketFeeAdjustmentIx =
			await this.getUpdatePerpMarketNumberOfUsersIx(
				perpMarketIndex,
				numberOfUsers,
				numberOfUsersWithBase
			);

		const tx = await this.buildTransaction(updatepPerpMarketFeeAdjustmentIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketNumberOfUsers` instruction without sending it. See
	 * `updatePerpMarketNumberOfUser`.
	 * @returns The unsigned `updatePerpMarketNumberOfUsers` instruction.
	 */
	public async getUpdatePerpMarketNumberOfUsersIx(
		perpMarketIndex: number,
		numberOfUsers?: number,
		numberOfUsersWithBase?: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketNumberOfUsers(
			numberOfUsers,
			numberOfUsersWithBase,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Scales a perp market's taker fee and maker rebate up or down by a percentage of the base
	 * fee tier. Requires warm admin (`check_warm`). Throws `DefaultError` on-chain if
	 * `abs(feeAdjustment) > FEE_ADJUSTMENT_MAX` (100).
	 * @param perpMarketIndex - Perp market to update.
	 * @param feeAdjustment - Percent adjustment applied to the base taker fee / maker rebate, -100..100 (negative reduces, positive increases; 0 = no adjustment).
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketFeeAdjustment(
		perpMarketIndex: number,
		feeAdjustment: number
	): Promise<TransactionSignature> {
		const updatepPerpMarketFeeAdjustmentIx =
			await this.getUpdatePerpMarketFeeAdjustmentIx(
				perpMarketIndex,
				feeAdjustment
			);

		const tx = await this.buildTransaction(updatepPerpMarketFeeAdjustmentIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketFeeAdjustment` instruction without sending it. See
	 * `updatePerpMarketFeeAdjustment`.
	 * @returns The unsigned `updatePerpMarketFeeAdjustment` instruction.
	 */
	public async getUpdatePerpMarketFeeAdjustmentIx(
		perpMarketIndex: number,
		feeAdjustment: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketFeeAdjustment(
			feeAdjustment,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets the retention buffer the streaming fee sweep leaves in a perp market's pnl pool on top
	 * of `max(netUserPnl, 0)` before the IF/AMM-provision drains take their cut (the protocol
	 * drain is exempt and always runs). Requires warm admin (`check_warm`). See
	 * `perp_market.fee_pool_buffer_target`'s doc comment for why the buffer exists (a swept pool
	 * is short on the next adverse oracle tick, and sweeps are a one-way valve).
	 * @param perpMarketIndex - Perp market to update.
	 * @param feePoolBufferTarget - Pnl-pool retention buffer, QUOTE_PRECISION (1e6).
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketFeePoolBufferTarget(
		perpMarketIndex: number,
		feePoolBufferTarget: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketFeePoolBufferTargetIx =
			await this.getUpdatePerpMarketFeePoolBufferTargetIx(
				perpMarketIndex,
				feePoolBufferTarget
			);

		const tx = await this.buildTransaction(
			updatePerpMarketFeePoolBufferTargetIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketFeePoolBufferTarget` instruction without sending it. See
	 * `updatePerpMarketFeePoolBufferTarget`.
	 * @returns The unsigned `updatePerpMarketFeePoolBufferTarget` instruction.
	 */
	public async getUpdatePerpMarketFeePoolBufferTargetIx(
		perpMarketIndex: number,
		feePoolBufferTarget: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketFeePoolBufferTarget(
			feePoolBufferTarget,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Scales a spot market's taker fee and maker rebate up or down by a percentage of the base
	 * fee tier. Requires warm admin (`check_warm`). Throws `DefaultError` on-chain if
	 * `abs(feeAdjustment) > FEE_ADJUSTMENT_MAX` (100). Note: the first parameter is a **spot**
	 * market index despite being named `perpMarketIndex` here.
	 * @param perpMarketIndex - Spot market index to update (misnamed; not a perp market index).
	 * @param feeAdjustment - Percent adjustment applied to the base taker fee / maker rebate, -100..100 (negative reduces, positive increases; 0 = no adjustment).
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketFeeAdjustment(
		perpMarketIndex: number,
		feeAdjustment: number
	): Promise<TransactionSignature> {
		const updateSpotMarketFeeAdjustmentIx =
			await this.getUpdateSpotMarketFeeAdjustmentIx(
				perpMarketIndex,
				feeAdjustment
			);

		const tx = await this.buildTransaction(updateSpotMarketFeeAdjustmentIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketFeeAdjustment` instruction without sending it. See
	 * `updateSpotMarketFeeAdjustment`.
	 * @returns The unsigned `updateSpotMarketFeeAdjustment` instruction.
	 */
	public async getUpdateSpotMarketFeeAdjustmentIx(
		spotMarketIndex: number,
		feeAdjustment: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketFeeAdjustment(
			feeAdjustment,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets the three-way split of a perp market's liquidation fee: the cut paid to the
	 * liquidator, the cut routed to the insurance fund, and the cut kept by the protocol.
	 * Requires warm admin (`check_warm`). On-chain, throws `DefaultError` unless
	 * `liquidatorFee + ifLiquidationFee + protocolLiquidationFee < LIQUIDATION_FEE_PRECISION`,
	 * `ifLiquidationFee < LIQUIDATION_FEE_PRECISION`, and `protocolLiquidationFee <=
	 * LIQUIDATION_FEE_PRECISION / 10` (10%); also re-validates `liquidatorFee` against the
	 * market's current margin ratios (`amm.validate_compatible_with_liquidation_fee`).
	 * @param perpMarketIndex - Perp market to update.
	 * @param liquidatorFee - Fee paid to the liquidator, LIQUIDATION_FEE_PRECISION (1e6).
	 * @param ifLiquidationFee - Portion routed to the insurance fund, LIQUIDATION_FEE_PRECISION (1e6).
	 * @param protocolLiquidationFee - Portion kept by the protocol, LIQUIDATION_FEE_PRECISION (1e6). Max 10% of precision. Default 0.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketLiquidationFee(
		perpMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number,
		protocolLiquidationFee = 0
	): Promise<TransactionSignature> {
		const updatePerpMarketLiquidationFeeIx =
			await this.getUpdatePerpMarketLiquidationFeeIx(
				perpMarketIndex,
				liquidatorFee,
				ifLiquidationFee,
				protocolLiquidationFee
			);

		const tx = await this.buildTransaction(updatePerpMarketLiquidationFeeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketLiquidationFee` instruction without sending it. See
	 * `updatePerpMarketLiquidationFee`.
	 * @returns The unsigned `updatePerpMarketLiquidationFee` instruction.
	 */
	public async getUpdatePerpMarketLiquidationFeeIx(
		perpMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number,
		protocolLiquidationFee = 0
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketLiquidationFee(
			liquidatorFee,
			ifLiquidationFee,
			protocolLiquidationFee,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Sets the three-way split of a spot market's liquidation fee: the cut paid to the
	 * liquidator, the cut routed to the insurance fund, and the cut kept by the protocol.
	 * Requires warm admin (`check_warm`). On-chain, throws `DefaultError` unless
	 * `liquidatorFee + ifLiquidationFee + protocolLiquidationFee < LIQUIDATION_FEE_PRECISION`,
	 * and both `ifLiquidationFee` and `protocolLiquidationFee` are each
	 * <= `LIQUIDATION_FEE_PRECISION / 10` (10%).
	 * @param spotMarketIndex - Spot market to update.
	 * @param liquidatorFee - Fee paid to the liquidator, LIQUIDATION_FEE_PRECISION (1e6).
	 * @param ifLiquidationFee - Portion routed to the insurance fund, LIQUIDATION_FEE_PRECISION (1e6). Max 10% of precision.
	 * @param protocolLiquidationFee - Portion kept by the protocol, LIQUIDATION_FEE_PRECISION (1e6). Max 10% of precision. Default 0.
	 * @returns Transaction signature.
	 */
	public async updateSpotMarketLiquidationFee(
		spotMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number,
		protocolLiquidationFee = 0
	): Promise<TransactionSignature> {
		const updateSpotMarketLiquidationFeeIx =
			await this.getUpdateSpotMarketLiquidationFeeIx(
				spotMarketIndex,
				liquidatorFee,
				ifLiquidationFee,
				protocolLiquidationFee
			);

		const tx = await this.buildTransaction(updateSpotMarketLiquidationFeeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateSpotMarketLiquidationFee` instruction without sending it. See
	 * `updateSpotMarketLiquidationFee`.
	 * @returns The unsigned `updateSpotMarketLiquidationFee` instruction.
	 */
	public async getUpdateSpotMarketLiquidationFeeIx(
		spotMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number,
		protocolLiquidationFee = 0
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketLiquidationFee(
			liquidatorFee,
			ifLiquidationFee,
			protocolLiquidationFee,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			}
		);
	}

	/**
	 * Cold-only. Sets the treasury pubkey that `withdrawProtocolFeesPerp` /
	 * `withdrawProtocolFeesSpot` pay out to. Perp (quote-denominated) and spot
	 * (per-market-token) recipients are independent — `marketType` selects which one
	 * this call updates. Withdrawals for a market type are inert (the fee-withdraw ix
	 * always fails) until its recipient is set to a non-default pubkey.
	 * @param protocolFeeRecipient - New recipient wallet; its ATA (per mint) receives future withdrawals.
	 * @param marketType - Which recipient slot to update, `MarketType.PERP` or `MarketType.SPOT`.
	 * @returns Transaction signature.
	 */
	public async updateProtocolFeeRecipient(
		protocolFeeRecipient: PublicKey,
		marketType: MarketType
	): Promise<TransactionSignature> {
		const ix = await this.getUpdateProtocolFeeRecipientIx(
			protocolFeeRecipient,
			marketType
		);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `updateProtocolFeeRecipient` instruction without sending it. See
	 * `updateProtocolFeeRecipient`.
	 * @returns The unsigned `updateProtocolFeeRecipient` instruction.
	 */
	public async getUpdateProtocolFeeRecipientIx(
		protocolFeeRecipient: PublicKey,
		marketType: MarketType
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateProtocolFeeRecipient(
			protocolFeeRecipient,
			marketType,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Withdraws a spot market's accrued protocol fees (lending-interest + spot-liquidation
	 * carveouts, tracked in `spotMarket.protocolFeePool`) from its vault to
	 * `state.protocolFeeRecipientSpot`'s ATA. Requires `HotRole.FeeWithdraw` (cold, warm,
	 * or the configured fee-withdraw hot key) — `this.wallet` must hold that role, since
	 * `getWithdrawProtocolFeesSpotIx` signs as `this.wallet.publicKey` for both `payer`
	 * and `authority`. The recipient ATA is created (`init_if_needed`) if missing. The
	 * withdrawn amount is capped at whatever is actually available, and the vault must
	 * still fully cover depositor backing afterward or the instruction fails.
	 * @param marketIndex - Spot market to withdraw protocol fees from.
	 * @param amount - Requested amount, the market's native token decimals (clamped down to the available balance on-chain).
	 * @param txParams - Optional transaction-building overrides.
	 * @returns Transaction signature.
	 */
	public async withdrawProtocolFeesSpot(
		marketIndex: number,
		amount: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getWithdrawProtocolFeesSpotIx(marketIndex, amount);
		const tx = await this.buildTransaction(ix, txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `withdrawProtocolFeesSpot` instruction without sending it. Also wires
	 * up transfer-hook remaining accounts if the market's mint requires them. See
	 * `withdrawProtocolFeesSpot`.
	 * @returns The unsigned `withdrawProtocolFeesSpot` instruction.
	 */
	public async getWithdrawProtocolFeesSpotIx(
		marketIndex: number,
		amount: BN
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		const tokenProgramId = this.getTokenProgramForSpotMarket(spotMarket);
		const recipient = this.getStateAccount().protocolFeeRecipientSpot;
		const recipientTokenAccount = getAssociatedTokenAddressSync(
			spotMarket.mint,
			recipient,
			true,
			tokenProgramId
		);

		const remainingAccounts: {
			pubkey: PublicKey;
			isSigner: boolean;
			isWritable: boolean;
		}[] = [];
		if (this.isTransferHook(spotMarket)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarket.mint,
				remainingAccounts
			);
		}

		return await this.program.instruction.withdrawProtocolFeesSpot(
			marketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					payer: this.wallet.publicKey,
					authority: this.wallet.publicKey,
					spotMarket: spotMarket.pubkey,
					spotMarketVault: spotMarket.vault,
					mint: spotMarket.mint,
					recipient,
					recipientTokenAccount,
					tokenProgram: tokenProgramId,
					velocitySigner: this.getSignerPublicKey(),
					systemProgram: SystemProgram.programId,
					associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);
	}

	/**
	 * Withdraws a perp market's accrued protocol fees (quote-denominated, tracked in
	 * `perpMarket.protocolFeePool`) from the quote spot market's vault to
	 * `state.protocolFeeRecipientPerp`'s ATA. Requires `HotRole.FeeWithdraw` — see
	 * `withdrawProtocolFeesSpot` for the same signer/ATA/clamping/vault-invariant
	 * behavior (this mirrors it against the perp market's quote-denominated pool
	 * instead of a spot market's own token).
	 * @param marketIndex - Perp market to withdraw protocol fees from.
	 * @param amount - Requested amount, QUOTE_PRECISION (1e6) (clamped down to the available balance on-chain).
	 * @param txParams - Optional transaction-building overrides.
	 * @returns Transaction signature.
	 */
	public async withdrawProtocolFeesPerp(
		marketIndex: number,
		amount: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getWithdrawProtocolFeesPerpIx(marketIndex, amount);
		const tx = await this.buildTransaction(ix, txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `withdrawProtocolFeesPerp` instruction without sending it. Also wires
	 * up transfer-hook remaining accounts if the quote market's mint requires them. See
	 * `withdrawProtocolFeesPerp`.
	 * @returns The unsigned `withdrawProtocolFeesPerp` instruction.
	 */
	public async getWithdrawProtocolFeesPerpIx(
		marketIndex: number,
		amount: BN
	): Promise<TransactionInstruction> {
		const perpMarket = this.getPerpMarketAccountOrThrow(marketIndex);
		const quoteSpotMarket = this.getSpotMarketAccountOrThrow(
			perpMarket.quoteSpotMarketIndex
		);
		const tokenProgramId = this.getTokenProgramForSpotMarket(quoteSpotMarket);
		const recipient = this.getStateAccount().protocolFeeRecipientPerp;
		const recipientTokenAccount = getAssociatedTokenAddressSync(
			quoteSpotMarket.mint,
			recipient,
			true,
			tokenProgramId
		);

		const remainingAccounts: {
			pubkey: PublicKey;
			isSigner: boolean;
			isWritable: boolean;
		}[] = [];
		if (this.isTransferHook(quoteSpotMarket)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				quoteSpotMarket.mint,
				remainingAccounts
			);
		}

		return await this.program.instruction.withdrawProtocolFeesPerp(
			marketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					payer: this.wallet.publicKey,
					authority: this.wallet.publicKey,
					perpMarket: perpMarket.pubkey,
					quoteSpotMarket: quoteSpotMarket.pubkey,
					spotMarketVault: quoteSpotMarket.vault,
					mint: quoteSpotMarket.mint,
					recipient,
					recipientTokenAccount,
					tokenProgram: tokenProgramId,
					velocitySigner: this.getSignerPublicKey(),
					systemProgram: SystemProgram.programId,
					associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);
	}

	/**
	 * Creates a market-local synthetic "oracle" account (`PrelaunchOracle`) for a perp market
	 * that has no real price feed yet (e.g. a pre-launch/pre-listing market), seeded with an
	 * admin-supplied price. Requires warm admin (`check_warm`). Set the market's `oracle` to
	 * this account's address (via `updatePerpMarketOracle`, with a matching `OracleSource`) to
	 * use it. `PrelaunchOracle::validate` runs at the end of the handler and throws
	 * `InvalidOracle` if `price` or `maxPrice` end up `0` (both are zero-initialized and only
	 * set when the corresponding argument is provided) or if `price > maxPrice` — in practice
	 * both must be supplied and satisfy `price <= maxPrice`.
	 * @param perpMarketIndex - Perp market this oracle backs; fixes the PDA seed.
	 * @param price - Initial synthetic price, PRICE_PRECISION (1e6). Must be nonzero and <= `maxPrice`.
	 * @param maxPrice - Ceiling the price is allowed to move to, PRICE_PRECISION (1e6). Must be nonzero and >= `price`.
	 * @returns Transaction signature.
	 */
	public async initializePrelaunchOracle(
		perpMarketIndex: number,
		price?: BN,
		maxPrice?: BN
	): Promise<TransactionSignature> {
		const initializePrelaunchOracleIx =
			await this.getInitializePrelaunchOracleIx(
				perpMarketIndex,
				price,
				maxPrice
			);

		const tx = await this.buildTransaction(initializePrelaunchOracleIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `initializePrelaunchOracle` instruction without sending it. See
	 * `initializePrelaunchOracle`.
	 * @returns The unsigned `initializePrelaunchOracle` instruction.
	 */
	public async getInitializePrelaunchOracleIx(
		perpMarketIndex: number,
		price?: BN,
		maxPrice?: BN
	): Promise<TransactionInstruction> {
		const params = {
			perpMarketIndex,
			price: price || null,
			maxPrice: maxPrice || null,
		};

		return await this.program.instruction.initializePrelaunchOracle(params, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				prelaunchOracle: await getPrelaunchOraclePublicKey(
					this.program.programId,
					perpMarketIndex
				),
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
			},
		});
	}

	/**
	 * Updates a perp market's `PrelaunchOracle` price and/or ceiling. Requires warm admin
	 * (`check_warm`). If `price` is provided, this **also directly overwrites the perp market's
	 * mark-price TWAPs** (`lastMarkPriceTwap`, `lastMarkPriceTwap5min`, and clamps
	 * `lastBidPriceTwap`/`lastAskPriceTwap` toward the new price) and their timestamp — a much
	 * broader side effect than the field name suggests. `PrelaunchOracle::validate` re-runs at
	 * the end and throws `InvalidOracle` if the resulting `price`/`maxPrice` are `0` or
	 * `price > maxPrice`. Either argument omitted leaves that field (and, for `price`, the TWAPs)
	 * unchanged.
	 * @param perpMarketIndex - Perp market whose prelaunch oracle to update.
	 * @param price - New synthetic price, PRICE_PRECISION (1e6). Also overwrites the market's mark-price TWAPs when provided. Omit to leave unchanged.
	 * @param maxPrice - New price ceiling, PRICE_PRECISION (1e6). Omit to leave unchanged.
	 * @returns Transaction signature.
	 */
	public async updatePrelaunchOracleParams(
		perpMarketIndex: number,
		price?: BN,
		maxPrice?: BN
	): Promise<TransactionSignature> {
		const updatePrelaunchOracleParamsIx =
			await this.getUpdatePrelaunchOracleParamsIx(
				perpMarketIndex,
				price,
				maxPrice
			);

		const tx = await this.buildTransaction(updatePrelaunchOracleParamsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePrelaunchOracleParams` instruction without sending it. See
	 * `updatePrelaunchOracleParams`.
	 * @returns The unsigned `updatePrelaunchOracleParams` instruction.
	 */
	public async getUpdatePrelaunchOracleParamsIx(
		perpMarketIndex: number,
		price?: BN,
		maxPrice?: BN
	): Promise<TransactionInstruction> {
		const params = {
			perpMarketIndex,
			price: price || null,
			maxPrice: maxPrice || null,
		};

		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePrelaunchOracleParams(params, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
				prelaunchOracle: await getPrelaunchOraclePublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	/**
	 * Closes a perp market's `PrelaunchOracle` account and refunds rent to the admin. Requires
	 * warm admin (`check_warm`). On-chain, throws `DefaultError` if the oracle is still the
	 * market's active `oracle` — repoint the market to a different oracle first (via
	 * `updatePerpMarketOracle`).
	 *
	 * **Currently broken**: `getDeletePrelaunchOracleIx` builds a `PrelaunchOracleParams`-shaped
	 * object (`{ perpMarketIndex, price, maxPrice }`) as the instruction argument, but the
	 * on-chain `deletePrelaunchOracle` instruction (and its IDL) takes a single `u16`
	 * `perpMarketIndex` scalar, not that object — this throws when the Borsh encoder tries to
	 * serialize an object where a `u16` is expected.
	 * @param perpMarketIndex - Perp market whose prelaunch oracle to delete; must not be the market's current oracle.
	 * @returns Transaction signature (in practice: throws before a transaction is built).
	 */
	public async deletePrelaunchOracle(
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const deletePrelaunchOracleIx = await this.getDeletePrelaunchOracleIx(
			perpMarketIndex
		);

		const tx = await this.buildTransaction(deletePrelaunchOracleIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the (currently broken) `deletePrelaunchOracle` instruction. See
	 * `deletePrelaunchOracle` — throws because the argument shape doesn't match the IDL's `u16`.
	 * `price`/`maxPrice` are accepted but unused; the underlying call never reads them.
	 * @returns Never resolves successfully; throws when the malformed instruction args are encoded.
	 */
	public async getDeletePrelaunchOracleIx(
		perpMarketIndex: number,
		price?: BN,
		maxPrice?: BN
	): Promise<TransactionInstruction> {
		const params = {
			perpMarketIndex,
			price: price || null,
			maxPrice: maxPrice || null,
		};

		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.deletePrelaunchOracle(params, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
				prelaunchOracle: await getPrelaunchOraclePublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	/**
	 * Overrides how many slots of oracle delay a perp market tolerates before its "low-risk"
	 * oracle-staleness check (`OracleValidity`'s `is_stale_for_amm_low_risk`, consumed by margin
	 * calculations, order fills, AMM repeg/refresh, and the AMM cache) trips. Gated on
	 * `HotAdminUpdatePerpMarket`, whose account constraint is actually `check_warm` — this
	 * requires **warm** admin (or cold), not a dedicated hot key, despite the struct's name.
	 * `0` (the default) means no override — the market falls back to the global
	 * `state.oracleGuardRails.validity.slotsBeforeStaleForAmm`; a nonzero value is clamped to
	 * `>= 0` and used as the slot threshold directly.
	 * @param perpMarketIndex - Perp market to update.
	 * @param oracleLowRiskSlotDelayOverride - Slots of oracle delay tolerated for low-risk AMM actions before staleness trips. `0` = use the global default; negative values are treated as `0`.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketOracleLowRiskSlotDelayOverride(
		perpMarketIndex: number,
		oracleLowRiskSlotDelayOverride: number
	): Promise<TransactionSignature> {
		const updatePerpMarketOracleLowRiskSlotDelayOverrideIx =
			await this.getUpdatePerpMarketOracleLowRiskSlotDelayOverrideIx(
				perpMarketIndex,
				oracleLowRiskSlotDelayOverride
			);
		const tx = await this.buildTransaction(
			updatePerpMarketOracleLowRiskSlotDelayOverrideIx
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketOracleLowRiskSlotDelayOverride` instruction without sending it.
	 * See `updatePerpMarketOracleLowRiskSlotDelayOverride`.
	 * @returns The unsigned `updatePerpMarketOracleLowRiskSlotDelayOverride` instruction.
	 */
	public async getUpdatePerpMarketOracleLowRiskSlotDelayOverrideIx(
		perpMarketIndex: number,
		oracleLowRiskSlotDelayOverride: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketOracleLowRiskSlotDelayOverride(
			oracleLowRiskSlotDelayOverride,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	/**
	 * Overrides how many slots of oracle delay a perp market tolerates before its "immediate"
	 * per-fill staleness check trips (used for AMM-immediate fills; the on-chain field is
	 * `perpMarket.oracleSlotDelayOverride`, default `-1`). Gated on `HotAdminUpdatePerpMarket`,
	 * whose account constraint is actually `check_warm` — this requires **warm** admin (or
	 * cold), not a dedicated hot key. `0` means the market is always treated as stale for
	 * immediate AMM actions; any other value is clamped to `>= 0` and used as the slot threshold
	 * (delay > threshold is stale).
	 * @param perpMarketIndex - Perp market to update.
	 * @param oracleSlotDelay - Slots of oracle delay tolerated before the immediate-fill staleness check trips. `0` = always stale; negative input is clamped to `0` on-chain.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketOracleSlotDelayOverride(
		perpMarketIndex: number,
		oracleSlotDelay: number
	): Promise<TransactionSignature> {
		const updatePerpMarketOracleSlotDelayOverrideIx =
			await this.getUpdatePerpMarketOracleSlotDelayOverrideIx(
				perpMarketIndex,
				oracleSlotDelay
			);
		const tx = await this.buildTransaction(
			updatePerpMarketOracleSlotDelayOverrideIx
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketOracleSlotDelayOverride` instruction without sending it. See
	 * `updatePerpMarketOracleSlotDelayOverride`.
	 * @returns The unsigned `updatePerpMarketOracleSlotDelayOverride` instruction.
	 */
	public async getUpdatePerpMarketOracleSlotDelayOverrideIx(
		perpMarketIndex: number,
		oracleSlotDelay: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketOracleSlotDelayOverride(
			oracleSlotDelay,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	/**
	 * Sets a perp market's manual spread-widening scalars. Gated on `HotAdminUpdatePerpMarket`,
	 * whose account constraint is actually `check_warm` — this requires **warm** admin (or
	 * cold), not a dedicated hot key. **`referencePriceOffset` is accepted for wire/IDL
	 * compatibility but ignored on-chain** — `amm.referencePriceOffset` is a per-crank output
	 * recomputed from inventory and market stats by
	 * `crate::vlp::amm::math::spread::update_amm_quote_state`, not an admin-settable value; pass
	 * any value.
	 * @param perpMarketIndex - Perp market to update.
	 * @param ammSpreadAdjustment - Signed scalar on the AMM's base spread, same convention as `fee_adjustment` (-100 = spread scaled to 0, 100 = spread doubled, 0 = no adjustment).
	 * @param ammInventorySpreadAdjustment - Signed scalar on the inventory-skew component of the spread, same -100..100 convention.
	 * @param referencePriceOffset - Ignored on-chain; retained only for instruction-argument compatibility.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketAmmSpreadAdjustment(
		perpMarketIndex: number,
		ammSpreadAdjustment: number,
		ammInventorySpreadAdjustment: number,
		referencePriceOffset: number
	): Promise<TransactionSignature> {
		const updatePerpMarketAmmSpreadAdjustmentIx =
			await this.getUpdatePerpMarketAmmSpreadAdjustmentIx(
				perpMarketIndex,
				ammSpreadAdjustment,
				ammInventorySpreadAdjustment,
				referencePriceOffset
			);
		const tx = await this.buildTransaction(
			updatePerpMarketAmmSpreadAdjustmentIx
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketAmmSpreadAdjustment` instruction without sending it. See
	 * `updatePerpMarketAmmSpreadAdjustment`.
	 * @returns The unsigned `updatePerpMarketAmmSpreadAdjustment` instruction.
	 */
	public async getUpdatePerpMarketAmmSpreadAdjustmentIx(
		perpMarketIndex: number,
		ammSpreadAdjustment: number,
		ammInventorySpreadAdjustment: number,
		referencePriceOffset: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketAmmSpreadAdjustment(
			ammSpreadAdjustment,
			ammInventorySpreadAdjustment,
			referencePriceOffset,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	/**
	 * Sets how much a perp market's paying-side spread widens while the vAMM's inventory is
	 * paying funding: `amm.fundingBiasSensitivity = s` gives multiplier `β(f) = 1 + s/100 * ρ(f)`
	 * (at full ramp, `ρ = 1`: 50 -> 1.5x, 100 -> 2x). Gated on `HotAdminUpdatePerpMarket`, whose
	 * account constraint is actually `check_warm` — this requires **warm** admin (or cold), not
	 * a dedicated hot key.
	 * @param perpMarketIndex - Perp market to update.
	 * @param fundingBiasSensitivity - Sensitivity `s`, in hundredths (value/100 is the multiplier slope); `0` disables the bias. `u8` range caps `s` at 2.55.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketFundingBiasSensitivity(
		perpMarketIndex: number,
		fundingBiasSensitivity: number
	): Promise<TransactionSignature> {
		const updatePerpMarketFundingBiasSensitivityIx =
			await this.getUpdatePerpMarketFundingBiasSensitivityIx(
				perpMarketIndex,
				fundingBiasSensitivity
			);
		const tx = await this.buildTransaction(
			updatePerpMarketFundingBiasSensitivityIx
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketFundingBiasSensitivity` instruction without sending it. See
	 * `updatePerpMarketFundingBiasSensitivity`.
	 * @returns The unsigned `updatePerpMarketFundingBiasSensitivity` instruction.
	 */
	public async getUpdatePerpMarketFundingBiasSensitivityIx(
		perpMarketIndex: number,
		fundingBiasSensitivity: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketFundingBiasSensitivity(
			fundingBiasSensitivity,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	/**
	 * Creates the zero'd `PythLazerOracle` PDA for a Pyth Lazer feed id (one-time setup
	 * before that feed can be pushed to via `updatePythLazerOracle`/keeper cranks).
	 * Requires warm admin (`check_warm`, `InitPythLazerOracle` context). Idempotent per
	 * `feedId` — a second call for the same id fails (`init` on an existing PDA).
	 * @param feedId - Pyth Lazer feed id; seeds the `PythLazerOracle` PDA (`getPythLazerOraclePublicKey`).
	 * @returns Transaction signature.
	 */
	public async initializePythLazerOracle(
		feedId: number
	): Promise<TransactionSignature> {
		const initializePythLazerOracleIx =
			await this.getInitializePythLazerOracleIx(feedId);
		const tx = await this.buildTransaction(initializePythLazerOracleIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `initializePythLazerOracle` instruction without sending it. See
	 * `initializePythLazerOracle`.
	 * @returns The unsigned `initializePythLazerOracle` instruction.
	 */
	public async getInitializePythLazerOracleIx(
		feedId: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.initializePythLazerOracle(feedId, {
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				state: await this.getStatePublicKey(),
				systemProgram: SystemProgram.programId,
				lazerOracle: getPythLazerOraclePublicKey(
					this.program.programId,
					feedId
				),
				rent: SYSVAR_RENT_PUBKEY,
			},
		});
	}

	/**
	 * Deposits tokens from an admin-controlled token account directly into a user's
	 * spot balance, recorded as a `DepositExplanation.Reward` deposit (e.g. crediting a
	 * promotional/reward balance without the user signing). Requires
	 * `HotRole.VaultDeposit` (cold, warm, or the configured vault-deposit hot key) —
	 * `this.wallet` signs as `admin` and must hold that role.
	 * @param marketIndex - Spot market to deposit into.
	 * @param amount - Deposit amount, the market's native token decimals.
	 * @param depositUserAccount - User account (`User` PDA pubkey) to credit.
	 * @param adminTokenAccount - Source token account (must belong to `this.wallet`). Defaults to `this.wallet`'s associated token account for the market's mint.
	 * @returns Transaction signature.
	 */
	public async adminDeposit(
		marketIndex: number,
		amount: BN,
		depositUserAccount: PublicKey,
		adminTokenAccount?: PublicKey
	): Promise<TransactionSignature> {
		const ix = await this.getAdminDepositIx(
			marketIndex,
			amount,
			depositUserAccount,
			adminTokenAccount
		);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `adminDeposit` instruction without sending it. Also wires up the
	 * mint and transfer-hook remaining accounts the deposit needs. See `adminDeposit`.
	 * @returns The unsigned `adminDeposit` instruction.
	 */
	public async getAdminDepositIx(
		marketIndex: number,
		amount: BN,
		depositUserAccount: PublicKey,
		adminTokenAccount?: PublicKey
	): Promise<TransactionInstruction> {
		const state = await this.getStatePublicKey();
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [marketIndex],
		});
		this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);
		if (this.isTransferHook(spotMarket)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarket.mint,
				remainingAccounts
			);
		}

		return this.program.instruction.adminDeposit(marketIndex, amount, {
			remainingAccounts,
			accounts: {
				state,
				user: depositUserAccount,
				admin: this.wallet.publicKey,
				spotMarketVault: spotMarket.vault,
				adminTokenAccount:
					adminTokenAccount ??
					(await this.getAssociatedTokenAccount(marketIndex)),
				tokenProgram: getTokenProgramForSpotMarket(spotMarket),
			},
		});
	}

	/**
	 * Resets a perp market's push-oracle ("MM oracle") state — `marketStats.mmOraclePrice`,
	 * `mmOracleSequenceId`, and `mmOracleSlot` — all to `0`. Requires warm admin (the
	 * `HotAdminUpdatePerpMarket` context's `check_warm` constraint — despite the name,
	 * no dedicated hot role is wired to it; see `updatePerpMarketCurveUpdateIntensity`
	 * for the same gate). Use to force the next `updateMmOracleNative` push to be
	 * treated as a fresh bootstrap (its step-size cap is skipped when the previous
	 * price is `0`).
	 * @param marketIndex - Perp market whose MM oracle fields to zero.
	 * @returns Transaction signature.
	 */
	public async zeroMMOracleFields(
		marketIndex: number
	): Promise<TransactionSignature> {
		const zeroMMOracleFieldsIx = await this.getZeroMMOracleFieldsIx(
			marketIndex
		);

		const tx = await this.buildTransaction(zeroMMOracleFieldsIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `zeroMMOracleFields` instruction without sending it. See
	 * `zeroMMOracleFields`.
	 * @returns The unsigned `zeroMmOracleFields` instruction.
	 */
	public async getZeroMMOracleFieldsIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.zeroMmOracleFields({
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					marketIndex
				),
			},
		});
	}

	/**
	 * Toggles the `FeatureBitFlags.MM_ORACLE_UPDATE` bit on `state.featureBitFlags`,
	 * which gates the native (non-Anchor) `updateMmOracleNative` push-oracle
	 * dispatch — the on-chain handler asserts this bit before accepting a push.
	 * Requires `HotRole.FeatureFlag` (`HotAdminUpdateState`'s `check_hot`) to disable,
	 * but **enabling requires `state.coldAdmin` specifically** — the handler rejects
	 * `enable: true` from any other signer, even one otherwise authorised for the
	 * `FeatureFlag` role, so a compromised feature-flag hot key can only trip this
	 * kill switch, never clear it.
	 * @param enable - `true` to enable (cold-admin-only), `false` to disable (any `FeatureFlag`-authorised signer).
	 * @returns Transaction signature.
	 */
	public async updateFeatureBitFlagsMMOracle(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsMMOracleIx =
			await this.getUpdateFeatureBitFlagsMMOracleIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsMMOracleIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateFeatureBitFlagsMMOracle` instruction without sending it. See
	 * `updateFeatureBitFlagsMMOracle`.
	 * @returns The unsigned `updateFeatureBitFlagsMmOracle` instruction.
	 */
	public async getUpdateFeatureBitFlagsMMOracleIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsMmOracle(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Toggles the `FeatureBitFlags.BUILDER_CODES` bit on `state.featureBitFlags`
	 * (gates builder-code fee-attribution instructions protocol-wide). Same
	 * kill-switch gating as `updateFeatureBitFlagsMMOracle`: `HotRole.FeatureFlag` may
	 * disable, only `coldAdmin` may enable.
	 * @param enable - `true` to enable (cold-admin-only), `false` to disable (any `FeatureFlag`-authorised signer).
	 * @returns Transaction signature.
	 */
	public async updateFeatureBitFlagsBuilderCodes(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsBuilderCodesIx =
			await this.getUpdateFeatureBitFlagsBuilderCodesIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsBuilderCodesIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateFeatureBitFlagsBuilderCodes` instruction without sending it.
	 * See `updateFeatureBitFlagsBuilderCodes`.
	 * @returns The unsigned `updateFeatureBitFlagsBuilderCodes` instruction.
	 */
	public async getUpdateFeatureBitFlagsBuilderCodesIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateFeatureBitFlagsBuilderCodes(enable, {
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				state: await this.getStatePublicKey(),
			},
		});
	}

	/**
	 * @deprecated There is no `BuilderReferral` bit in the on-chain `FeatureBitFlags`
	 * enum (only `MmOracleUpdate`, `MedianTriggerPrice`, `BuilderCodes` exist) and no
	 * `update_feature_bit_flags_builder_referral` instruction is defined in the
	 * program or present in the IDL. Calling this (or
	 * `getUpdateFeatureBitFlagsBuilderReferralIx`) throws at runtime — hence the
	 * `as any` cast on `this.program.instruction` used to bypass the TS type check.
	 * Do not call until (and unless) a matching on-chain instruction ships.
	 * @param enable - Intended flag state (unused while dead).
	 * @returns Transaction signature (never reached).
	 */
	public async updateFeatureBitFlagsBuilderReferral(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsBuilderReferralIx =
			await this.getUpdateFeatureBitFlagsBuilderReferralIx(enable);

		const tx = await this.buildTransaction(
			updateFeatureBitFlagsBuilderReferralIx
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * @deprecated See `updateFeatureBitFlagsBuilderReferral` — no matching instruction
	 * exists on-chain or in the IDL; this throws at runtime.
	 * @returns Never resolves successfully.
	 */
	public async getUpdateFeatureBitFlagsBuilderReferralIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return (
			this.program.instruction as any
		).updateFeatureBitFlagsBuilderReferral(enable, {
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				state: await this.getStatePublicKey(),
			},
		});
	}

	/**
	 * Toggles the `FeatureBitFlags.MEDIAN_TRIGGER_PRICE` bit on
	 * `state.featureBitFlags` (gates using a median of price sources for trigger-order
	 * evaluation). Same kill-switch gating as `updateFeatureBitFlagsMMOracle`:
	 * `HotRole.FeatureFlag` may disable, only `coldAdmin` may enable.
	 * @param enable - `true` to enable (cold-admin-only), `false` to disable (any `FeatureFlag`-authorised signer).
	 * @returns Transaction signature.
	 */
	public async updateFeatureBitFlagsMedianTriggerPrice(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsMedianTriggerPriceIx =
			await this.getUpdateFeatureBitFlagsMedianTriggerPriceIx(enable);
		const tx = await this.buildTransaction(
			updateFeatureBitFlagsMedianTriggerPriceIx
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateFeatureBitFlagsMedianTriggerPrice` instruction without sending
	 * it. See `updateFeatureBitFlagsMedianTriggerPrice`.
	 * @returns The unsigned `updateFeatureBitFlagsMedianTriggerPrice` instruction.
	 */
	public async getUpdateFeatureBitFlagsMedianTriggerPriceIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsMedianTriggerPrice(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Toggles the `LpPoolFeatureBitFlags.SettleLpPool`-equivalent bit on
	 * `state.lpPoolFeatureBitFlags` (gates `settlePerpToLpPool`/LP-pool settlement
	 * protocol-wide). Same kill-switch gating as `updateFeatureBitFlagsMMOracle`:
	 * `HotRole.FeatureFlag` may disable, only `coldAdmin` may enable.
	 * @param enable - `true` to enable (cold-admin-only), `false` to disable (any `FeatureFlag`-authorised signer).
	 * @returns Transaction signature.
	 */
	public async updateFeatureBitFlagsSettleLpPool(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsSettleLpPoolIx =
			await this.getUpdateFeatureBitFlagsSettleLpPoolIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsSettleLpPoolIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateFeatureBitFlagsSettleLpPool` instruction without sending it.
	 * See `updateFeatureBitFlagsSettleLpPool`.
	 * @returns The unsigned `updateFeatureBitFlagsSettleLpPool` instruction.
	 */
	public async getUpdateFeatureBitFlagsSettleLpPoolIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsSettleLpPool(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Toggles the LP-pool swap-enabled bit on `state.lpPoolFeatureBitFlags` (gates
	 * `lpPoolSwap`/begin-end swap flows protocol-wide). Same kill-switch gating as
	 * `updateFeatureBitFlagsMMOracle`: `HotRole.FeatureFlag` may disable, only
	 * `coldAdmin` may enable.
	 * @param enable - `true` to enable (cold-admin-only), `false` to disable (any `FeatureFlag`-authorised signer).
	 * @returns Transaction signature.
	 */
	public async updateFeatureBitFlagsSwapLpPool(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsSettleLpPoolIx =
			await this.getUpdateFeatureBitFlagsSwapLpPoolIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsSettleLpPoolIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateFeatureBitFlagsSwapLpPool` instruction without sending it. See
	 * `updateFeatureBitFlagsSwapLpPool`.
	 * @returns The unsigned `updateFeatureBitFlagsSwapLpPool` instruction.
	 */
	public async getUpdateFeatureBitFlagsSwapLpPoolIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsSwapLpPool(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Toggles the LP-pool mint/redeem-enabled bit on `state.lpPoolFeatureBitFlags`
	 * (gates `lpPoolAddLiquidity`/`lpPoolRemoveLiquidity` protocol-wide). Same
	 * kill-switch gating as `updateFeatureBitFlagsMMOracle`: `HotRole.FeatureFlag` may
	 * disable, only `coldAdmin` may enable.
	 * @param enable - `true` to enable (cold-admin-only), `false` to disable (any `FeatureFlag`-authorised signer).
	 * @returns Transaction signature.
	 */
	public async updateFeatureBitFlagsMintRedeemLpPool(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsSettleLpPoolIx =
			await this.getUpdateFeatureBitFlagsMintRedeemLpPoolIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsSettleLpPoolIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateFeatureBitFlagsMintRedeemLpPool` instruction without sending
	 * it. See `updateFeatureBitFlagsMintRedeemLpPool`.
	 * @returns The unsigned `updateFeatureBitFlagsMintRedeemLpPool` instruction.
	 */
	public async getUpdateFeatureBitFlagsMintRedeemLpPoolIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsMintRedeemLpPool(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets a user's `UserStats.pausedOperations` bitmask. Reachable by cold, warm,
	 * `HotRole.UserFlag`, or `pauseAdmin` (`PauseAdminUpdateUserStats`'s constraint
	 * ORs `check_pause` with `check_hot(.., UserFlag)`). A caller authorised only via
	 * `pauseAdmin` (i.e. not cold/warm/`UserFlag`) may add pause bits but never clear
	 * one; cold/warm/`UserFlag` may set any value. The `admin` account below defaults
	 * to `coldAdmin`; other roles must override it with their own pubkey.
	 * @param authority - Wallet authority whose `UserStats` PDA to update (derives the PDA).
	 * @param pausedOperations - New pause bitmask for the user's stats account.
	 * @returns Transaction signature.
	 */
	public async adminUpdateUserStatsPausedOperations(
		authority: PublicKey,
		pausedOperations: number
	): Promise<TransactionSignature> {
		const updateUserStatsPausedOperationsIx =
			await this.getAdminUpdateUserStatsPausedOperationsIx(
				authority,
				pausedOperations
			);

		const tx = await this.buildTransaction(updateUserStatsPausedOperationsIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `adminUpdateUserStatsPausedOperations` instruction without sending
	 * it. See `adminUpdateUserStatsPausedOperations`.
	 * @returns The unsigned `adminUpdateUserStatsPausedOperations` instruction.
	 */
	public async getAdminUpdateUserStatsPausedOperationsIx(
		authority: PublicKey,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.adminUpdateUserStatsPausedOperations(
			pausedOperations,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					userStats: getUserStatsAccountPublicKey(
						this.program.programId,
						authority
					),
				},
			}
		);
	}

	/**
	 * Creates a new LP pool: mints its 6-decimal LP-token mint (fresh `mint` keypair,
	 * mint authority set to the `lpPool` PDA), then initializes the `LPPool` account
	 * plus its (initially empty) `AmmConstituentMapping`, `ConstituentTargetBase`, and
	 * `ConstituentCorrelations` side accounts. Requires warm admin (`check_warm`).
	 * Constituents (backing spot-market assets) are added afterward via
	 * `initializeConstituent`.
	 * @param lpPoolId - New pool's id byte; seeds the `LPPool` PDA (`getLpPoolPublicKey`).
	 * @param minMintFee - Minimum fee floor charged on mint, signed, PERCENTAGE_PRECISION (1e6).
	 * @param maxAum - AUM cap above which minting new LP tokens is rejected, QUOTE_PRECISION (1e6).
	 * @param maxSettleQuoteAmountPerMarket - Per-perp-market cap on quote settled into/out of the pool per settlement, QUOTE_PRECISION (1e6).
	 * @param mint - Fresh keypair for the pool's LP-token mint; funded and initialized by this call, and must co-sign.
	 * @param whitelistMint - Optional token that gates who may mint/redeem this pool's LP token (see `updateLpPoolParams`). Defaults to `PublicKey.default` (no gating).
	 * @returns Transaction signature.
	 */
	public async initializeLpPool(
		lpPoolId: number,
		minMintFee: BN,
		maxAum: BN,
		maxSettleQuoteAmountPerMarket: BN,
		mint: Keypair,
		whitelistMint?: PublicKey
	): Promise<TransactionSignature> {
		const ixs = await this.getInitializeLpPoolIx(
			lpPoolId,
			minMintFee,
			maxAum,
			maxSettleQuoteAmountPerMarket,
			mint,
			whitelistMint
		);
		const tx = await this.buildTransaction(ixs);
		const { txSig } = await this.sendTransaction(tx, [mint]);
		return txSig;
	}

	/**
	 * Builds the `createAccount` + `initializeMint2` + `initializeLpPool` instructions
	 * without sending them. See `initializeLpPool`.
	 * @returns The unsigned instructions (mint account creation, mint init, pool init) in order; `mint` must also sign the transaction.
	 */
	public async getInitializeLpPoolIx(
		lpPoolId: number,
		minMintFee: BN,
		maxAum: BN,
		maxSettleQuoteAmountPerMarket: BN,
		mint: Keypair,
		whitelistMint?: PublicKey
	): Promise<TransactionInstruction[]> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		const ammConstituentMapping = getAmmConstituentMappingPublicKey(
			this.program.programId,
			lpPool
		);
		const constituentTargetBase = getConstituentTargetBasePublicKey(
			this.program.programId,
			lpPool
		);

		const lamports =
			await this.program.provider.connection.getMinimumBalanceForRentExemption(
				MINT_SIZE
			);
		const createMintAccountIx = SystemProgram.createAccount({
			fromPubkey: this.wallet.publicKey,
			newAccountPubkey: mint.publicKey,
			space: MINT_SIZE,
			lamports: Math.min(0.05 * LAMPORTS_PER_SOL, lamports), // should be 0.0014616 ? but bankrun returns 10 SOL
			programId: TOKEN_PROGRAM_ID,
		});
		const createMintIx = createInitializeMint2Instruction(
			mint.publicKey,
			6,
			lpPool,
			null,
			TOKEN_PROGRAM_ID
		);

		return [
			createMintAccountIx,
			createMintIx,
			this.program.instruction.initializeLpPool(
				lpPoolId,
				minMintFee,
				maxAum,
				maxSettleQuoteAmountPerMarket,
				whitelistMint ?? PublicKey.default,
				{
					accounts: {
						admin: this.wallet.publicKey,
						lpPool,
						lpPoolTokenVault: getLpPoolTokenVaultPublicKey(
							this.program.programId,
							lpPool
						),
						constituentCorrelations: getConstituentCorrelationsPublicKey(
							this.program.programId,
							lpPool
						),
						ammConstituentMapping,
						constituentTargetBase,
						mint: mint.publicKey,
						state: await this.getStatePublicKey(),
						tokenProgram: TOKEN_PROGRAM_ID,
						rent: SYSVAR_RENT_PUBKEY,
						systemProgram: SystemProgram.programId,
					},
					signers: [mint],
				}
			),
		];
	}

	/**
	 * Adds a new constituent (backing spot-market asset) to an existing LP pool:
	 * creates its `Constituent` PDA + token vault, appends a slot to
	 * `ConstituentTargetBase`, and records its correlation row in
	 * `ConstituentCorrelations`. Requires warm admin (`check_warm`). On-chain,
	 * `newConstituentCorrelations`'s length must equal the pool's current constituent
	 * count *before* this call (one correlation entry per existing constituent); the
	 * new constituent's `constituentIndex` is assigned as the next sequential index.
	 * @param lpPoolId - Target LP pool's id byte.
	 * @param initializeConstituentParams - Constituent configuration; see `InitializeConstituentParams` for per-field precision.
	 * @returns Transaction signature.
	 */
	public async initializeConstituent(
		lpPoolId: number,
		initializeConstituentParams: InitializeConstituentParams
	): Promise<TransactionSignature> {
		const ixs = await this.getInitializeConstituentIx(
			lpPoolId,
			initializeConstituentParams
		);
		const tx = await this.buildTransaction(ixs);
		const { txSig } = await this.sendTransaction(tx, []);
		return txSig;
	}

	/**
	 * Builds the `initializeConstituent` instruction without sending it. See
	 * `initializeConstituent`.
	 * @returns The unsigned `initializeConstituent` instruction, as a single-element array.
	 */
	public async getInitializeConstituentIx(
		lpPoolId: number,
		initializeConstituentParams: InitializeConstituentParams
	): Promise<TransactionInstruction[]> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		const spotMarketIndex = initializeConstituentParams.spotMarketIndex;
		const constituentTargetBase = getConstituentTargetBasePublicKey(
			this.program.programId,
			lpPool
		);
		const constituent = getConstituentPublicKey(
			this.program.programId,
			lpPool,
			spotMarketIndex
		);
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(spotMarketIndex);

		return [
			this.program.instruction.initializeConstituent(
				spotMarketIndex,
				initializeConstituentParams.decimals,
				initializeConstituentParams.maxWeightDeviation,
				initializeConstituentParams.swapFeeMin,
				initializeConstituentParams.swapFeeMax,
				initializeConstituentParams.maxBorrowTokenAmount,
				initializeConstituentParams.oracleStalenessThreshold,
				initializeConstituentParams.costToTrade,
				initializeConstituentParams.constituentDerivativeIndex != null
					? initializeConstituentParams.constituentDerivativeIndex
					: null,
				initializeConstituentParams.constituentDerivativeDepegThreshold != null
					? initializeConstituentParams.constituentDerivativeDepegThreshold
					: ZERO,
				initializeConstituentParams.constituentDerivativeIndex != null
					? initializeConstituentParams.derivativeWeight
					: ZERO,
				initializeConstituentParams.volatility != null
					? initializeConstituentParams.volatility
					: 10,
				initializeConstituentParams.gammaExecution != null
					? initializeConstituentParams.gammaExecution
					: 2,
				initializeConstituentParams.gammaInventory != null
					? initializeConstituentParams.gammaInventory
					: 2,
				initializeConstituentParams.xi != null
					? initializeConstituentParams.xi
					: 2,
				initializeConstituentParams.constituentCorrelations,
				{
					accounts: {
						admin: this.wallet.publicKey,
						lpPool,
						constituentTargetBase,
						constituent,
						rent: SYSVAR_RENT_PUBKEY,
						systemProgram: SystemProgram.programId,
						state: await this.getStatePublicKey(),
						spotMarketMint: spotMarketAccount.mint,
						constituentVault: getConstituentVaultPublicKey(
							this.program.programId,
							lpPool,
							spotMarketIndex
						),
						constituentCorrelations: getConstituentCorrelationsPublicKey(
							this.program.programId,
							lpPool
						),
						spotMarket: spotMarketAccount.pubkey,
						tokenProgram: TOKEN_PROGRAM_ID,
					},
					signers: [],
				}
			),
		];
	}

	/**
	 * Sets an LP-pool constituent's lifecycle `status` (`ConstituentStatus`: `ACTIVE`,
	 * `REDUCE_ONLY`, or `DECOMMISSIONED`). Requires warm admin (`check_warm`).
	 * `REDUCE_ONLY` restricts flows to only shrink the constituent toward its target
	 * weight; `DECOMMISSIONED` marks it as having no remaining participants.
	 * @param constituent - Constituent PDA to update.
	 * @param constituentStatus - New status.
	 * @returns Transaction signature.
	 */
	public async updateConstituentStatus(
		constituent: PublicKey,
		constituentStatus: ConstituentStatus
	): Promise<TransactionSignature> {
		const updateConstituentStatusIx = await this.getUpdateConstituentStatusIx(
			constituent,
			constituentStatus
		);

		const tx = await this.buildTransaction(updateConstituentStatusIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateConstituentStatus` instruction without sending it. See
	 * `updateConstituentStatus`.
	 * @returns The unsigned `updateConstituentStatus` instruction.
	 */
	public async getUpdateConstituentStatusIx(
		constituent: PublicKey,
		constituentStatus: ConstituentStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateConstituentStatus(
			constituentStatus,
			{
				accounts: {
					constituent,
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Sets an LP-pool constituent's `pausedOperations` bitmask (`ConstituentLpOperation`:
	 * `Swap`/`Deposit`/`Withdraw`). Requires warm admin (`check_warm`) — despite the
	 * `useHotWalletAdmin` flag name used for the default `admin` account below, no
	 * dedicated hot role exists for this ix; the signer must be cold or warm.
	 * @param constituent - Constituent PDA to update.
	 * @param pausedOperations - New pause bitmask, `ConstituentLpOperation` bit values.
	 * @returns Transaction signature.
	 */
	public async updateConstituentPausedOperations(
		constituent: PublicKey,
		pausedOperations: number
	): Promise<TransactionSignature> {
		const updateConstituentPausedOperationsIx =
			await this.getUpdateConstituentPausedOperationsIx(
				constituent,
				pausedOperations
			);

		const tx = await this.buildTransaction(updateConstituentPausedOperationsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	/**
	 * Builds the `updateConstituentPausedOperations` instruction without sending it.
	 * See `updateConstituentPausedOperations`.
	 * @returns The unsigned `updateConstituentPausedOperations` instruction.
	 */
	public async getUpdateConstituentPausedOperationsIx(
		constituent: PublicKey,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateConstituentPausedOperations(
			pausedOperations,
			{
				accounts: {
					constituent,
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	/**
	 * Patches an LP-pool constituent's tunable params — each field is optional and
	 * only the ones provided overwrite the on-chain value (see `ConstituentAccount`
	 * for per-field precision, which matches these params 1:1). Requires warm admin
	 * (`check_warm`); the underlying ix builder resolves `admin` as `this.wallet`
	 * directly (no cold/warm fallback), so `this.wallet` must itself hold that role.
	 * @param lpPoolId - Constituent's parent LP pool id byte.
	 * @param constituentPublicKey - Constituent PDA to patch.
	 * @param updateConstituentParams - Partial param patch; unset fields are left unchanged. `costToTradeBps` is bps and lives on the pool's `ConstituentTargetBase`, not the `Constituent` account itself.
	 * @returns Transaction signature.
	 */
	public async updateConstituentParams(
		lpPoolId: number,
		constituentPublicKey: PublicKey,
		updateConstituentParams: {
			maxWeightDeviation?: BN;
			swapFeeMin?: BN;
			swapFeeMax?: BN;
			maxBorrowTokenAmount?: BN;
			oracleStalenessThreshold?: BN;
			costToTradeBps?: number;
			derivativeWeight?: BN;
			constituentDerivativeIndex?: number;
			volatility?: BN;
			gammaExecution?: number;
			gammaInventory?: number;
			xi?: number;
		}
	): Promise<TransactionSignature> {
		const ixs = await this.getUpdateConstituentParamsIx(
			lpPoolId,
			constituentPublicKey,
			updateConstituentParams
		);
		const tx = await this.buildTransaction(ixs);
		const { txSig } = await this.sendTransaction(tx, []);
		return txSig;
	}

	/**
	 * Builds the `updateConstituentParams` instruction without sending it. Note this
	 * method's parameter type omits `costToTradeBps` even though the public
	 * `updateConstituentParams` wrapper's type includes it and forwards it through
	 * unchanged at runtime — call via `updateConstituentParams` (or add the field
	 * manually) if you need to set it while calling this builder directly. See
	 * `updateConstituentParams`.
	 * @returns The unsigned `updateConstituentParams` instruction, as a single-element array.
	 */
	public async getUpdateConstituentParamsIx(
		lpPoolId: number,
		constituentPublicKey: PublicKey,
		updateConstituentParams: {
			maxWeightDeviation?: BN;
			swapFeeMin?: BN;
			swapFeeMax?: BN;
			maxBorrowTokenAmount?: BN;
			oracleStalenessThreshold?: BN;
			derivativeWeight?: BN;
			constituentDerivativeIndex?: number;
			volatility?: BN;
			gammaExecution?: number;
			gammaInventory?: number;
			xi?: number;
		}
	): Promise<TransactionInstruction[]> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		return [
			this.program.instruction.updateConstituentParams(
				Object.assign(
					{
						maxWeightDeviation: null,
						swapFeeMin: null,
						swapFeeMax: null,
						maxBorrowTokenAmount: null,
						oracleStalenessThreshold: null,
						costToTradeBps: null,
						stablecoinWeight: null,
						derivativeWeight: null,
						constituentDerivativeIndex: null,
						volatility: null,
						gammaExecution: null,
						gammaInventory: null,
						xi: null,
					},
					updateConstituentParams
				),
				{
					accounts: {
						admin: this.wallet.publicKey,
						constituent: constituentPublicKey,
						state: await this.getStatePublicKey(),
						lpPool,
						constituentTargetBase: getConstituentTargetBasePublicKey(
							this.program.programId,
							lpPool
						),
					},
					signers: [],
				}
			),
		];
	}

	/**
	 * Patches an LP pool's tunable params — each field is optional and only the ones
	 * provided overwrite the on-chain value. Requires warm admin (`check_warm`). If
	 * `maxAum` is provided, on-chain validation rejects lowering it below the pool's
	 * current `maxAum` (the cap may only be raised via this ix).
	 * @param lpPoolId - Target LP pool's id byte.
	 * @param updateLpPoolParams - Partial param patch; unset fields are left unchanged. `maxSettleQuoteAmount` and `maxAum` are QUOTE_PRECISION (1e6); `volatility` is PERCENTAGE_PRECISION (1e6); `whitelistMint` gates who may mint/redeem the pool's LP token.
	 * @returns Transaction signature.
	 */
	public async updateLpPoolParams(
		lpPoolId: number,
		updateLpPoolParams: {
			maxSettleQuoteAmount?: BN;
			volatility?: BN;
			gammaExecution?: number;
			xi?: number;
			whitelistMint?: PublicKey;
			maxAum?: BN;
		}
	): Promise<TransactionSignature> {
		const ixs = await this.getUpdateLpPoolParamsIx(
			lpPoolId,
			updateLpPoolParams
		);
		const tx = await this.buildTransaction(ixs);
		const { txSig } = await this.sendTransaction(tx, []);
		return txSig;
	}

	/**
	 * Builds the `updateLpPoolParams` instruction without sending it. See
	 * `updateLpPoolParams`.
	 * @returns The unsigned `updateLpPoolParams` instruction, as a single-element array.
	 */
	public async getUpdateLpPoolParamsIx(
		lpPoolId: number,
		updateLpPoolParams: {
			maxSettleQuoteAmount?: BN;
			volatility?: BN;
			gammaExecution?: number;
			xi?: number;
			whitelistMint?: PublicKey;
			maxAum?: BN;
		}
	): Promise<TransactionInstruction[]> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		return [
			this.program.instruction.updateLpPoolParams(
				Object.assign(
					{
						maxSettleQuoteAmount: null,
						volatility: null,
						gammaExecution: null,
						xi: null,
						whitelistMint: null,
						maxAum: null,
					},
					updateLpPoolParams
				),
				{
					accounts: {
						admin: this.wallet.publicKey,
						state: await this.getStatePublicKey(),
						lpPool,
					},
					signers: [],
				}
			),
		];
	}

	/**
	 * Adds new (perp market, constituent) weight entries to an LP pool's
	 * `AmmConstituentMapping` — routing that fraction of the perp market's hedge flow
	 * into the given constituent. Requires warm admin (`check_warm`). On-chain,
	 * inserting a `(perpMarketIndex, constituentIndex)` pair that already exists fails
	 * (`InvalidAmmConstituentMappingArgument`) — use `updateAmmConstituentMappingData`
	 * to change an existing entry's weight instead.
	 * @param lpPoolId - Target LP pool's id byte.
	 * @param addAmmConstituentMappingData - New entries to add; see `AddAmmConstituentMappingDatum` (`weight` is PERCENTAGE_PRECISION, 1e6).
	 * @returns Transaction signature.
	 */
	public async addAmmConstituentMappingData(
		lpPoolId: number,
		addAmmConstituentMappingData: AddAmmConstituentMappingDatum[]
	): Promise<TransactionSignature> {
		const ixs = await this.getAddAmmConstituentMappingDataIx(
			lpPoolId,
			addAmmConstituentMappingData
		);
		const tx = await this.buildTransaction(ixs);
		const { txSig } = await this.sendTransaction(tx, []);
		return txSig;
	}

	/**
	 * Builds the `addAmmConstituentMappingData` instruction without sending it (the
	 * `as any` cast works around a generated-type mismatch, not a missing on-chain
	 * instruction — `add_amm_constituent_mapping_data` is present in the IDL). See
	 * `addAmmConstituentMappingData`.
	 * @returns The unsigned `addAmmConstituentMappingData` instruction, as a single-element array.
	 */
	public async getAddAmmConstituentMappingDataIx(
		lpPoolId: number,
		addAmmConstituentMappingData: AddAmmConstituentMappingDatum[]
	): Promise<TransactionInstruction[]> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		const ammConstituentMapping = getAmmConstituentMappingPublicKey(
			this.program.programId,
			lpPool
		);
		const constituentTargetBase = getConstituentTargetBasePublicKey(
			this.program.programId,
			lpPool
		);
		return [
			(this.program.instruction as any).addAmmConstituentMappingData(
				addAmmConstituentMappingData,
				{
					accounts: {
						admin: this.wallet.publicKey,
						lpPool,
						ammConstituentMapping,
						constituentTargetBase,
						rent: SYSVAR_RENT_PUBKEY,
						systemProgram: SystemProgram.programId,
						state: await this.getStatePublicKey(),
					},
				}
			),
		];
	}

	/**
	 * Updates the weight (and refreshes `lastSlot`) of existing entries in an LP
	 * pool's `AmmConstituentMapping`. Requires warm admin (`check_warm`). On-chain,
	 * every `(perpMarketIndex, constituentIndex)` pair must already exist — an unknown
	 * pair fails with `InvalidAmmConstituentMappingArgument` (use
	 * `addAmmConstituentMappingData` to create new entries).
	 * @param lpPoolId - Target LP pool's id byte.
	 * @param addAmmConstituentMappingData - Entries to update in place; see `AddAmmConstituentMappingDatum` (`weight` is PERCENTAGE_PRECISION, 1e6).
	 * @returns Transaction signature.
	 */
	public async updateAmmConstituentMappingData(
		lpPoolId: number,
		addAmmConstituentMappingData: AddAmmConstituentMappingDatum[]
	): Promise<TransactionSignature> {
		const ixs = await this.getUpdateAmmConstituentMappingDataIx(
			lpPoolId,
			addAmmConstituentMappingData
		);
		const tx = await this.buildTransaction(ixs);
		const { txSig } = await this.sendTransaction(tx, []);
		return txSig;
	}

	/**
	 * Builds the `updateAmmConstituentMappingData` instruction without sending it. See
	 * `updateAmmConstituentMappingData`.
	 * @returns The unsigned `updateAmmConstituentMappingData` instruction, as a single-element array.
	 */
	public async getUpdateAmmConstituentMappingDataIx(
		lpPoolId: number,
		addAmmConstituentMappingData: AddAmmConstituentMappingDatum[]
	): Promise<TransactionInstruction[]> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		const ammConstituentMapping = getAmmConstituentMappingPublicKey(
			this.program.programId,
			lpPool
		);
		return [
			this.program.instruction.updateAmmConstituentMappingData(
				addAmmConstituentMappingData,
				{
					accounts: {
						admin: this.wallet.publicKey,
						lpPool,
						ammConstituentMapping,
						systemProgram: SystemProgram.programId,
						state: await this.getStatePublicKey(),
					},
				}
			),
		];
	}

	/**
	 * Removes a single `(perpMarketIndex, constituentIndex)` entry from an LP pool's
	 * `AmmConstituentMapping`. Requires warm admin (`check_warm`). Fails
	 * (`InvalidAmmConstituentMappingArgument`) if no matching entry exists.
	 * @param lpPoolId - Target LP pool's id byte.
	 * @param perpMarketIndex - Perp market side of the entry to remove.
	 * @param constituentIndex - Constituent side of the entry to remove.
	 * @returns Transaction signature.
	 */
	public async removeAmmConstituentMappingData(
		lpPoolId: number,
		perpMarketIndex: number,
		constituentIndex: number
	): Promise<TransactionSignature> {
		const ixs = await this.getRemoveAmmConstituentMappingDataIx(
			lpPoolId,
			perpMarketIndex,
			constituentIndex
		);
		const tx = await this.buildTransaction(ixs);
		const { txSig } = await this.sendTransaction(tx, []);
		return txSig;
	}

	/**
	 * Builds the `removeAmmConstituentMappingData` instruction without sending it. See
	 * `removeAmmConstituentMappingData`.
	 * @returns The unsigned `removeAmmConstituentMappingData` instruction, as a single-element array.
	 */
	public async getRemoveAmmConstituentMappingDataIx(
		lpPoolId: number,
		perpMarketIndex: number,
		constituentIndex: number
	): Promise<TransactionInstruction[]> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		const ammConstituentMapping = getAmmConstituentMappingPublicKey(
			this.program.programId,
			lpPool
		);

		return [
			this.program.instruction.removeAmmConstituentMappingData(
				perpMarketIndex,
				constituentIndex,
				{
					accounts: {
						admin: this.wallet.publicKey,
						lpPool,
						ammConstituentMapping,
						systemProgram: SystemProgram.programId,
						state: await this.getStatePublicKey(),
					},
				}
			),
		];
	}

	/**
	 * Sets the correlation between two constituents in an LP pool's
	 * `ConstituentCorrelations` matrix (symmetric — updates both `(index1, index2)`
	 * and `(index2, index1)`). Requires warm admin (`check_warm`).
	 * @param lpPoolId - Target LP pool's id byte.
	 * @param index1 - First constituent's index.
	 * @param index2 - Second constituent's index.
	 * @param correlation - New correlation, PERCENTAGE_PRECISION (1e6), signed.
	 * @returns Transaction signature.
	 */
	public async updateConstituentCorrelationData(
		lpPoolId: number,
		index1: number,
		index2: number,
		correlation: BN
	): Promise<TransactionSignature> {
		const ixs = await this.getUpdateConstituentCorrelationDataIx(
			lpPoolId,
			index1,
			index2,
			correlation
		);
		const tx = await this.buildTransaction(ixs);
		const { txSig } = await this.sendTransaction(tx, []);
		return txSig;
	}

	/**
	 * Builds the `updateConstituentCorrelationData` instruction without sending it.
	 * See `updateConstituentCorrelationData`.
	 * @returns The unsigned `updateConstituentCorrelationData` instruction, as a single-element array.
	 */
	public async getUpdateConstituentCorrelationDataIx(
		lpPoolId: number,
		index1: number,
		index2: number,
		correlation: BN
	): Promise<TransactionInstruction[]> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		return [
			this.program.instruction.updateConstituentCorrelationData(
				index1,
				index2,
				correlation,
				{
					accounts: {
						admin: this.wallet.publicKey,
						lpPool,
						constituentCorrelations: getConstituentCorrelationsPublicKey(
							this.program.programId,
							lpPool
						),
						state: await this.getStatePublicKey(),
					},
				}
			),
		];
	}

	/**
	 * Get the velocity begin_swap and end_swap instructions
	 *
	 * @param outMarketIndex the market index of the token you're buying
	 * @param inMarketIndex the market index of the token you're selling
	 * @param amountIn the amount of the token to sell
	 * @param inTokenAccount the token account to move the tokens being sold (admin signer ata for lp swap)
	 * @param outTokenAccount the token account to receive the tokens being bought (admin signer ata for lp swap)
	 * @param limitPrice the limit price of the swap
	 * @param reduceOnly
	 * @param userAccountPublicKey optional, specify a custom userAccountPublicKey to use instead of getting the current user account; can be helpful if the account is being created within the current tx
	 */
	public async getSwapIx(
		{
			lpPoolId,
			outMarketIndex,
			inMarketIndex,
			amountIn,
			inTokenAccount,
			outTokenAccount,
			limitPrice,
			reduceOnly,
			userAccountPublicKey,
		}: {
			lpPoolId: number;
			outMarketIndex: number;
			inMarketIndex: number;
			amountIn: BN;
			inTokenAccount: PublicKey;
			outTokenAccount: PublicKey;
			limitPrice?: BN;
			reduceOnly?: SwapReduceOnly;
			userAccountPublicKey?: PublicKey;
		},
		lpSwap?: boolean
	): Promise<{
		beginSwapIx: TransactionInstruction;
		endSwapIx: TransactionInstruction;
	}> {
		if (!lpSwap) {
			return super.getSwapIx({
				outMarketIndex,
				inMarketIndex,
				amountIn,
				inTokenAccount,
				outTokenAccount,
				limitPrice,
				reduceOnly,
				userAccountPublicKey,
			});
		}
		const outSpotMarket = this.getSpotMarketAccountOrThrow(outMarketIndex);
		const inSpotMarket = this.getSpotMarketAccountOrThrow(inMarketIndex);

		const outTokenProgram = this.getTokenProgramForSpotMarket(outSpotMarket);
		const inTokenProgram = this.getTokenProgramForSpotMarket(inSpotMarket);

		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		const outConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool,
			outMarketIndex
		);
		const inConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool,
			inMarketIndex
		);

		const outConstituentTokenAccount = getConstituentVaultPublicKey(
			this.program.programId,
			lpPool,
			outMarketIndex
		);
		const inConstituentTokenAccount = getConstituentVaultPublicKey(
			this.program.programId,
			lpPool,
			inMarketIndex
		);

		const beginSwapIx = this.program.instruction.beginLpSwap(
			inMarketIndex,
			outMarketIndex,
			amountIn,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					signerOutTokenAccount: outTokenAccount,
					signerInTokenAccount: inTokenAccount,
					constituentOutTokenAccount: outConstituentTokenAccount,
					constituentInTokenAccount: inConstituentTokenAccount,
					outConstituent,
					inConstituent,
					lpPool,
					instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
					tokenProgram: inTokenProgram,
				},
			}
		);

		const remainingAccounts: AccountMeta[] = [];
		remainingAccounts.push({
			pubkey: outTokenProgram,
			isWritable: false,
			isSigner: false,
		});

		const endSwapIx = this.program.instruction.endLpSwap(
			inMarketIndex,
			outMarketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					signerOutTokenAccount: outTokenAccount,
					signerInTokenAccount: inTokenAccount,
					constituentOutTokenAccount: outConstituentTokenAccount,
					constituentInTokenAccount: inConstituentTokenAccount,
					outConstituent,
					inConstituent,
					lpPool,
					tokenProgram: inTokenProgram,
					instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts,
			}
		);

		return { beginSwapIx, endSwapIx };
	}

	/**
	 * Builds a flash-loan-style LP-pool swap that routes the actual trade through
	 * Jupiter: wraps a Jupiter swap quote/instruction set between the same
	 * `beginLpSwap`/`endLpSwap` instruction pair `getSwapIx` uses, so the LP pool's
	 * constituent vaults temporarily fund the swap and are repaid by the end of the
	 * transaction (`endLpSwap` fails if the constituents aren't made whole). Fetches
	 * a quote from `jupiterClient` if one isn't passed in.
	 * @param jupiterClient - Jupiter client used to fetch the quote/swap transaction and lookup tables.
	 * @param outMarketIndex - Spot market of the token being bought.
	 * @param inMarketIndex - Spot market of the token being sold.
	 * @param amount - Swap amount, in-market's native decimals (interpreted as exact-in or exact-out per `swapMode`).
	 * @param slippageBps - Optional slippage tolerance passed to Jupiter, basis points.
	 * @param swapMode - Optional `'ExactIn'` / `'ExactOut'`; also inferred from `quote.swapMode` if a quote is supplied.
	 * @param onlyDirectRoutes - Optional, restricts the Jupiter quote to single-hop routes.
	 * @param quote - Optional pre-fetched Jupiter quote; skips the internal fetch if provided.
	 * @param lpPoolId - LP pool id byte the swap routes through.
	 * @returns The unsigned instruction sequence (begin-swap, Jupiter swap instructions, end-swap) and any address lookup tables the Jupiter instructions require.
	 */
	public async getLpJupiterSwapIxV6({
		jupiterClient,
		outMarketIndex,
		inMarketIndex,
		amount,
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		quote,
		lpPoolId,
	}: {
		jupiterClient: JupiterClient;
		outMarketIndex: number;
		inMarketIndex: number;
		outAssociatedTokenAccount?: PublicKey;
		inAssociatedTokenAccount?: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
		quote?: QuoteResponse;
		lpPoolId: number;
	}): Promise<{
		ixs: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}> {
		const outMarket = this.getSpotMarketAccountOrThrow(outMarketIndex);
		const inMarket = this.getSpotMarketAccountOrThrow(inMarketIndex);

		if (!quote) {
			const fetchedQuote = await jupiterClient.getQuote({
				inputMint: inMarket.mint,
				outputMint: outMarket.mint,
				amount,
				slippageBps,
				swapMode,
				onlyDirectRoutes,
			});

			quote = fetchedQuote;
		}

		if (!quote) {
			throw new Error('Could not fetch swap quote. Please try again.');
		}

		const isExactOut = swapMode === 'ExactOut' || quote.swapMode === 'ExactOut';
		const amountIn = new BN(quote.inAmount);
		const exactOutBufferedAmountIn = amountIn.muln(1001).divn(1000); // Add 10bp buffer

		const transaction = await jupiterClient.getSwap({
			quote,
			userPublicKey: this.provider.wallet.publicKey,
			slippageBps,
		});

		const { transactionMessage, lookupTables } =
			await jupiterClient.getTransactionMessageAndLookupTables({
				transaction,
			});

		const jupiterInstructions = jupiterClient.getJupiterInstructions({
			transactionMessage,
			inputMint: inMarket.mint,
			outputMint: outMarket.mint,
		});

		const preInstructions = [];
		const tokenProgram = this.getTokenProgramForSpotMarket(outMarket);
		const outAssociatedTokenAccount = await this.getAssociatedTokenAccount(
			outMarket.marketIndex,
			false,
			tokenProgram
		);

		const outAccountInfo = await this.connection.getAccountInfo(
			outAssociatedTokenAccount
		);
		if (!outAccountInfo) {
			preInstructions.push(
				this.createAssociatedTokenAccountIdempotentInstruction(
					outAssociatedTokenAccount,
					this.provider.wallet.publicKey,
					this.provider.wallet.publicKey,
					outMarket.mint,
					tokenProgram
				)
			);
		}

		const inTokenProgram = this.getTokenProgramForSpotMarket(inMarket);
		const inAssociatedTokenAccount = await this.getAssociatedTokenAccount(
			inMarket.marketIndex,
			false,
			inTokenProgram
		);

		const inAccountInfo = await this.connection.getAccountInfo(
			inAssociatedTokenAccount
		);
		if (!inAccountInfo) {
			preInstructions.push(
				this.createAssociatedTokenAccountIdempotentInstruction(
					inAssociatedTokenAccount,
					this.provider.wallet.publicKey,
					this.provider.wallet.publicKey,
					inMarket.mint,
					tokenProgram
				)
			);
		}

		const { beginSwapIx, endSwapIx } = await this.getSwapIx(
			{
				lpPoolId,
				outMarketIndex,
				inMarketIndex,
				amountIn: isExactOut ? exactOutBufferedAmountIn : amountIn,
				inTokenAccount: inAssociatedTokenAccount,
				outTokenAccount: outAssociatedTokenAccount,
			},
			true
		);

		const ixs = [
			...preInstructions,
			beginSwapIx,
			...jupiterInstructions,
			endSwapIx,
		];

		return { ixs, lookupTables };
	}

	/**
	 * Devnet/test-only helper: builds a plain SPL-token transfer pair simulating an
	 * external counterparty swapping against `this.wallet`'s own token accounts (not
	 * an atomic on-chain program instruction, and not gated by any admin tier — it's
	 * ordinary token transfers assembled for local test flows, typically alongside
	 * `getSwapIx`'s begin/end pair as in `getAllDevnetLpSwapIxs`). Also idempotently
	 * creates the external user's in/out ATAs.
	 * @param amountIn - Amount `this.wallet` sends of the in-market token, that market's native decimals.
	 * @param amountOut - Amount `this.wallet` receives of the out-market token, that market's native decimals.
	 * @param externalUserAuthority - The simulated counterparty's wallet authority.
	 * @param externalUserInTokenAccount - Counterparty's ATA that receives the in-market token.
	 * @param externalUserOutTokenAccount - Counterparty's ATA that sends the out-market token.
	 * @param inSpotMarketIndex - Spot market of the token `this.wallet` sends.
	 * @param outSpotMarketIndex - Spot market of the token `this.wallet` receives.
	 * @returns Unsigned instructions: create both ATAs, then the two transfers.
	 */
	public async getDevnetLpSwapIxs(
		amountIn: BN,
		amountOut: BN,
		externalUserAuthority: PublicKey,
		externalUserInTokenAccount: PublicKey,
		externalUserOutTokenAccount: PublicKey,
		inSpotMarketIndex: number,
		outSpotMarketIndex: number
	): Promise<TransactionInstruction[]> {
		const inSpotMarketAccount =
			this.getSpotMarketAccountOrThrow(inSpotMarketIndex);
		const outSpotMarketAccount =
			this.getSpotMarketAccountOrThrow(outSpotMarketIndex);

		const outTokenAccount = await this.getAssociatedTokenAccount(
			outSpotMarketAccount.marketIndex,
			false,
			getTokenProgramForSpotMarket(outSpotMarketAccount)
		);
		const inTokenAccount = await this.getAssociatedTokenAccount(
			inSpotMarketAccount.marketIndex,
			false,
			getTokenProgramForSpotMarket(inSpotMarketAccount)
		);

		const externalCreateInTokenAccountIx =
			this.createAssociatedTokenAccountIdempotentInstruction(
				externalUserInTokenAccount,
				this.wallet.publicKey,
				externalUserAuthority,
				this.getSpotMarketAccount(inSpotMarketIndex)!.mint
			);

		const externalCreateOutTokenAccountIx =
			this.createAssociatedTokenAccountIdempotentInstruction(
				externalUserOutTokenAccount,
				this.wallet.publicKey,
				externalUserAuthority,
				this.getSpotMarketAccount(outSpotMarketIndex)!.mint
			);

		const outTransferIx = createTransferCheckedInstruction(
			externalUserOutTokenAccount,
			outSpotMarketAccount.mint,
			outTokenAccount,
			externalUserAuthority,
			amountOut.toNumber(),
			outSpotMarketAccount.decimals,
			undefined,
			getTokenProgramForSpotMarket(outSpotMarketAccount)
		);

		const inTransferIx = createTransferCheckedInstruction(
			inTokenAccount,
			inSpotMarketAccount.mint,
			externalUserInTokenAccount,
			this.wallet.publicKey,
			amountIn.toNumber(),
			inSpotMarketAccount.decimals,
			undefined,
			getTokenProgramForSpotMarket(inSpotMarketAccount)
		);

		const ixs = [
			externalCreateInTokenAccountIx,
			externalCreateOutTokenAccountIx,
			outTransferIx,
			inTransferIx,
		];
		return ixs;
	}

	/**
	 * Devnet/test-only helper: wraps `getSwapIx`'s begin/end LP-pool swap pair around
	 * `getDevnetLpSwapIxs`'s simulated-counterparty transfers, producing the full
	 * instruction sequence for an end-to-end devnet LP-pool swap test.
	 * @param lpPoolId - LP pool id byte the swap routes through.
	 * @param inMarketIndex - Spot market of the token going in.
	 * @param outMarketIndex - Spot market of the token coming out.
	 * @param inAmount - Amount going in, in-market's native decimals.
	 * @param minOutAmount - Minimum acceptable amount out, out-market's native decimals (also used as the simulated counterparty's exact transfer amount).
	 * @param externalUserAuthority - The simulated counterparty's wallet authority.
	 * @returns Unsigned instructions: begin-swap, the simulated transfer pair, end-swap, in order.
	 */
	public async getAllDevnetLpSwapIxs(
		lpPoolId: number,
		inMarketIndex: number,
		outMarketIndex: number,
		inAmount: BN,
		minOutAmount: BN,
		externalUserAuthority: PublicKey
	) {
		const inMarket = this.getSpotMarketAccountOrThrow(inMarketIndex);
		const outMarket = this.getSpotMarketAccountOrThrow(outMarketIndex);
		const { beginSwapIx, endSwapIx } = await this.getSwapIx(
			{
				lpPoolId,
				inMarketIndex,
				outMarketIndex,
				amountIn: inAmount,
				inTokenAccount: await this.getAssociatedTokenAccount(
					inMarketIndex,
					false
				),
				outTokenAccount: await this.getAssociatedTokenAccount(
					outMarketIndex,
					false
				),
			},
			true
		);

		const devnetLpSwapIxs = await this.getDevnetLpSwapIxs(
			inAmount,
			minOutAmount,
			externalUserAuthority,
			await this.getAssociatedTokenAccount(
				inMarketIndex,
				false,
				getTokenProgramForSpotMarket(inMarket),
				externalUserAuthority
			),
			await this.getAssociatedTokenAccount(
				outMarketIndex,
				false,
				getTokenProgramForSpotMarket(outMarket),
				externalUserAuthority
			),
			inMarketIndex,
			outMarketIndex
		);

		return [
			beginSwapIx,
			...devnetLpSwapIxs,
			endSwapIx,
		] as TransactionInstruction[];
	}

	/**
	 * Atomically moves an LP-pool constituent's idle tokens into a spot market's
	 * lending vault (earning yield) and borrows another constituent's tokens back out
	 * of a (possibly different) spot market's vault, in one transaction. Requires
	 * `HotRole.LpSwap` on both legs (`DepositProgramVault`/`WithdrawProgramVault`
	 * contexts) — `this.wallet` signs as `admin` directly and must hold that role.
	 * Each leg re-validates the constituent's borrow/token-amount invariants
	 * on-chain; the withdraw leg additionally caps the transfer at
	 * `constituent.maxBorrowTokenAmount` (+5% buffer).
	 * @param lpPoolId - LP pool whose constituents to move tokens for.
	 * @param depositMarketIndex - Spot market (and matching constituent) to deposit into.
	 * @param borrowMarketIndex - Spot market (and matching constituent) to borrow/withdraw from.
	 * @param amountToDeposit - Deposit amount, the deposit market's native decimals.
	 * @param amountToBorrow - Withdraw amount, the borrow market's native decimals.
	 * @returns Transaction signature.
	 */
	public async depositWithdrawToProgramVault(
		lpPoolId: number,
		depositMarketIndex: number,
		borrowMarketIndex: number,
		amountToDeposit: BN,
		amountToBorrow: BN
	): Promise<TransactionSignature> {
		const { depositIx, withdrawIx } =
			await this.getDepositWithdrawToProgramVaultIxs(
				lpPoolId,
				depositMarketIndex,
				borrowMarketIndex,
				amountToDeposit,
				amountToBorrow
			);

		const tx = await this.buildTransaction([depositIx, withdrawIx]);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `depositToProgramVault` and `withdrawFromProgramVault` instructions
	 * without sending them. See `depositWithdrawToProgramVault`; also the building
	 * block for `getDepositToProgramVaultIx`/`getWithdrawFromProgramVaultIx`
	 * (each of which calls this with the unused leg's amount set to `0`).
	 * @returns The unsigned `{ depositIx, withdrawIx }` pair.
	 */
	public async getDepositWithdrawToProgramVaultIxs(
		lpPoolId: number,
		depositMarketIndex: number,
		borrowMarketIndex: number,
		amountToDeposit: BN,
		amountToBorrow: BN
	): Promise<{
		depositIx: TransactionInstruction;
		withdrawIx: TransactionInstruction;
	}> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		const depositSpotMarket =
			this.getSpotMarketAccountOrThrow(depositMarketIndex);
		const withdrawSpotMarket =
			this.getSpotMarketAccountOrThrow(borrowMarketIndex);

		const depositTokenProgram =
			this.getTokenProgramForSpotMarket(depositSpotMarket);
		const withdrawTokenProgram =
			this.getTokenProgramForSpotMarket(withdrawSpotMarket);

		const depositConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool,
			depositMarketIndex
		);
		const withdrawConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool,
			borrowMarketIndex
		);

		const depositConstituentTokenAccount = getConstituentVaultPublicKey(
			this.program.programId,
			lpPool,
			depositMarketIndex
		);
		const withdrawConstituentTokenAccount = getConstituentVaultPublicKey(
			this.program.programId,
			lpPool,
			borrowMarketIndex
		);

		const depositIx = this.program.instruction.depositToProgramVault(
			amountToDeposit,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					constituent: depositConstituent,
					constituentTokenAccount: depositConstituentTokenAccount,
					spotMarket: depositSpotMarket.pubkey,
					spotMarketVault: depositSpotMarket.vault,
					tokenProgram: depositTokenProgram,
					mint: depositSpotMarket.mint,
					oracle: depositSpotMarket.oracle,
				},
			}
		);

		const withdrawIx = this.program.instruction.withdrawFromProgramVault(
			amountToBorrow,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					constituent: withdrawConstituent,
					constituentTokenAccount: withdrawConstituentTokenAccount,
					spotMarket: withdrawSpotMarket.pubkey,
					spotMarketVault: withdrawSpotMarket.vault,
					tokenProgram: withdrawTokenProgram,
					mint: withdrawSpotMarket.mint,
					velocitySigner: getVelocitySignerPublicKey(this.program.programId),
					oracle: withdrawSpotMarket.oracle,
				},
			}
		);

		return { depositIx, withdrawIx };
	}

	/**
	 * Deposits an LP-pool constituent's idle tokens into its spot market's lending
	 * vault, on its own (single-leg version of `depositWithdrawToProgramVault`).
	 * Requires `HotRole.LpSwap`; `this.wallet` must hold that role.
	 * @param lpPoolId - LP pool whose constituent to deposit from.
	 * @param depositMarketIndex - Spot market (and matching constituent) to deposit into.
	 * @param amountToDeposit - Deposit amount, the market's native decimals.
	 * @returns Transaction signature.
	 */
	public async depositToProgramVault(
		lpPoolId: number,
		depositMarketIndex: number,
		amountToDeposit: BN
	): Promise<TransactionSignature> {
		const depositIx = await this.getDepositToProgramVaultIx(
			lpPoolId,
			depositMarketIndex,
			amountToDeposit
		);

		const tx = await this.buildTransaction([depositIx]);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Borrows tokens from a spot market's lending vault back into an LP-pool
	 * constituent, on its own (single-leg version of `depositWithdrawToProgramVault`).
	 * Requires `HotRole.LpSwap`; `this.wallet` must hold that role. On-chain, capped
	 * at `constituent.maxBorrowTokenAmount` (+5% buffer).
	 * @param lpPoolId - LP pool whose constituent to borrow into.
	 * @param borrowMarketIndex - Spot market (and matching constituent) to borrow from.
	 * @param amountToWithdraw - Withdraw amount, the market's native decimals.
	 * @returns Transaction signature.
	 */
	public async withdrawFromProgramVault(
		lpPoolId: number,
		borrowMarketIndex: number,
		amountToWithdraw: BN
	): Promise<TransactionSignature> {
		const withdrawIx = await this.getWithdrawFromProgramVaultIx(
			lpPoolId,
			borrowMarketIndex,
			amountToWithdraw
		);
		const tx = await this.buildTransaction([withdrawIx]);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `depositToProgramVault` instruction without sending it, via
	 * `getDepositWithdrawToProgramVaultIxs` with a `0` withdraw amount (the
	 * accompanying zero-amount withdraw instruction is discarded, not sent). See
	 * `depositToProgramVault`.
	 * @returns The unsigned `depositToProgramVault` instruction.
	 */
	public async getDepositToProgramVaultIx(
		lpPoolId: number,
		depositMarketIndex: number,
		amountToDeposit: BN
	): Promise<TransactionInstruction> {
		const { depositIx } = await this.getDepositWithdrawToProgramVaultIxs(
			lpPoolId,
			depositMarketIndex,
			depositMarketIndex,
			amountToDeposit,
			new BN(0)
		);
		return depositIx;
	}

	/**
	 * Builds the `withdrawFromProgramVault` instruction without sending it, via
	 * `getDepositWithdrawToProgramVaultIxs` with a `0` deposit amount (the
	 * accompanying zero-amount deposit instruction is discarded, not sent). See
	 * `withdrawFromProgramVault`.
	 * @returns The unsigned `withdrawFromProgramVault` instruction.
	 */
	public async getWithdrawFromProgramVaultIx(
		lpPoolId: number,
		borrowMarketIndex: number,
		amountToWithdraw: BN
	): Promise<TransactionInstruction> {
		const { withdrawIx } = await this.getDepositWithdrawToProgramVaultIxs(
			lpPoolId,
			borrowMarketIndex,
			borrowMarketIndex,
			new BN(0),
			amountToWithdraw
		);
		return withdrawIx;
	}

	/**
	 * Patches a perp market's `hedgeConfig` fee-routing scalars that control how much
	 * of the AMM's fee growth is swept to its LP pool (see `sweepPerpMarketFees`).
	 * Requires warm admin (the `HotAdminUpdatePerpMarketDlp` context's `check_warm`
	 * constraint). Both params are optional; only the ones provided are updated.
	 * @param marketIndex - Perp market to update.
	 * @param lpFeeTransferScalar - `hedgeConfig.feeTransferScalar`, percent 0-100 (divided by 100 on-chain) of AMM fee-pool growth routed to the LP pool.
	 * @param lpExchangeFeeExcluscionScalar - `hedgeConfig.exchangeFeeExclusionScalar`, percent 0-100 of the period's exchange-fee growth excluded from that sweep.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketLpPoolFeeTransferScalar(
		marketIndex: number,
		lpFeeTransferScalar?: number,
		lpExchangeFeeExcluscionScalar?: number
	) {
		const ix = await this.getUpdatePerpMarketLpPoolFeeTransferScalarIx(
			marketIndex,
			lpFeeTransferScalar,
			lpExchangeFeeExcluscionScalar
		);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketLpPoolFeeTransferScalar` instruction without
	 * sending it. See `updatePerpMarketLpPoolFeeTransferScalar`.
	 * @returns The unsigned `updatePerpMarketLpPoolFeeTransferScalar` instruction.
	 */
	public async getUpdatePerpMarketLpPoolFeeTransferScalarIx(
		marketIndex: number,
		lpFeeTransferScalar?: number,
		lpExchangeFeeExcluscionScalar?: number
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(marketIndex);
		return this.program.instruction.updatePerpMarketLpPoolFeeTransferScalar(
			lpFeeTransferScalar ?? null,
			lpExchangeFeeExcluscionScalar ?? null,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketAccount.pubkey,
				},
			}
		);
	}

	/**
	 * Sets a perp market's `hedgeConfig.pausedOperations` bitmask
	 * (`ConstituentLpOperation`: `Swap`/`Deposit`/`Withdraw`), pausing that market's
	 * side of LP-pool hedge flow. Reachable by cold, warm, or `pauseAdmin`
	 * (`PauseAdminUpdatePerpMarket`'s `check_pause`), with the same bit-add-only
	 * restriction for a pause-admin-only caller as `updateExchangeStatus`. The
	 * `admin` account below defaults to `coldAdmin`; other roles must override it.
	 * @param marketIndex - Perp market to update.
	 * @param pausedOperations - New pause bitmask, `ConstituentLpOperation` bit values.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketLpPoolPausedOperations(
		marketIndex: number,
		pausedOperations: number
	) {
		const ix = await this.getUpdatePerpMarketLpPoolPausedOperationsIx(
			marketIndex,
			pausedOperations
		);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketLpPoolPausedOperations` instruction without
	 * sending it. See `updatePerpMarketLpPoolPausedOperations`.
	 * @returns The unsigned `updatePerpMarketLpPoolPausedOperations` instruction.
	 */
	public async getUpdatePerpMarketLpPoolPausedOperationsIx(
		marketIndex: number,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(marketIndex);
		return this.program.instruction.updatePerpMarketLpPoolPausedOperations(
			pausedOperations,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().coldAdmin,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketAccount.pubkey,
				},
			}
		);
	}

	/**
	 * Mints `1000` units of an LP pool's `whitelistMint` to `authority`'s associated
	 * token account, creating the ATA if needed. This is a plain SPL-token mint, not
	 * a velocity program instruction — no `HotRole`/tier gate applies; instead the
	 * token program itself requires `this.wallet` to be the mint's authority (set
	 * whenever the whitelist mint was created — typically the same admin that called
	 * `initializeLpPool`/`updateLpPoolParams` to configure it). Holding units of the
	 * whitelist mint is what gates `authority`'s ability to mint/redeem this pool's LP
	 * token, if `lpPool.whitelistMint` is set to a non-default pubkey.
	 * @param lpPool - LP pool whose `whitelistMint` to mint from.
	 * @param authority - Wallet to receive the whitelist tokens.
	 * @returns Transaction signature.
	 */
	public async mintLpWhitelistToken(
		lpPool: LPPoolAccount,
		authority: PublicKey
	): Promise<TransactionSignature> {
		const ix = await this.getMintLpWhitelistTokenIx(lpPool, authority);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the ATA-creation and `mintTo` instructions without sending them. See
	 * `mintLpWhitelistToken`.
	 * @returns The unsigned instructions: idempotent ATA creation, then mint-to, in order.
	 */
	public async getMintLpWhitelistTokenIx(
		lpPool: LPPoolAccount,
		authority: PublicKey
	): Promise<TransactionInstruction[]> {
		const mintAmount = 1000;
		const associatedTokenAccount = getAssociatedTokenAddressSync(
			lpPool.whitelistMint,
			authority,
			false
		);

		const ixs: TransactionInstruction[] = [];
		const createInstruction =
			this.createAssociatedTokenAccountIdempotentInstruction(
				associatedTokenAccount,
				this.wallet.publicKey,
				authority,
				lpPool.whitelistMint
			);
		ixs.push(createInstruction);
		const mintToInstruction = createMintToInstruction(
			lpPool.whitelistMint,
			associatedTokenAccount,
			this.wallet.publicKey,
			mintAmount,
			[],
			TOKEN_PROGRAM_ID
		);
		ixs.push(mintToInstruction);
		return ixs;
	}

	/**
	 * Sets a perp market's `marketConfig` bitmask (currently one bit:
	 * `MarketConfigFlag.DisableFormulaicKUpdate`, which turns off the AMM's automatic
	 * k-adjustment for the market). Requires warm admin (the `HotAdminUpdatePerpMarket`
	 * context's `check_warm` constraint), but **setting any bit (a non-zero value)
	 * requires `state.coldAdmin` specifically** — a warm-only signer may only pass `0`
	 * (clear all bits). Unknown bits are rejected (`InvalidPerpMarketConfig`).
	 * @param marketIndex - Perp market to update.
	 * @param marketConfig - New bitmask; non-zero values require cold admin.
	 * @returns Transaction signature.
	 */
	public async updatePerpMarketConfig(
		marketIndex: number,
		marketConfig: number
	) {
		const ix = await this.getUpdatePerpMarketConfigIx(
			marketIndex,
			marketConfig
		);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `updatePerpMarketConfig` instruction without sending it. See
	 * `updatePerpMarketConfig`.
	 * @returns The unsigned `updatePerpMarketConfig` instruction.
	 */
	public async getUpdatePerpMarketConfigIx(
		marketIndex: number,
		marketConfig: number
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(marketIndex);
		return this.program.instruction.updatePerpMarketConfig(marketConfig, {
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketAccount.pubkey,
			},
		});
	}

	/**
	 * Moves quote value between one perp market's protocol fee pool and another (or
	 * the same) perp market's pnl pool — a pure internal ledger transfer against the
	 * shared quote spot market's scaled balances, no tokens actually move. Requires
	 * warm admin (`check_warm`). On-chain, the transfer is capped at the source
	 * pool's available token amount. For a same-market move the AMM's
	 * `totalFeeMinusDistributions` ledger is left untouched (equity-neutral within
	 * one market's perimeter); for a cross-market move, the fee-pool market's ledger
	 * is adjusted to reflect quote leaving/entering its perimeter (reconciled later
	 * by the summary-stats recompute ix).
	 * @param perpMarketIndexWithFeePool - Perp market whose fee pool is the transfer source/destination.
	 * @param perpMarketIndexWithPnlPool - Perp market whose pnl pool is the transfer destination/source.
	 * @param amount - Amount to move, QUOTE_PRECISION (1e6) (clamped down to the source pool's available balance on-chain).
	 * @param direction - `TransferFeeAndPnlPoolDirection.FEE_TO_PNL_POOL` or `.PNL_TO_FEE_POOL`.
	 * @returns Transaction signature.
	 */
	public async transferFeeAndPnlPool(
		perpMarketIndexWithFeePool: number,
		perpMarketIndexWithPnlPool: number,
		amount: BN,
		direction: TransferFeeAndPnlPoolDirection
	): Promise<TransactionSignature> {
		const transferFeeAndPnlPoolIx = await this.getTransferFeeAndPnlPoolIx(
			perpMarketIndexWithFeePool,
			perpMarketIndexWithPnlPool,
			amount,
			direction
		);
		const tx = await this.buildTransaction(transferFeeAndPnlPoolIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `transferFeeAndPnlPool` instruction without sending it. See
	 * `transferFeeAndPnlPool`.
	 * @returns The unsigned `transferFeeAndPnlPool` instruction.
	 */
	public async getTransferFeeAndPnlPoolIx(
		perpMarketIndexWithFeePool: number,
		perpMarketIndexWithPnlPool: number,
		amount: BN,
		direction: TransferFeeAndPnlPoolDirection
	): Promise<TransactionInstruction> {
		return await this.program.instruction.transferFeeAndPnlPool(
			amount,
			direction,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarketWithFeePool: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndexWithFeePool
					),
					perpMarketWithPnlPool: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndexWithPnlPool
					),
					spotMarket: this.getQuoteSpotMarketAccount().pubkey,
					spotMarketVault: this.getQuoteSpotMarketAccount().vault,
				},
			}
		);
	}

	/**
	 * Sets a `User` account's `specialUserStatus` bitmask (`SpecialUserStatus`;
	 * currently one bit, `VAMM_HEDGER`, marking the account the protocol's own
	 * vAMM-hedging bot trades from). Requires `HotRole.UserFlag` (cold, warm, or the
	 * configured user-flag hot key), but **setting any bit (a non-zero value)
	 * requires `state.coldAdmin` specifically** — a `UserFlag`-hot-only signer may
	 * only pass `0` (clear all bits). Unknown bits are rejected (`DefaultError`).
	 * @param userAccountPublicKey - `User` PDA to update.
	 * @param status - New bitmask; non-zero values require cold admin.
	 * @param txParams - Optional transaction-building overrides.
	 * @returns Transaction signature.
	 */
	public async updateSpecialUserStatus(
		userAccountPublicKey: PublicKey,
		status: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getUpdateSpecialUserStatusIx(
			userAccountPublicKey,
			status
		);
		const tx = await this.buildTransaction(ix, txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `updateSpecialUserStatus` instruction without sending it. See
	 * `updateSpecialUserStatus`.
	 * @returns The unsigned `updateSpecialUserStatus` instruction.
	 */
	public async getUpdateSpecialUserStatusIx(
		userAccountPublicKey: PublicKey,
		status: number
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateSpecialUserStatus(status, {
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().coldAdmin,
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
			},
		});
	}

	// ----- Tiered admin authority -----
	//
	// `state.coldAdmin` is the root. `state.warmAdmin` is rotated by cold; each
	// `state.hot*` field is rotated by warm (or cold). COLD ⊇ WARM ⊇ HOT(role).
	// `handleInitialize` seeds `coldAdmin = warmAdmin = signer`; there is no
	// separate "initialize admin authority config" ix.

	/**
	 * Rotates `state.warmAdmin`, the operational (multisig+timelock) tier that can
	 * rotate every hot-role key (`updateHotAdmin`). Cold-only: the `UpdateWarmAdmin`
	 * context requires `state.coldAdmin == admin.key()`.
	 * @param newWarmAdmin - New warm admin pubkey. `PublicKey.default()` unsets the role — only `coldAdmin` can then act where warm was accepted.
	 * @returns Transaction signature.
	 */
	public async updateWarmAdmin(
		newWarmAdmin: PublicKey
	): Promise<TransactionSignature> {
		const ix = await this.getUpdateWarmAdminIx(newWarmAdmin);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `updateWarmAdmin` instruction without sending it. See
	 * `updateWarmAdmin`.
	 * @returns The unsigned `updateWarmAdmin` instruction.
	 */
	public async getUpdateWarmAdminIx(
		newWarmAdmin: PublicKey
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateWarmAdmin(newWarmAdmin, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
			},
		});
	}

	/**
	 * Rotates `state.pauseAdmin`, the no-timelock emergency-pause key authorised (in
	 * addition to cold/warm) for handlers that flip pause bitmasks
	 * (`updateExchangeStatus`, per-market/per-user paused-operations updates) —
	 * restricted at the handler level to *adding* pause bits, never clearing them.
	 * Cold-only: the `UpdatePauseAdmin` context requires `state.coldAdmin ==
	 * admin.key()`.
	 * @param newPauseAdmin - New pause admin pubkey. `PublicKey.default()` unsets the role — only cold/warm can then pause.
	 * @returns Transaction signature.
	 */
	public async updatePauseAdmin(
		newPauseAdmin: PublicKey
	): Promise<TransactionSignature> {
		const ix = await this.getUpdatePauseAdminIx(newPauseAdmin);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `updatePauseAdmin` instruction without sending it. See
	 * `updatePauseAdmin`.
	 * @returns The unsigned `updatePauseAdmin` instruction.
	 */
	public async getUpdatePauseAdminIx(
		newPauseAdmin: PublicKey
	): Promise<TransactionInstruction> {
		return this.program.instruction.updatePauseAdmin(newPauseAdmin, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
			},
		});
	}

	/**
	 * Rotates one purpose-specific hot-role key on `state` (e.g. `hotFeeWithdraw`,
	 * `hotVaultDeposit`). Warm-or-cold: the `UpdateHotAdmin` context requires
	 * `state.isWarm(admin.key())`. Compromise of one hot key only exposes the
	 * instructions gated on that specific `HotRole` — rotating it here fully revokes
	 * the old key for that role.
	 * @param role - Which hot role's key to rotate.
	 * @param newPubkey - New key for that role. `PublicKey.default()` unsets it — only warm/cold can then call handlers gated on that role.
	 * @returns Transaction signature.
	 */
	public async updateHotAdmin(
		role: HotRole,
		newPubkey: PublicKey
	): Promise<TransactionSignature> {
		const ix = await this.getUpdateHotAdminIx(role, newPubkey);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `updateHotAdmin` instruction without sending it. See
	 * `updateHotAdmin`.
	 * @returns The unsigned `updateHotAdmin` instruction.
	 */
	public async getUpdateHotAdminIx(
		role: HotRole,
		newPubkey: PublicKey
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateHotAdmin(
			encodeHotRole(role),
			newPubkey,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
				},
			}
		);
	}
}

/**
 * Hot-admin role identifier. Each role is a separate purpose-specific signer key
 * stored directly on the `State` account (one `hot*` pubkey field per role, e.g.
 * `state.hotFeeWithdraw` for `FeeWithdraw`) — there is no separate
 * "AdminAuthorityConfig" account. Compromise of one role's key only enables that
 * role's instructions (see `updateHotAdmin` to rotate one).
 */
export enum HotRole {
	AmmCrank = 'ammCrank',
	LpCache = 'lpCache',
	LpSwap = 'lpSwap',
	LpSettle = 'lpSettle',
	FeatureFlag = 'featureFlag',
	Fuel = 'fuel',
	UserFlag = 'userFlag',
	VaultDeposit = 'vaultDeposit',
	MmOracleCrank = 'mmOracleCrank',
	AmmSpreadAdjust = 'ammSpreadAdjust',
	FeeWithdraw = 'feeWithdraw',
}

/** Anchor encodes Rust enums as `{ <variant>: {} }`. */
function encodeHotRole(role: HotRole): { [k: string]: Record<string, never> } {
	return { [role]: {} };
}
