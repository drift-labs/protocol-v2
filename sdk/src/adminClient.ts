import {
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
	MarketStatus,
	ContractTier,
	AssetTier,
	SpotFulfillmentConfigStatus,
} from './types';
import { DEFAULT_MARKET_NAME, encodeName } from './userName';
import { BN } from '@coral-xyz/anchor';
import * as anchor from '@coral-xyz/anchor';
import {
	getDriftStateAccountPublicKeyAndNonce,
	getSpotMarketPublicKey,
	getSpotMarketVaultPublicKey,
	getPerpMarketPublicKey,
	getInsuranceFundVaultPublicKey,
	getSerumOpenOrdersPublicKey,
	getSerumFulfillmentConfigPublicKey,
	getPhoenixFulfillmentConfigPublicKey,
	getProtocolIfSharesTransferConfigPublicKey,
	getPrelaunchOraclePublicKey,
	getOpenbookV2FulfillmentConfigPublicKey,
	getPythPullOraclePublicKey,
	getUserStatsAccountPublicKey,
	getHighLeverageModeConfigPublicKey,
	getPythLazerOraclePublicKey,
	getProtectedMakerModeConfigPublicKey,
} from './addresses/pda';
import { squareRootBN } from './math/utils';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DriftClient } from './driftClient';
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
import { PROGRAM_ID as PHOENIX_PROGRAM_ID } from '@ellipsis-labs/phoenix-sdk';
import { DRIFT_ORACLE_RECEIVER_ID } from './config';
import { getFeedIdUint8Array } from './util/pythOracleUtils';

const OPENBOOK_PROGRAM_ID = new PublicKey(
	'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb'
);

export class AdminClient extends DriftClient {
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

		const [driftStatePublicKey] = await getDriftStateAccountPublicKeyAndNonce(
			this.program.programId
		);

		const initializeIx = await this.program.instruction.initialize({
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: driftStatePublicKey,
				quoteAssetMint: usdcMint,
				rent: SYSVAR_RENT_PUBKEY,
				driftSigner: this.getSignerPublicKey(),
				systemProgram: anchor.web3.SystemProgram.programId,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});

		const tx = await this.buildTransaction(initializeIx);

		const { txSig } = await super.sendTransaction(tx, [], this.opts);

		return [txSig];
	}

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

		const tokenProgram = (await this.connection.getAccountInfo(mint)).owner;

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
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket,
					spotMarketVault,
					insuranceFundVault,
					driftSigner: this.getSignerPublicKey(),
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

	public async deleteInitializedSpotMarket(
		marketIndex: number
	): Promise<TransactionSignature> {
		const deleteInitializeMarketIx =
			await this.getDeleteInitializedSpotMarketIx(marketIndex);

		const tx = await this.buildTransaction(deleteInitializeMarketIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

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
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					spotMarket: spotMarketPublicKey,
					spotMarketVault: spotMarketVaultPublicKey,
					insuranceFundVault: insuranceFundVaultPublicKey,
					driftSigner: this.getSignerPublicKey(),
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);
	}

	public async initializeSerumFulfillmentConfig(
		marketIndex: number,
		serumMarket: PublicKey,
		serumProgram: PublicKey
	): Promise<TransactionSignature> {
		const initializeIx = await this.getInitializeSerumFulfillmentConfigIx(
			marketIndex,
			serumMarket,
			serumProgram
		);

		const tx = await this.buildTransaction(initializeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializeSerumFulfillmentConfigIx(
		marketIndex: number,
		serumMarket: PublicKey,
		serumProgram: PublicKey
	): Promise<TransactionInstruction> {
		const serumOpenOrders = getSerumOpenOrdersPublicKey(
			this.program.programId,
			serumMarket
		);

		const serumFulfillmentConfig = getSerumFulfillmentConfigPublicKey(
			this.program.programId,
			serumMarket
		);

		return await this.program.instruction.initializeSerumFulfillmentConfig(
			marketIndex,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					baseSpotMarket: this.getSpotMarketAccount(marketIndex).pubkey,
					quoteSpotMarket: this.getQuoteSpotMarketAccount().pubkey,
					driftSigner: this.getSignerPublicKey(),
					serumProgram,
					serumMarket,
					serumOpenOrders,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					serumFulfillmentConfig,
				},
			}
		);
	}

	public async initializePhoenixFulfillmentConfig(
		marketIndex: number,
		phoenixMarket: PublicKey
	): Promise<TransactionSignature> {
		const initializeIx = await this.getInitializePhoenixFulfillmentConfigIx(
			marketIndex,
			phoenixMarket
		);

		const tx = await this.buildTransaction(initializeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializePhoenixFulfillmentConfigIx(
		marketIndex: number,
		phoenixMarket: PublicKey
	): Promise<TransactionInstruction> {
		const phoenixFulfillmentConfig = getPhoenixFulfillmentConfigPublicKey(
			this.program.programId,
			phoenixMarket
		);

		return await this.program.instruction.initializePhoenixFulfillmentConfig(
			marketIndex,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					baseSpotMarket: this.getSpotMarketAccount(marketIndex).pubkey,
					quoteSpotMarket: this.getQuoteSpotMarketAccount().pubkey,
					driftSigner: this.getSignerPublicKey(),
					phoenixMarket: phoenixMarket,
					phoenixProgram: PHOENIX_PROGRAM_ID,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					phoenixFulfillmentConfig,
				},
			}
		);
	}

	public async initializeOpenbookV2FulfillmentConfig(
		marketIndex: number,
		openbookMarket: PublicKey
	): Promise<TransactionSignature> {
		const initializeIx = await this.getInitializeOpenbookV2FulfillmentConfigIx(
			marketIndex,
			openbookMarket
		);

		const tx = await this.buildTransaction(initializeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializeOpenbookV2FulfillmentConfigIx(
		marketIndex: number,
		openbookMarket: PublicKey
	): Promise<TransactionInstruction> {
		const openbookFulfillmentConfig = getOpenbookV2FulfillmentConfigPublicKey(
			this.program.programId,
			openbookMarket
		);

		return this.program.instruction.initializeOpenbookV2FulfillmentConfig(
			marketIndex,
			{
				accounts: {
					baseSpotMarket: this.getSpotMarketAccount(marketIndex).pubkey,
					quoteSpotMarket: this.getQuoteSpotMarketAccount().pubkey,
					state: await this.getStatePublicKey(),
					openbookV2Program: OPENBOOK_PROGRAM_ID,
					openbookV2Market: openbookMarket,
					driftSigner: this.getSignerPublicKey(),
					openbookV2FulfillmentConfig: openbookFulfillmentConfig,
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
				},
			}
		);
	}

	public async initializePerpMarket(
		marketIndex: number,
		priceOracle: PublicKey,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_PRECISION,
		oracleSource: OracleSource = OracleSource.PYTH,
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
		name = DEFAULT_MARKET_NAME
	): Promise<TransactionSignature> {
		const currentPerpMarketIndex = this.getStateAccount().numberOfMarkets;

		const initializeMarketIx = await this.getInitializePerpMarketIx(
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
			name
		);
		const tx = await this.buildTransaction(initializeMarketIx);

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

	public async getInitializePerpMarketIx(
		marketIndex: number,
		priceOracle: PublicKey,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_PRECISION,
		oracleSource: OracleSource = OracleSource.PYTH,
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
		name = DEFAULT_MARKET_NAME
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		const nameBuffer = encodeName(name);
		return await this.program.instruction.initializePerpMarket(
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
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					oracle: priceOracle,
					perpMarket: perpMarketPublicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
				},
			}
		);
	}

	public async initializePredictionMarket(
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const updatePerpMarketConcentrationCoefIx =
			await this.getInitializePredictionMarketIx(perpMarketIndex);

		const tx = await this.buildTransaction(updatePerpMarketConcentrationCoefIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializePredictionMarketIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.initializePredictionMarket({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async deleteInitializedPerpMarket(
		marketIndex: number
	): Promise<TransactionSignature> {
		const deleteInitializeMarketIx =
			await this.getDeleteInitializedPerpMarketIx(marketIndex);

		const tx = await this.buildTransaction(deleteInitializeMarketIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

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
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

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
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					perpMarket: marketPublicKey,
				},
			}
		);
	}

	public async updateK(
		perpMarketIndex: number,
		sqrtK: BN
	): Promise<TransactionSignature> {
		const updateKIx = await this.getUpdateKIx(perpMarketIndex, sqrtK);

		const tx = await this.buildTransaction(updateKIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateKIx(
		perpMarketIndex: number,
		sqrtK: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateK(sqrtK, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
				oracle: this.getPerpMarketAccount(perpMarketIndex).amm.oracle,
			},
		});
	}

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
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					perpMarket: marketPublicKey,
				},
			}
		);
	}

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
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

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

	public async getMoveAmmToPriceIx(
		perpMarketIndex: number,
		targetPrice: BN
	): Promise<TransactionInstruction> {
		const perpMarket = this.getPerpMarketAccount(perpMarketIndex);

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
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

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

	public async getRepegAmmCurveIx(
		newPeg: BN,
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);
		const ammData = this.getPerpMarketAccount(perpMarketIndex).amm;

		return await this.program.instruction.repegAmmCurve(newPeg, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				oracle: ammData.oracle,
				perpMarket: perpMarketPublicKey,
			},
		});
	}

	public async updatePerpMarketAmmOracleTwap(
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const updatePerpMarketAmmOracleTwapIx =
			await this.getUpdatePerpMarketAmmOracleTwapIx(perpMarketIndex);

		const tx = await this.buildTransaction(updatePerpMarketAmmOracleTwapIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpMarketAmmOracleTwapIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const ammData = this.getPerpMarketAccount(perpMarketIndex).amm;
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				oracle: ammData.oracle,
				perpMarket: perpMarketPublicKey,
			},
		});
	}

	public async resetPerpMarketAmmOracleTwap(
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const resetPerpMarketAmmOracleTwapIx =
			await this.getResetPerpMarketAmmOracleTwapIx(perpMarketIndex);

		const tx = await this.buildTransaction(resetPerpMarketAmmOracleTwapIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getResetPerpMarketAmmOracleTwapIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const ammData = this.getPerpMarketAccount(perpMarketIndex).amm;
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.resetPerpMarketAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				oracle: ammData.oracle,
				perpMarket: perpMarketPublicKey,
			},
		});
	}

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

	public async getDepositIntoPerpMarketFeePoolIx(
		perpMarketIndex: number,
		amount: BN,
		sourceVault: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarket = this.getQuoteSpotMarketAccount();

		return await this.program.instruction.depositIntoPerpMarketFeePool(amount, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
				sourceVault,
				driftSigner: this.getSignerPublicKey(),
				quoteSpotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

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

	public async getDepositIntoSpotMarketVaultIx(
		spotMarketIndex: number,
		amount: BN,
		sourceVault: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccount(spotMarketIndex);

		const remainingAccounts = [];
		this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);
		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarket);
		return await this.program.instruction.depositIntoSpotMarketVault(amount, {
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().admin,
				state: await this.getStatePublicKey(),
				sourceVault,
				spotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
				tokenProgram,
			},
			remainingAccounts,
		});
	}

	public async updateAdmin(admin: PublicKey): Promise<TransactionSignature> {
		const updateAdminIx = await this.getUpdateAdminIx(admin);

		const tx = await this.buildTransaction(updateAdminIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateAdminIx(
		admin: PublicKey
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateAdmin(admin, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

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

	public async getUpdatePerpMarketCurveUpdateIntensityIx(
		perpMarketIndex: number,
		curveUpdateIntensity: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketCurveUpdateIntensity(
			curveUpdateIntensity,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async updatePerpMarketAmmSummaryStats(
		perpMarketIndex: number,
		updateAmmSummaryStats?: boolean,
		quoteAssetAmountWithUnsettledLp?: BN,
		netUnsettledFundingPnl?: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketMarginRatioIx =
			await this.getUpdatePerpMarketAmmSummaryStatsIx(
				perpMarketIndex,
				updateAmmSummaryStats,
				quoteAssetAmountWithUnsettledLp,
				netUnsettledFundingPnl
			);

		const tx = await this.buildTransaction(updatePerpMarketMarginRatioIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpMarketAmmSummaryStatsIx(
		perpMarketIndex: number,
		updateAmmSummaryStats?: boolean,
		quoteAssetAmountWithUnsettledLp?: BN,
		netUnsettledFundingPnl?: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketAmmSummaryStats(
			{
				updateAmmSummaryStats: updateAmmSummaryStats ?? null,
				quoteAssetAmountWithUnsettledLp:
					quoteAssetAmountWithUnsettledLp ?? null,
				netUnsettledFundingPnl: netUnsettledFundingPnl ?? null,
			},
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						QUOTE_SPOT_MARKET_INDEX
					),
					oracle: this.getPerpMarketAccount(perpMarketIndex).amm.oracle,
				},
			}
		);
	}

	public async getUpdatePerpMarketTargetBaseAssetAmountPerLpIx(
		perpMarketIndex: number,
		targetBaseAssetAmountPerLP: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketTargetBaseAssetAmountPerLp(
			targetBaseAssetAmountPerLP,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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
						? this.getStateAccount().admin
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

	public async updatePerpMarketHighLeverageMarginRatio(
		perpMarketIndex: number,
		marginRatioInitial: number,
		marginRatioMaintenance: number
	): Promise<TransactionSignature> {
		const updatePerpMarketHighLeverageMarginRatioIx =
			await this.getUpdatePerpMarketHighLeverageMarginRatioIx(
				perpMarketIndex,
				marginRatioInitial,
				marginRatioMaintenance
			);

		const tx = await this.buildTransaction(
			updatePerpMarketHighLeverageMarginRatioIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpMarketHighLeverageMarginRatioIx(
		perpMarketIndex: number,
		marginRatioInitial: number,
		marginRatioMaintenance: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketHighLeverageMarginRatio(
			marginRatioInitial,
			marginRatioMaintenance,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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
						? this.getStateAccount().admin
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

	public async getUpdatePerpMarketBaseSpreadIx(
		perpMarketIndex: number,
		baseSpread: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketBaseSpread(
			baseSpread,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateAmmJitIntensityIx(
		perpMarketIndex: number,
		ammJitIntensity: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateAmmJitIntensity(
			ammJitIntensity,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdatePerpMarketNameIx(
		perpMarketIndex: number,
		name: string
	): Promise<TransactionInstruction> {
		const nameBuffer = encodeName(name);
		return await this.program.instruction.updatePerpMarketName(nameBuffer, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

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

	public async getUpdateSpotMarketNameIx(
		spotMarketIndex: number,
		name: string
	): Promise<TransactionInstruction> {
		const nameBuffer = encodeName(name);
		return await this.program.instruction.updateSpotMarketName(nameBuffer, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

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

	public async getUpdateSpotMarketPoolIdIx(
		spotMarketIndex: number,
		poolId: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketPoolId(poolId, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

	public async updatePerpMarketPerLpBase(
		perpMarketIndex: number,
		perLpBase: number
	): Promise<TransactionSignature> {
		const updatePerpMarketPerLpBaseIx =
			await this.getUpdatePerpMarketPerLpBaseIx(perpMarketIndex, perLpBase);

		const tx = await this.buildTransaction(updatePerpMarketPerLpBaseIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpMarketPerLpBaseIx(
		perpMarketIndex: number,
		perLpBase: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketPerLpBase(perLpBase, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
			},
		});
	}

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
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
			},
		});
	}

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

	public async getUpdatePerpFeeStructureIx(
		feeStructure: FeeStructure
	): Promise<TransactionInstruction> {
		return this.program.instruction.updatePerpFeeStructure(feeStructure, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

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

	public async getUpdateSpotFeeStructureIx(
		feeStructure: FeeStructure
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotFeeStructure(feeStructure, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateInitialPctToLiquidate(
		initialPctToLiquidate: number
	): Promise<TransactionSignature> {
		const updateInitialPctToLiquidateIx =
			await this.getUpdateInitialPctToLiquidateIx(initialPctToLiquidate);

		const tx = await this.buildTransaction(updateInitialPctToLiquidateIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateInitialPctToLiquidateIx(
		initialPctToLiquidate: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateInitialPctToLiquidate(
			initialPctToLiquidate,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateLiquidationDuration(
		liquidationDuration: number
	): Promise<TransactionSignature> {
		const updateLiquidationDurationIx =
			await this.getUpdateLiquidationDurationIx(liquidationDuration);

		const tx = await this.buildTransaction(updateLiquidationDurationIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateLiquidationDurationIx(
		liquidationDuration: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateLiquidationDuration(
			liquidationDuration,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

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

	public async getUpdateLiquidationMarginBufferRatioIx(
		updateLiquidationMarginBufferRatio: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateLiquidationMarginBufferRatio(
			updateLiquidationMarginBufferRatio,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

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

	public async getUpdateOracleGuardRailsIx(
		oracleGuardRails: OracleGuardRails
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateOracleGuardRails(
			oracleGuardRails,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateStateSettlementDuration(
		settlementDuration: number
	): Promise<TransactionSignature> {
		const updateStateSettlementDurationIx =
			await this.getUpdateStateSettlementDurationIx(settlementDuration);

		const tx = await this.buildTransaction(updateStateSettlementDurationIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateStateSettlementDurationIx(
		settlementDuration: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateStateSettlementDuration(
			settlementDuration,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateStateMaxNumberOfSubAccounts(
		maxNumberOfSubAccounts: number
	): Promise<TransactionSignature> {
		const updateStateMaxNumberOfSubAccountsIx =
			await this.getUpdateStateMaxNumberOfSubAccountsIx(maxNumberOfSubAccounts);

		const tx = await this.buildTransaction(updateStateMaxNumberOfSubAccountsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateStateMaxNumberOfSubAccountsIx(
		maxNumberOfSubAccounts: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateStateMaxNumberOfSubAccounts(
			maxNumberOfSubAccounts,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateStateMaxInitializeUserFee(
		maxInitializeUserFee: number
	): Promise<TransactionSignature> {
		const updateStateMaxInitializeUserFeeIx =
			await this.getUpdateStateMaxInitializeUserFeeIx(maxInitializeUserFee);

		const tx = await this.buildTransaction(updateStateMaxInitializeUserFeeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateStateMaxInitializeUserFeeIx(
		maxInitializeUserFee: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateStateMaxInitializeUserFee(
			maxInitializeUserFee,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateWithdrawGuardThreshold(
		spotMarketIndex: number,
		withdrawGuardThreshold: BN
	): Promise<TransactionSignature> {
		const updateWithdrawGuardThresholdIx =
			await this.getUpdateWithdrawGuardThresholdIx(
				spotMarketIndex,
				withdrawGuardThreshold
			);

		const tx = await this.buildTransaction(updateWithdrawGuardThresholdIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateWithdrawGuardThresholdIx(
		spotMarketIndex: number,
		withdrawGuardThreshold: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateWithdrawGuardThreshold(
			withdrawGuardThreshold,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async updateSpotMarketIfFactor(
		spotMarketIndex: number,
		userIfFactor: BN,
		totalIfFactor: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketIfFactorIx = await this.getUpdateSpotMarketIfFactorIx(
			spotMarketIndex,
			userIfFactor,
			totalIfFactor
		);

		const tx = await this.buildTransaction(updateSpotMarketIfFactorIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateSpotMarketIfFactorIx(
		spotMarketIndex: number,
		userIfFactor: BN,
		totalIfFactor: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketIfFactor(
			spotMarketIndex,
			userIfFactor,
			totalIfFactor,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateSpotMarketRevenueSettlePeriodIx(
		spotMarketIndex: number,
		revenueSettlePeriod: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketRevenueSettlePeriod(
			revenueSettlePeriod,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateSpotMarketMaxTokenDepositsIx(
		spotMarketIndex: number,
		maxTokenDeposits: BN
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateSpotMarketMaxTokenDeposits(
			maxTokenDeposits,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateSpotMarketMaxTokenBorrowsIx(
		spotMarketIndex: number,
		maxTokenBorrowsFraction: number
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateSpotMarketMaxTokenBorrows(
			maxTokenBorrowsFraction,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateSpotMarketScaleInitialAssetWeightStartIx(
		spotMarketIndex: number,
		scaleInitialAssetWeightStart: BN
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateSpotMarketScaleInitialAssetWeightStart(
			scaleInitialAssetWeightStart,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateInsuranceFundUnstakingPeriodIx(
		spotMarketIndex: number,
		insuranceWithdrawEscrowPeriod: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateInsuranceFundUnstakingPeriod(
			insuranceWithdrawEscrowPeriod,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async updateLpCooldownTime(
		cooldownTime: BN
	): Promise<TransactionSignature> {
		const updateLpCooldownTimeIx = await this.getUpdateLpCooldownTimeIx(
			cooldownTime
		);

		const tx = await this.buildTransaction(updateLpCooldownTimeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateLpCooldownTimeIx(
		cooldownTime: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateLpCooldownTime(cooldownTime, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updatePerpMarketOracle(
		perpMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource
	): Promise<TransactionSignature> {
		const updatePerpMarketOracleIx = await this.getUpdatePerpMarketOracleIx(
			perpMarketIndex,
			oracle,
			oracleSource
		);

		const tx = await this.buildTransaction(updatePerpMarketOracleIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpMarketOracleIx(
		perpMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketOracle(
			oracle,
			oracleSource,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
					oracle: oracle,
				},
			}
		);
	}

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
						? this.getStateAccount().admin
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

	public async getUpdatePerpMarketMinOrderSizeIx(
		perpMarketIndex: number,
		orderSize: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketMinOrderSize(
			orderSize,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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
						? this.getStateAccount().admin
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

	public async updateSpotMarketMinOrderSize(
		spotMarketIndex: number,
		orderSize: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketMinOrderSizeIx =
			await this.program.instruction.updateSpotMarketMinOrderSize(orderSize, {
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateSpotMarketMinOrderSizeIx(
		spotMarketIndex: number,
		orderSize: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketMinOrderSize(
			orderSize,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdatePerpMarketExpiryIx(
		perpMarketIndex: number,
		expiryTs: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketExpiry(expiryTs, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async updateSpotMarketOracle(
		spotMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource
	): Promise<TransactionSignature> {
		const updateSpotMarketOracleIx = await this.getUpdateSpotMarketOracleIx(
			spotMarketIndex,
			oracle,
			oracleSource
		);

		const tx = await this.buildTransaction(updateSpotMarketOracleIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateSpotMarketOracleIx(
		spotMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketOracle(
			oracle,
			oracleSource,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
					oracle: oracle,
				},
			}
		);
	}

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

	public async getUpdateSpotMarketOrdersEnabledIx(
		spotMarketIndex: number,
		ordersEnabled: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketOrdersEnabled(
			ordersEnabled,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateSpotMarketIfPausedOperationsIx(
		spotMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketIfPausedOperations(
			pausedOperations,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async updateSerumFulfillmentConfigStatus(
		serumFulfillmentConfig: PublicKey,
		status: SpotFulfillmentConfigStatus
	): Promise<TransactionSignature> {
		const updateSerumFulfillmentConfigStatusIx =
			await this.getUpdateSerumFulfillmentConfigStatusIx(
				serumFulfillmentConfig,
				status
			);

		const tx = await this.buildTransaction(
			updateSerumFulfillmentConfigStatusIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateSerumFulfillmentConfigStatusIx(
		serumFulfillmentConfig: PublicKey,
		status: SpotFulfillmentConfigStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSerumFulfillmentConfigStatus(
			status,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					serumFulfillmentConfig,
				},
			}
		);
	}

	public async updatePhoenixFulfillmentConfigStatus(
		phoenixFulfillmentConfig: PublicKey,
		status: SpotFulfillmentConfigStatus
	): Promise<TransactionSignature> {
		const updatePhoenixFulfillmentConfigStatusIx =
			await this.program.instruction.phoenixFulfillmentConfigStatus(status, {
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					phoenixFulfillmentConfig,
				},
			});

		const tx = await this.buildTransaction(
			updatePhoenixFulfillmentConfigStatusIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePhoenixFulfillmentConfigStatusIx(
		phoenixFulfillmentConfig: PublicKey,
		status: SpotFulfillmentConfigStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.phoenixFulfillmentConfigStatus(
			status,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					phoenixFulfillmentConfig,
				},
			}
		);
	}

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

	public async getUpdateSpotMarketExpiryIx(
		spotMarketIndex: number,
		expiryTs: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketExpiry(expiryTs, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

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

	public async getUpdateWhitelistMintIx(
		whitelistMint?: PublicKey
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateWhitelistMint(whitelistMint, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

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

	public async getUpdateDiscountMintIx(
		discountMint: PublicKey
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateDiscountMint(discountMint, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

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
						? this.getStateAccount().admin
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
						? this.getStateAccount().admin
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

	public async getUpdateSpotMarketAssetTierIx(
		spotMarketIndex: number,
		assetTier: AssetTier
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketAssetTier(assetTier, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

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

	public async getUpdateSpotMarketStatusIx(
		spotMarketIndex: number,
		marketStatus: MarketStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketStatus(marketStatus, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

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

	public async getUpdateSpotMarketPausedOperationsIx(
		spotMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketPausedOperations(
			pausedOperations,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdatePerpMarketStatusIx(
		perpMarketIndex: number,
		marketStatus: MarketStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketStatus(marketStatus, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

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

	public async getUpdatePerpMarketPausedOperationsIx(
		perpMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketPausedOperations(
			pausedOperations,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdatePerpMarketContractTierIx(
		perpMarketIndex: number,
		contractTier: ContractTier
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketContractTier(
			contractTier,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateExchangeStatusIx(
		exchangeStatus: ExchangeStatus
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateExchangeStatus(exchangeStatus, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updatePerpAuctionDuration(
		minDuration: BN | number
	): Promise<TransactionSignature> {
		const updatePerpAuctionDurationIx =
			await this.getUpdatePerpAuctionDurationIx(minDuration);

		const tx = await this.buildTransaction(updatePerpAuctionDurationIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpAuctionDurationIx(
		minDuration: BN | number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpAuctionDuration(
			typeof minDuration === 'number' ? minDuration : minDuration.toNumber(),
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateSpotAuctionDuration(
		defaultAuctionDuration: number
	): Promise<TransactionSignature> {
		const updateSpotAuctionDurationIx =
			await this.getUpdateSpotAuctionDurationIx(defaultAuctionDuration);

		const tx = await this.buildTransaction(updateSpotAuctionDurationIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateSpotAuctionDurationIx(
		defaultAuctionDuration: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotAuctionDuration(
			defaultAuctionDuration,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

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

	public async getUpdatePerpMarketMaxFillReserveFractionIx(
		perpMarketIndex: number,
		maxBaseAssetAmountRatio: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketMaxFillReserveFraction(
			maxBaseAssetAmountRatio,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateMaxSlippageRatioIx(
		perpMarketIndex: number,
		maxSlippageRatio: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateMaxSlippageRatio(
			maxSlippageRatio,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: this.getPerpMarketAccount(perpMarketIndex).pubkey,
				},
			}
		);
	}

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
						? this.getStateAccount().admin
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
						? this.getStateAccount().admin
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

	public async getUpdatePerpMarketMaxOpenInterestIx(
		perpMarketIndex: number,
		maxOpenInterest: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketMaxOpenInterest(
			maxOpenInterest,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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
						? this.getStateAccount().admin
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

	public async getUpdatePerpMarketFeeAdjustmentIx(
		perpMarketIndex: number,
		feeAdjustment: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketFeeAdjustment(
			feeAdjustment,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async getUpdateSpotMarketFeeAdjustmentIx(
		spotMarketIndex: number,
		feeAdjustment: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketFeeAdjustment(
			feeAdjustment,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async updateSerumVault(
		srmVault: PublicKey
	): Promise<TransactionSignature> {
		const updateSerumVaultIx = await this.getUpdateSerumVaultIx(srmVault);

		const tx = await this.buildTransaction(updateSerumVaultIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateSerumVaultIx(
		srmVault: PublicKey
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSerumVault(srmVault, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				srmVault: srmVault,
			},
		});
	}

	public async updatePerpMarketLiquidationFee(
		perpMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number
	): Promise<TransactionSignature> {
		const updatePerpMarketLiquidationFeeIx =
			await this.getUpdatePerpMarketLiquidationFeeIx(
				perpMarketIndex,
				liquidatorFee,
				ifLiquidationFee
			);

		const tx = await this.buildTransaction(updatePerpMarketLiquidationFeeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpMarketLiquidationFeeIx(
		perpMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketLiquidationFee(
			liquidatorFee,
			ifLiquidationFee,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async updateSpotMarketLiquidationFee(
		spotMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number
	): Promise<TransactionSignature> {
		const updateSpotMarketLiquidationFeeIx =
			await this.getUpdateSpotMarketLiquidationFeeIx(
				spotMarketIndex,
				liquidatorFee,
				ifLiquidationFee
			);

		const tx = await this.buildTransaction(updateSpotMarketLiquidationFeeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateSpotMarketLiquidationFeeIx(
		spotMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketLiquidationFee(
			liquidatorFee,
			ifLiquidationFee,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
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

	public async initializeProtocolIfSharesTransferConfig(): Promise<TransactionSignature> {
		const initializeProtocolIfSharesTransferConfigIx =
			await this.getInitializeProtocolIfSharesTransferConfigIx();

		const tx = await this.buildTransaction(
			initializeProtocolIfSharesTransferConfigIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializeProtocolIfSharesTransferConfigIx(): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeProtocolIfSharesTransferConfig(
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					protocolIfSharesTransferConfig:
						getProtocolIfSharesTransferConfigPublicKey(this.program.programId),
				},
			}
		);
	}

	public async updateProtocolIfSharesTransferConfig(
		whitelistedSigners?: PublicKey[],
		maxTransferPerEpoch?: BN
	): Promise<TransactionSignature> {
		const updateProtocolIfSharesTransferConfigIx =
			await this.getUpdateProtocolIfSharesTransferConfigIx(
				whitelistedSigners,
				maxTransferPerEpoch
			);

		const tx = await this.buildTransaction(
			updateProtocolIfSharesTransferConfigIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateProtocolIfSharesTransferConfigIx(
		whitelistedSigners?: PublicKey[],
		maxTransferPerEpoch?: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateProtocolIfSharesTransferConfig(
			whitelistedSigners || null,
			maxTransferPerEpoch,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					protocolIfSharesTransferConfig:
						getProtocolIfSharesTransferConfigPublicKey(this.program.programId),
				},
			}
		);
	}

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
					? this.getStateAccount().admin
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
					? this.getStateAccount().admin
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
					? this.getStateAccount().admin
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

	public async updateSpotMarketFuel(
		spotMarketIndex: number,
		fuelBoostDeposits?: number,
		fuelBoostBorrows?: number,
		fuelBoostTaker?: number,
		fuelBoostMaker?: number,
		fuelBoostInsurance?: number
	): Promise<TransactionSignature> {
		const updateSpotMarketFuelIx = await this.getUpdateSpotMarketFuelIx(
			spotMarketIndex,
			fuelBoostDeposits || null,
			fuelBoostBorrows || null,
			fuelBoostTaker || null,
			fuelBoostMaker || null,
			fuelBoostInsurance || null
		);

		const tx = await this.buildTransaction(updateSpotMarketFuelIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateSpotMarketFuelIx(
		spotMarketIndex: number,
		fuelBoostDeposits?: number,
		fuelBoostBorrows?: number,
		fuelBoostTaker?: number,
		fuelBoostMaker?: number,
		fuelBoostInsurance?: number
	): Promise<TransactionInstruction> {
		const spotMarketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			spotMarketIndex
		);

		return await this.program.instruction.updateSpotMarketFuel(
			fuelBoostDeposits || null,
			fuelBoostBorrows || null,
			fuelBoostTaker || null,
			fuelBoostMaker || null,
			fuelBoostInsurance || null,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketPublicKey,
				},
			}
		);
	}

	public async updatePerpMarketFuel(
		perpMarketIndex: number,
		fuelBoostTaker?: number,
		fuelBoostMaker?: number,
		fuelBoostPosition?: number
	): Promise<TransactionSignature> {
		const updatePerpMarketFuelIx = await this.getUpdatePerpMarketFuelIx(
			perpMarketIndex,
			fuelBoostTaker || null,
			fuelBoostMaker || null,
			fuelBoostPosition || null
		);

		const tx = await this.buildTransaction(updatePerpMarketFuelIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpMarketFuelIx(
		perpMarketIndex: number,
		fuelBoostTaker?: number,
		fuelBoostMaker?: number,
		fuelBoostPosition?: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketFuel(
			fuelBoostTaker || null,
			fuelBoostMaker || null,
			fuelBoostPosition || null,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	public async initUserFuel(
		user: PublicKey,
		authority: PublicKey,
		fuelBonusDeposits?: number,
		fuelBonusBorrows?: number,
		fuelBonusTaker?: number,
		fuelBonusMaker?: number,
		fuelBonusInsurance?: number
	): Promise<TransactionSignature> {
		const updatePerpMarketFuelIx = await this.getInitUserFuelIx(
			user,
			authority,
			fuelBonusDeposits,
			fuelBonusBorrows,
			fuelBonusTaker,
			fuelBonusMaker,
			fuelBonusInsurance
		);

		const tx = await this.buildTransaction(updatePerpMarketFuelIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitUserFuelIx(
		user: PublicKey,
		authority: PublicKey,
		fuelBonusDeposits?: number,
		fuelBonusBorrows?: number,
		fuelBonusTaker?: number,
		fuelBonusMaker?: number,
		fuelBonusInsurance?: number
	): Promise<TransactionInstruction> {
		const userStats = await getUserStatsAccountPublicKey(
			this.program.programId,
			authority
		);

		return await this.program.instruction.initUserFuel(
			fuelBonusDeposits || null,
			fuelBonusBorrows || null,
			fuelBonusTaker || null,
			fuelBonusMaker || null,
			fuelBonusInsurance || null,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					user,
					userStats,
				},
			}
		);
	}

	public async initializePythPullOracle(
		feedId: string
	): Promise<TransactionSignature> {
		const initializePythPullOracleIx = await this.getInitializePythPullOracleIx(
			feedId
		);
		const tx = await this.buildTransaction(initializePythPullOracleIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializePythPullOracleIx(
		feedId: string
	): Promise<TransactionInstruction> {
		const feedIdBuffer = getFeedIdUint8Array(feedId);
		return await this.program.instruction.initializePythPullOracle(
			feedIdBuffer,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					systemProgram: SystemProgram.programId,
					priceFeed: getPythPullOraclePublicKey(
						this.program.programId,
						feedIdBuffer
					),
					pythSolanaReceiver: DRIFT_ORACLE_RECEIVER_ID,
				},
			}
		);
	}

	public async initializePythLazerOracle(
		feedId: number
	): Promise<TransactionSignature> {
		const initializePythPullOracleIx =
			await this.getInitializePythLazerOracleIx(feedId);
		const tx = await this.buildTransaction(initializePythPullOracleIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializePythLazerOracleIx(
		feedId: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.initializePythLazerOracle(feedId, {
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().admin,
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

	public async initializeHighLeverageModeConfig(
		maxUsers: number
	): Promise<TransactionSignature> {
		const initializeHighLeverageModeConfigIx =
			await this.getInitializeHighLeverageModeConfigIx(maxUsers);

		const tx = await this.buildTransaction(initializeHighLeverageModeConfigIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializeHighLeverageModeConfigIx(
		maxUsers: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeHighLeverageModeConfig(
			maxUsers,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					highLeverageModeConfig: getHighLeverageModeConfigPublicKey(
						this.program.programId
					),
				},
			}
		);
	}

	public async updateUpdateHighLeverageModeConfig(
		maxUsers: number,
		reduceOnly: boolean
	): Promise<TransactionSignature> {
		const updateHighLeverageModeConfigIx =
			await this.getUpdateHighLeverageModeConfigIx(maxUsers, reduceOnly);

		const tx = await this.buildTransaction(updateHighLeverageModeConfigIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateHighLeverageModeConfigIx(
		maxUsers: number,
		reduceOnly: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateHighLeverageModeConfig(
			maxUsers,
			reduceOnly,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					highLeverageModeConfig: getHighLeverageModeConfigPublicKey(
						this.program.programId
					),
				},
			}
		);
	}

	public async initializeProtectedMakerModeConfig(
		maxUsers: number,
		stateAdmin?: boolean
	): Promise<TransactionSignature> {
		const initializeProtectedMakerModeConfigIx =
			await this.getInitializeProtectedMakerModeConfigIx(maxUsers, stateAdmin);

		const tx = await this.buildTransaction(
			initializeProtectedMakerModeConfigIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializeProtectedMakerModeConfigIx(
		maxUsers: number,
		stateAdmin?: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeProtectedMakerModeConfig(
			maxUsers,
			{
				accounts: {
					admin: stateAdmin
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					protectedMakerModeConfig: getProtectedMakerModeConfigPublicKey(
						this.program.programId
					),
				},
			}
		);
	}

	public async updateProtectedMakerModeConfig(
		maxUsers: number,
		reduceOnly: boolean
	): Promise<TransactionSignature> {
		const updateProtectedMakerModeConfigIx =
			await this.getUpdateProtectedMakerModeConfigIx(maxUsers, reduceOnly);

		const tx = await this.buildTransaction(updateProtectedMakerModeConfigIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateProtectedMakerModeConfigIx(
		maxUsers: number,
		reduceOnly: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateProtectedMakerModeConfig(
			maxUsers,
			reduceOnly,
			{
				accounts: {
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					protectedMakerModeConfig: getProtectedMakerModeConfigPublicKey(
						this.program.programId
					),
				},
			}
		);
	}
}
