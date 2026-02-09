import {
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
	MarketStatus,
	ContractTier,
	AssetTier,
	SpotFulfillmentConfigStatus,
	IfRebalanceConfigParams,
	TxParams,
	AddAmmConstituentMappingDatum,
	SwapReduceOnly,
	InitializeConstituentParams,
	ConstituentStatus,
	LPPoolAccount,
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
	getFuelOverflowAccountPublicKey,
	getTokenProgramForSpotMarket,
	getIfRebalanceConfigPublicKey,
	getInsuranceFundStakeAccountPublicKey,
	getLpPoolPublicKey,
	getAmmConstituentMappingPublicKey,
	getConstituentTargetBasePublicKey,
	getConstituentPublicKey,
	getConstituentVaultPublicKey,
	getAmmCachePublicKey,
	getLpPoolTokenVaultPublicKey,
	getDriftSignerPublicKey,
	getConstituentCorrelationsPublicKey,
} from './addresses/pda';
import { squareRootBN } from './math/utils';
import {
	createInitializeMint2Instruction,
	createMintToInstruction,
	createTransferCheckedInstruction,
	getAssociatedTokenAddressSync,
	MINT_SIZE,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { DriftClient } from './driftClient';
import {
	PEG_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	ZERO,
	ONE,
	BASE_PRECISION,
	PRICE_PRECISION,
	GOV_SPOT_MARKET_INDEX,
} from './constants/numericConstants';
import { calculateTargetPriceTrade } from './math/trade';
import { calculateAmmReservesAfterSwap, getSwapDirection } from './math/amm';
import { PROGRAM_ID as PHOENIX_PROGRAM_ID } from '@ellipsis-labs/phoenix-sdk';
import { DRIFT_ORACLE_RECEIVER_ID } from './config';
import { getFeedIdUint8Array } from './util/pythOracleUtils';
import { FUEL_RESET_LOG_ACCOUNT } from './constants/txConstants';
import { JupiterClient, QuoteResponse } from './jupiter/jupiterClient';
import { SwapMode } from './swap/UnifiedSwapClient';

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

	public async deleteSerumFulfillmentConfig(
		serumMarket: PublicKey
	): Promise<TransactionSignature> {
		const deleteIx = await this.getDeleteSerumFulfillmentConfigIx(serumMarket);
		const tx = await this.buildTransaction(deleteIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getDeleteSerumFulfillmentConfigIx(
		serumMarket: PublicKey
	): Promise<TransactionInstruction> {
		const serumFulfillmentConfig = getSerumFulfillmentConfigPublicKey(
			this.program.programId,
			serumMarket
		);
		return await this.program.instruction.deleteSerumFulfillmentConfig({
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				serumFulfillmentConfig,
			},
		});
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

	public async deleteOpenbookV2FulfillmentConfig(
		openbookMarket: PublicKey
	): Promise<TransactionSignature> {
		const deleteIx = await this.getDeleteOpenbookV2FulfillmentConfigIx(
			openbookMarket
		);
		const tx = await this.buildTransaction(deleteIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getDeleteOpenbookV2FulfillmentConfigIx(
		openbookMarket: PublicKey
	): Promise<TransactionInstruction> {
		const openbookV2FulfillmentConfig = getOpenbookV2FulfillmentConfigPublicKey(
			this.program.programId,
			openbookMarket
		);
		return await this.program.instruction.deleteOpenbookV2FulfillmentConfig({
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				openbookV2FulfillmentConfig,
			},
		});
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
		name = DEFAULT_MARKET_NAME,
		lpPoolId: number = 0
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
			lpPoolId
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
		name = DEFAULT_MARKET_NAME,
		lpPoolId: number = 0
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
		ixs.push(initPerpIx);
		return ixs;
	}

	public async initializeAmmCache(
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const initializeAmmCacheIx = await this.getInitializeAmmCacheIx();

		const tx = await this.buildTransaction(initializeAmmCacheIx, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializeAmmCacheIx(): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeAmmCache({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().admin,
				rent: SYSVAR_RENT_PUBKEY,
				ammCache: getAmmCachePublicKey(this.program.programId),
				systemProgram: anchor.web3.SystemProgram.programId,
			},
		});
	}

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

	public async getAddMarketToAmmCacheIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.addMarketToAmmCache({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().admin,
				perpMarket: this.getPerpMarketAccount(perpMarketIndex).pubkey,
				ammCache: getAmmCachePublicKey(this.program.programId),
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
			},
		});
	}

	public async deleteAmmCache(
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const deleteAmmCacheIx = await this.getDeleteAmmCacheIx();

		const tx = await this.buildTransaction(deleteAmmCacheIx, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getDeleteAmmCacheIx(): Promise<TransactionInstruction> {
		return await this.program.instruction.deleteAmmCache({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().admin,
				ammCache: getAmmCachePublicKey(this.program.programId),
			},
		});
	}

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
					: this.getStateAccount().admin,
				ammCache: getAmmCachePublicKey(this.program.programId),
			},
			remainingAccounts,
		});
	}

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
						: this.getStateAccount().admin,
					ammCache: getAmmCachePublicKey(this.program.programId),
				},
			}
		);
	}

	public async resetAmmCache(
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const initializeAmmCacheIx = await this.getResetAmmCacheIx();
		const tx = await this.buildTransaction(initializeAmmCacheIx, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getResetAmmCacheIx(): Promise<TransactionInstruction> {
		return this.program.instruction.resetAmmCache({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().admin,
				ammCache: getAmmCachePublicKey(this.program.programId),
				systemProgram: anchor.web3.SystemProgram.programId,
			},
		});
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

	public async getRecenterPerpMarketAmmCrankIx(
		perpMarketIndex: number,
		depth: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.recenterPerpMarketAmmCrank(
			depth ?? null,
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

	public async getUpdatePerpMarketLpPoolIdIx(
		perpMarketIndex: number,
		lpPoolId: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketLpPoolId(lpPoolId, {
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
						? this.getStateAccount().admin
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
			remainingAccounts,
		});
	}

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

	public async getUpdatePerpMarketPnlPoolIx(
		perpMarketIndex: number,
		amount: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketPnlPool(amount, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
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
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			}
		);
	}

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
						: this.getStateAccount().admin,
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
		netUnsettledFundingPnl?: BN,
		excludeTotalLiqFee?: boolean
	): Promise<TransactionSignature> {
		const updatePerpMarketMarginRatioIx =
			await this.getUpdatePerpMarketAmmSummaryStatsIx(
				perpMarketIndex,
				updateAmmSummaryStats,
				quoteAssetAmountWithUnsettledLp,
				netUnsettledFundingPnl,
				excludeTotalLiqFee
			);

		const tx = await this.buildTransaction(updatePerpMarketMarginRatioIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpMarketAmmSummaryStatsIx(
		perpMarketIndex: number,
		updateAmmSummaryStats?: boolean,
		quoteAssetAmountWithUnsettledLp?: BN,
		netUnsettledFundingPnl?: BN,
		excludeTotalLiqFee?: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketAmmSummaryStats(
			{
				updateAmmSummaryStats: updateAmmSummaryStats ?? null,
				quoteAssetAmountWithUnsettledLp:
					quoteAssetAmountWithUnsettledLp ?? null,
				netUnsettledFundingPnl: netUnsettledFundingPnl ?? null,
				excludeTotalLiqFee: excludeTotalLiqFee ?? null,
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
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
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

	public async getUpdatePerpMarketOracleIx(
		perpMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource,
		skipInvaraintCheck = false
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updatePerpMarketOracle(
			oracle,
			oracleSource,
			skipInvaraintCheck,
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
					oldOracle: this.getPerpMarketAccount(perpMarketIndex).amm.oracle,
					ammCache: getAmmCachePublicKey(this.program.programId),
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

	public async getUpdateSpotMarketOracleIx(
		spotMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource,
		skipInvaraintCheck = false
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateSpotMarketOracle(
			oracle,
			oracleSource,
			skipInvaraintCheck,
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
					oldOracle: this.getSpotMarketAccount(spotMarketIndex).oracle,
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
					ammCache: getAmmCachePublicKey(this.program.programId),
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

	public async transferProtocolIfSharesToRevenuePool(
		outMarketIndex: number,
		inMarketIndex: number,
		amount: BN
	): Promise<TransactionSignature> {
		const transferProtocolIfSharesToRevenuePoolIx =
			await this.getTransferProtocolIfSharesToRevenuePoolIx(
				outMarketIndex,
				inMarketIndex,
				amount
			);

		const tx = await this.buildTransaction(
			transferProtocolIfSharesToRevenuePoolIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getTransferProtocolIfSharesToRevenuePoolIx(
		outMarketIndex: number,
		inMarketIndex: number,
		amount: BN
	): Promise<TransactionInstruction> {
		const remainingAccounts = await this.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [outMarketIndex],
		});

		return await this.program.instruction.transferProtocolIfSharesToRevenuePool(
			outMarketIndex,
			amount,
			{
				accounts: {
					authority: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					insuranceFundVault: await getInsuranceFundVaultPublicKey(
						this.program.programId,
						outMarketIndex
					),
					spotMarketVault: await getSpotMarketVaultPublicKey(
						this.program.programId,
						outMarketIndex
					),
					ifRebalanceConfig: await getIfRebalanceConfigPublicKey(
						this.program.programId,
						inMarketIndex,
						outMarketIndex
					),
					tokenProgram: TOKEN_PROGRAM_ID,
					driftSigner: this.getStateAccount().signer,
				},
				remainingAccounts,
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
			fuelBoostDeposits ?? null,
			fuelBoostBorrows ?? null,
			fuelBoostTaker ?? null,
			fuelBoostMaker ?? null,
			fuelBoostInsurance ?? null
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
			fuelBoostDeposits ?? null,
			fuelBoostBorrows ?? null,
			fuelBoostTaker ?? null,
			fuelBoostMaker ?? null,
			fuelBoostInsurance ?? null,
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
			fuelBoostTaker ?? null,
			fuelBoostMaker ?? null,
			fuelBoostPosition ?? null
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
			fuelBoostTaker ?? null,
			fuelBoostMaker ?? null,
			fuelBoostPosition ?? null,
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
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

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
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

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
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	public async updatePerpMarketProtectedMakerParams(
		perpMarketIndex: number,
		protectedMakerLimitPriceDivisor?: number,
		protectedMakerDynamicDivisor?: number
	): Promise<TransactionSignature> {
		const updatePerpMarketProtectedMakerParamsIx =
			await this.getUpdatePerpMarketProtectedMakerParamsIx(
				perpMarketIndex,
				protectedMakerLimitPriceDivisor || null,
				protectedMakerDynamicDivisor || null
			);

		const tx = await this.buildTransaction(
			updatePerpMarketProtectedMakerParamsIx
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdatePerpMarketProtectedMakerParamsIx(
		perpMarketIndex: number,
		protectedMakerLimitPriceDivisor?: number,
		protectedMakerDynamicDivisor?: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.instruction.updatePerpMarketProtectedMakerParams(
			protectedMakerLimitPriceDivisor || null,
			protectedMakerDynamicDivisor || null,
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

	public async initializeIfRebalanceConfig(
		params: IfRebalanceConfigParams
	): Promise<TransactionSignature> {
		const initializeIfRebalanceConfigIx =
			await this.getInitializeIfRebalanceConfigIx(params);

		const tx = await this.buildTransaction(initializeIfRebalanceConfigIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getInitializeIfRebalanceConfigIx(
		params: IfRebalanceConfigParams
	): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeIfRebalanceConfig(params, {
			accounts: {
				admin: this.isSubscribed
					? this.getStateAccount().admin
					: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				ifRebalanceConfig: await getIfRebalanceConfigPublicKey(
					this.program.programId,
					params.inMarketIndex,
					params.outMarketIndex
				),
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
			},
		});
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

	/**
	 * @param fuelSweepExists - whether the fuel sweep account exists, must provide this if the user has a FuelSweep account in order to properly reset the fuel season
	 * @param authority - the authority to reset fuel for
	 * @returns the transaction signature
	 */
	public async resetFuelSeason(
		fuelSweepExists: boolean,
		authority?: PublicKey
	): Promise<TransactionSignature> {
		const resetFuelSeasonIx = await this.getResetFuelSeasonIx(
			fuelSweepExists,
			authority
		);
		const tx = await this.buildTransaction([resetFuelSeasonIx], this.txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getResetFuelSeasonIx(
		fuelSweepExists: boolean,
		authority?: PublicKey
	): Promise<TransactionInstruction> {
		const remainingAccounts = [];
		if (fuelSweepExists) {
			remainingAccounts.push({
				pubkey: getFuelOverflowAccountPublicKey(
					this.program.programId,
					authority ?? this.wallet.publicKey
				),
				isSigner: false,
				isWritable: true,
			});
		}
		return this.program.instruction.resetFuelSeason({
			accounts: {
				userStats: getUserStatsAccountPublicKey(
					this.program.programId,
					authority ?? this.wallet.publicKey
				),
				authority: authority ?? this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().admin,
				logAccount: FUEL_RESET_LOG_ACCOUNT,
			},
			remainingAccounts,
		});
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
		reduceOnly: boolean,
		currentUsers?: number
	): Promise<TransactionSignature> {
		const updateHighLeverageModeConfigIx =
			await this.getUpdateHighLeverageModeConfigIx(
				maxUsers,
				reduceOnly,
				currentUsers
			);

		const tx = await this.buildTransaction(updateHighLeverageModeConfigIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateHighLeverageModeConfigIx(
		maxUsers: number,
		reduceOnly: boolean,
		currentUsers?: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateHighLeverageModeConfig(
			maxUsers,
			reduceOnly,
			currentUsers,
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
		reduceOnly: boolean,
		currentUsers: undefined
	): Promise<TransactionSignature> {
		const updateProtectedMakerModeConfigIx =
			await this.getUpdateProtectedMakerModeConfigIx(
				maxUsers,
				reduceOnly,
				currentUsers
			);

		const tx = await this.buildTransaction(updateProtectedMakerModeConfigIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateProtectedMakerModeConfigIx(
		maxUsers: number,
		reduceOnly: boolean,
		currentUsers: undefined
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateProtectedMakerModeConfig(
			maxUsers,
			reduceOnly,
			currentUsers,
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

	public async getAdminDepositIx(
		marketIndex: number,
		amount: BN,
		depositUserAccount: PublicKey,
		adminTokenAccount?: PublicKey
	): Promise<TransactionInstruction> {
		const state = await this.getStatePublicKey();
		const spotMarket = this.getSpotMarketAccount(marketIndex);

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

	public async getZeroMMOracleFieldsIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		return await this.program.instruction.zeroMmOracleFields({
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().admin,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					marketIndex
				),
			},
		});
	}

	public async updateFeatureBitFlagsMMOracle(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsMMOracleIx =
			await this.getUpdateFeatureBitFlagsMMOracleIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsMMOracleIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateFeatureBitFlagsMMOracleIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsMmOracle(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFeatureBitFlagsBuilderCodes(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsBuilderCodesIx =
			await this.getUpdateFeatureBitFlagsBuilderCodesIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsBuilderCodesIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateFeatureBitFlagsBuilderCodesIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateFeatureBitFlagsBuilderCodes(enable, {
			accounts: {
				admin: this.useHotWalletAdmin
					? this.wallet.publicKey
					: this.getStateAccount().admin,
				state: await this.getStatePublicKey(),
			},
		});
	}

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

	public async getUpdateFeatureBitFlagsBuilderReferralIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return this.program.instruction.updateFeatureBitFlagsBuilderReferral(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

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

	public async getUpdateFeatureBitFlagsMedianTriggerPriceIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsMedianTriggerPrice(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateDelegateUserGovTokenInsuranceStake(
		authority: PublicKey,
		delegate: PublicKey
	): Promise<TransactionSignature> {
		const updateDelegateUserGovTokenInsuranceStakeIx =
			await this.getUpdateDelegateUserGovTokenInsuranceStakeIx(
				authority,
				delegate
			);

		const tx = await this.buildTransaction(
			updateDelegateUserGovTokenInsuranceStakeIx
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateDelegateUserGovTokenInsuranceStakeIx(
		authority: PublicKey,
		delegate: PublicKey
	): Promise<TransactionInstruction> {
		const marketIndex = GOV_SPOT_MARKET_INDEX;
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			delegate,
			marketIndex
		);
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			authority
		);

		const ix =
			this.program.instruction.getUpdateDelegateUserGovTokenInsuranceStakeIx({
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarket.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: userStatsPublicKey,
					signer: this.wallet.publicKey,
					insuranceFundVault: spotMarket.insuranceFund.vault,
				},
			});

		return ix;
	}

	public async depositIntoInsuranceFundStake(
		marketIndex: number,
		amount: BN,
		userStatsPublicKey: PublicKey,
		insuranceFundStakePublicKey: PublicKey,
		userTokenAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const tx = await this.buildTransaction(
			await this.getDepositIntoInsuranceFundStakeIx(
				marketIndex,
				amount,
				userStatsPublicKey,
				insuranceFundStakePublicKey,
				userTokenAccountPublicKey
			),
			txParams
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getDepositIntoInsuranceFundStakeIx(
		marketIndex: number,
		amount: BN,
		userStatsPublicKey: PublicKey,
		insuranceFundStakePublicKey: PublicKey,
		userTokenAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		return await this.program.instruction.depositIntoInsuranceFundStake(
			marketIndex,
			amount,
			{
				accounts: {
					signer: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: spotMarket.pubkey,
					insuranceFundStake: insuranceFundStakePublicKey,
					userStats: userStatsPublicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					userTokenAccount: userTokenAccountPublicKey,
					tokenProgram: this.getTokenProgramForSpotMarket(spotMarket),
					driftSigner: this.getSignerPublicKey(),
				},
			}
		);
	}

	public async updateFeatureBitFlagsSettleLpPool(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsSettleLpPoolIx =
			await this.getUpdateFeatureBitFlagsSettleLpPoolIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsSettleLpPoolIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateFeatureBitFlagsSettleLpPoolIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsSettleLpPool(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFeatureBitFlagsSwapLpPool(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsSettleLpPoolIx =
			await this.getUpdateFeatureBitFlagsSwapLpPoolIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsSettleLpPoolIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateFeatureBitFlagsSwapLpPoolIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsSwapLpPool(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFeatureBitFlagsMintRedeemLpPool(
		enable: boolean
	): Promise<TransactionSignature> {
		const updateFeatureBitFlagsSettleLpPoolIx =
			await this.getUpdateFeatureBitFlagsMintRedeemLpPoolIx(enable);

		const tx = await this.buildTransaction(updateFeatureBitFlagsSettleLpPoolIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateFeatureBitFlagsMintRedeemLpPoolIx(
		enable: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFeatureBitFlagsMintRedeemLpPool(
			enable,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

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
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					userStats: getUserStatsAccountPublicKey(
						this.program.programId,
						authority
					),
				},
			}
		);
	}

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
		const spotMarketAccount = this.getSpotMarketAccount(spotMarketIndex);

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
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

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
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

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
			this.program.instruction.addAmmConstituentMappingData(
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
	 * Get the drift begin_swap and end_swap instructions
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
		const outSpotMarket = this.getSpotMarketAccount(outMarketIndex);
		const inSpotMarket = this.getSpotMarketAccount(inMarketIndex);

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

		const remainingAccounts = [];
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
		const outMarket = this.getSpotMarketAccount(outMarketIndex);
		const inMarket = this.getSpotMarketAccount(inMarketIndex);

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

	public async getDevnetLpSwapIxs(
		amountIn: BN,
		amountOut: BN,
		externalUserAuthority: PublicKey,
		externalUserInTokenAccount: PublicKey,
		externalUserOutTokenAccount: PublicKey,
		inSpotMarketIndex: number,
		outSpotMarketIndex: number
	): Promise<TransactionInstruction[]> {
		const inSpotMarketAccount = this.getSpotMarketAccount(inSpotMarketIndex);
		const outSpotMarketAccount = this.getSpotMarketAccount(outSpotMarketIndex);

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

	public async getAllDevnetLpSwapIxs(
		lpPoolId: number,
		inMarketIndex: number,
		outMarketIndex: number,
		inAmount: BN,
		minOutAmount: BN,
		externalUserAuthority: PublicKey
	) {
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
				getTokenProgramForSpotMarket(this.getSpotMarketAccount(inMarketIndex)),
				externalUserAuthority
			),
			await this.getAssociatedTokenAccount(
				outMarketIndex,
				false,
				getTokenProgramForSpotMarket(this.getSpotMarketAccount(outMarketIndex)),
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
		const depositSpotMarket = this.getSpotMarketAccount(depositMarketIndex);
		const withdrawSpotMarket = this.getSpotMarketAccount(borrowMarketIndex);

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
					driftSigner: getDriftSignerPublicKey(this.program.programId),
					oracle: withdrawSpotMarket.oracle,
				},
			}
		);

		return { depositIx, withdrawIx };
	}

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

	public async getUpdatePerpMarketLpPoolFeeTransferScalarIx(
		marketIndex: number,
		lpFeeTransferScalar?: number,
		lpExchangeFeeExcluscionScalar?: number
	): Promise<TransactionInstruction> {
		return this.program.instruction.updatePerpMarketLpPoolFeeTransferScalar(
			lpFeeTransferScalar ?? null,
			lpExchangeFeeExcluscionScalar ?? null,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					perpMarket: this.getPerpMarketAccount(marketIndex).pubkey,
				},
			}
		);
	}

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

	public async getUpdatePerpMarketLpPoolPausedOperationsIx(
		marketIndex: number,
		pausedOperations: number
	): Promise<TransactionInstruction> {
		return this.program.instruction.updatePerpMarketLpPoolPausedOperations(
			pausedOperations,
			{
				accounts: {
					admin: this.useHotWalletAdmin
						? this.wallet.publicKey
						: this.getStateAccount().admin,
					state: await this.getStatePublicKey(),
					perpMarket: this.getPerpMarketAccount(marketIndex).pubkey,
				},
			}
		);
	}

	public async mintLpWhitelistToken(
		lpPool: LPPoolAccount,
		authority: PublicKey
	): Promise<TransactionSignature> {
		const ix = await this.getMintLpWhitelistTokenIx(lpPool, authority);
		const tx = await this.buildTransaction(ix);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

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
}
