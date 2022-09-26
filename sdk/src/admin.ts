import {
	PublicKey,
	SYSVAR_RENT_PUBKEY,
	TransactionSignature,
} from '@solana/web3.js';
import { FeeStructure, OracleGuardRails, OracleSource } from './types';
import { BN } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import {
	getClearingHouseStateAccountPublicKeyAndNonce,
	getSpotMarketPublicKey,
	getSpotMarketVaultPublicKey,
	getMarketPublicKey,
	getInsuranceFundVaultPublicKey,
	getSerumOpenOrdersPublicKey,
	getSerumFulfillmentConfigPublicKey,
} from './addresses/pda';
import { squareRootBN } from './math/utils';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ClearingHouse } from './clearingHouse';
import { PEG_PRECISION, ZERO } from './constants/numericConstants';
import { calculateTargetPriceTrade } from './math/trade';
import { calculateAmmReservesAfterSwap, getSwapDirection } from './math/amm';

export class Admin extends ClearingHouse {
	public async initialize(
		usdcMint: PublicKey,
		adminControlsPrices: boolean
	): Promise<[TransactionSignature]> {
		const stateAccountRPCResponse = await this.connection.getParsedAccountInfo(
			await this.getStatePublicKey()
		);
		if (stateAccountRPCResponse.value !== null) {
			throw new Error('Clearing house already initialized');
		}

		const [clearingHouseStatePublicKey] =
			await getClearingHouseStateAccountPublicKeyAndNonce(
				this.program.programId
			);

		const [insuranceVaultPublicKey] = await PublicKey.findProgramAddress(
			[Buffer.from(anchor.utils.bytes.utf8.encode('insurance_vault'))],
			this.program.programId
		);

		const initializeTx = await this.program.transaction.initialize(
			adminControlsPrices,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: clearingHouseStatePublicKey,
					quoteAssetMint: usdcMint,
					rent: SYSVAR_RENT_PUBKEY,
					insuranceVault: insuranceVaultPublicKey,
					clearingHouseSigner: this.getSignerPublicKey(),
					systemProgram: anchor.web3.SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);

		const { txSig: initializeTxSig } = await this.txSender.send(
			initializeTx,
			[],
			this.opts
		);

		return [initializeTxSig];
	}

	public async initializeSpotMarket(
		mint: PublicKey,
		optimalUtilization: BN,
		optimalRate: BN,
		maxRate: BN,
		oracle: PublicKey,
		oracleSource: OracleSource,
		initialAssetWeight: BN,
		maintenanceAssetWeight: BN,
		initialLiabilityWeight: BN,
		maintenanceLiabilityWeight: BN,
		imfFactor = new BN(0),
		liquidationFee = ZERO
	): Promise<TransactionSignature> {
		const spotMarketIndex = this.getStateAccount().numberOfSpotMarkets;
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

		const initializeTx = await this.program.transaction.initializeSpotMarket(
			optimalUtilization,
			optimalRate,
			maxRate,
			oracleSource,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			imfFactor,
			liquidationFee,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket,
					spotMarketVault,
					insuranceFundVault,
					clearingHouseSigner: this.getSignerPublicKey(),
					spotMarketMint: mint,
					oracle,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);

		const { txSig } = await this.txSender.send(initializeTx, [], this.opts);

		await this.accountSubscriber.addSpotMarket(spotMarketIndex);
		await this.accountSubscriber.addOracle({
			source: oracleSource,
			publicKey: oracle,
		});

		return txSig;
	}

	public async initializeSerumFulfillmentConfig(
		marketIndex: BN,
		serumMarket: PublicKey,
		serumProgram: PublicKey
	): Promise<TransactionSignature> {
		const serumOpenOrders = getSerumOpenOrdersPublicKey(
			this.program.programId,
			serumMarket
		);

		const serumFulfillmentConfig = getSerumFulfillmentConfigPublicKey(
			this.program.programId,
			serumMarket
		);

		return await this.program.rpc.initializeSerumFulfillmentConfig(
			marketIndex,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					baseSpotMarket: this.getSpotMarketAccount(marketIndex).pubkey,
					quoteSpotMarket: this.getQuoteSpotMarketAccount().pubkey,
					clearingHouseSigner: this.getSignerPublicKey(),
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

	public async initializeMarket(
		priceOracle: PublicKey,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_PRECISION,
		oracleSource: OracleSource = OracleSource.PYTH,
		marginRatioInitial = 2000,
		marginRatioMaintenance = 500,
		liquidationFee = ZERO
	): Promise<TransactionSignature> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			this.getStateAccount().numberOfMarkets
		);

		const initializeMarketTx = await this.program.transaction.initializeMarket(
			baseAssetReserve,
			quoteAssetReserve,
			periodicity,
			pegMultiplier,
			oracleSource,
			marginRatioInitial,
			marginRatioMaintenance,
			liquidationFee,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					oracle: priceOracle,
					market: marketPublicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
				},
			}
		);
		const { txSig } = await this.txSender.send(
			initializeMarketTx,
			[],
			this.opts
		);

		await this.accountSubscriber.addPerpMarket(
			this.getStateAccount().numberOfMarkets
		);
		await this.accountSubscriber.addOracle({
			source: oracleSource,
			publicKey: priceOracle,
		});

		return txSig;
	}

	public async moveAmmPrice(
		marketIndex: BN,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		sqrtK?: BN
	): Promise<TransactionSignature> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		if (sqrtK == undefined) {
			sqrtK = squareRootBN(baseAssetReserve.mul(quoteAssetReserve));
		}

		return await this.program.rpc.moveAmmPrice(
			baseAssetReserve,
			quoteAssetReserve,
			sqrtK,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					perpMarket: marketPublicKey,
				},
			}
		);
	}

	public async updateK(
		sqrtK: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateK(sqrtK, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				market: await getMarketPublicKey(this.program.programId, marketIndex),
				oracle: this.getPerpMarketAccount(marketIndex).amm.oracle,
			},
		});
	}

	public async updateConcentrationScale(
		marketIndex: BN,
		concentrationScale: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateConcentrationCoef(concentrationScale, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				market: await getMarketPublicKey(this.program.programId, marketIndex),
			},
		});
	}

	public async moveAmmToPrice(
		perpMarketIndex: BN,
		targetPrice: BN
	): Promise<TransactionSignature> {
		const market = this.getPerpMarketAccount(perpMarketIndex);

		const [direction, tradeSize, _] = calculateTargetPriceTrade(
			market,
			targetPrice,
			new BN(1000),
			'quote',
			undefined //todo
		);

		const [newQuoteAssetAmount, newBaseAssetAmount] =
			calculateAmmReservesAfterSwap(
				market.amm,
				'quote',
				tradeSize,
				getSwapDirection('quote', direction)
			);

		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.rpc.moveAmmPrice(
			newBaseAssetAmount,
			newQuoteAssetAmount,
			market.amm.sqrtK,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					perpMarket: marketPublicKey,
				},
			}
		);
	}

	public async repegAmmCurve(
		newPeg: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const ammData = this.getPerpMarketAccount(marketIndex).amm;

		return await this.program.rpc.repegAmmCurve(newPeg, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				market: marketPublicKey,
			},
		});
	}

	public async updateAmmOracleTwap(
		marketIndex: BN
	): Promise<TransactionSignature> {
		const ammData = this.getPerpMarketAccount(marketIndex).amm;
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		return await this.program.rpc.updateAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				market: marketPublicKey,
			},
		});
	}

	public async resetAmmOracleTwap(
		marketIndex: BN
	): Promise<TransactionSignature> {
		const ammData = this.getPerpMarketAccount(marketIndex).amm;
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		return await this.program.rpc.resetAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				market: marketPublicKey,
			},
		});
	}

	public async withdrawFromInsuranceVault(
		amount: BN,
		recipient: PublicKey
	): Promise<TransactionSignature> {
		const state = await this.getStateAccount();
		const spotMarket = this.getQuoteSpotMarketAccount();
		return await this.program.rpc.withdrawFromInsuranceVault(amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: spotMarket.pubkey,
				insuranceVault: state.insuranceVault,
				clearingHouseSigner: this.getSignerPublicKey(),
				recipient: recipient,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async withdrawFromMarketToInsuranceVault(
		marketIndex: BN,
		amount: BN,
		recipient: PublicKey
	): Promise<TransactionSignature> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const spotMarket = this.getQuoteSpotMarketAccount();
		return await this.program.rpc.withdrawFromMarketToInsuranceVault(amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: marketPublicKey,
				spotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
				clearingHouseSigner: this.getSignerPublicKey(),
				recipient: recipient,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async withdrawFromInsuranceVaultToMarket(
		marketIndex: BN,
		amount: BN
	): Promise<TransactionSignature> {
		const state = await this.getStateAccount();
		const spotMarket = this.getQuoteSpotMarketAccount();

		return await this.program.rpc.withdrawFromInsuranceVaultToMarket(amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
				insuranceVault: state.insuranceVault,
				clearingHouseSigner: this.getSignerPublicKey(),
				quoteSpotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async updateAdmin(admin: PublicKey): Promise<TransactionSignature> {
		return await this.program.rpc.updateAdmin(admin, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateCurveUpdateIntensity(
		marketIndex: BN,
		curveUpdateIntensity: number
	): Promise<TransactionSignature> {
		// assert(curveUpdateIntensity >= 0 && curveUpdateIntensity <= 100);
		// assert(Number.isInteger(curveUpdateIntensity));

		return await this.program.rpc.updateCurveUpdateIntensity(
			curveUpdateIntensity,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: await getMarketPublicKey(this.program.programId, marketIndex),
				},
			}
		);
	}

	public async updateMarginRatio(
		marketIndex: BN,
		marginRatioInitial: number,
		marginRatioMaintenance: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarginRatio(
			marginRatioInitial,
			marginRatioMaintenance,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: await getMarketPublicKey(this.program.programId, marketIndex),
				},
			}
		);
	}

	public async updateMarketBaseSpread(
		marketIndex: BN,
		baseSpread: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketBaseSpread(baseSpread, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
			},
		});
	}

	public async updateAmmJitIntensity(
		marketIndex: BN,
		ammJitIntensity: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateAmmJitIntensity(ammJitIntensity, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
			},
		});
	}

	public async updateMarketMaxSpread(
		marketIndex: BN,
		maxSpread: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketMaxSpread(maxSpread, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
			},
		});
	}

	public async updatePartialLiquidationClosePercentage(
		numerator: BN,
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePartialLiquidationClosePercentage(
			numerator,
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updatePartialLiquidationPenaltyPercentage(
		numerator: BN,
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePartialLiquidationPenaltyPercentage(
			numerator,
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFullLiquidationPenaltyPercentage(
		numerator: BN,
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateFullLiquidationPenaltyPercentage(
			numerator,
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updatePartialLiquidationShareDenominator(
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePartialLiquidationLiquidatorShareDenominator(
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFullLiquidationShareDenominator(
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateFullLiquidationLiquidatorShareDenominator(
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updatePerpFeeStructure(
		feeStructure: FeeStructure
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpFeeStructure(feeStructure, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateSpotFeeStructure(
		feeStructure: FeeStructure
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotFeeStructure(feeStructure, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateOracleGuardRails(
		oracleGuardRails: OracleGuardRails
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateOracleGuardRails(oracleGuardRails, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateWithdrawGuardThreshold(
		marketIndex: BN,
		withdrawGuardThreshold: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateWithdrawGuardThreshold(
			withdrawGuardThreshold,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						marketIndex
					),
				},
			}
		);
	}

	public async updateSpotMarketIfFactor(
		marketIndex: BN,
		userIfFactor: BN,
		totalIfFactor: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotMarketIfFactor(
			marketIndex,
			userIfFactor,
			totalIfFactor,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						marketIndex
					),
				},
			}
		);
	}

	public async updateSpotMarketRevenueSettlePeriod(
		marketIndex: BN,
		revenueSettlePeriod: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotMarketRevenueSettlePeriod(
			revenueSettlePeriod,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						marketIndex
					),
				},
			}
		);
	}

	public async updateInsuranceWithdrawEscrowPeriod(
		marketIndex: BN,
		insuranceWithdrawEscrowPeriod: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateInsuranceWithdrawEscrowPeriod(
			insuranceWithdrawEscrowPeriod,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						marketIndex
					),
				},
			}
		);
	}

	public async updateLpCooldownTime(
		marketIndex: BN,
		cooldownTime: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateLpCooldownTime(cooldownTime, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
			},
		});
	}

	public async updateMarketOracle(
		marketIndex: BN,
		oracle: PublicKey,
		oracleSource: OracleSource
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketOracle(oracle, oracleSource, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
			},
		});
	}

	public async updateMarketMinimumQuoteAssetTradeSize(
		marketIndex: BN,
		minimumTradeSize: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketMinimumQuoteAssetTradeSize(
			minimumTradeSize,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: await getMarketPublicKey(this.program.programId, marketIndex),
				},
			}
		);
	}

	public async updateMarketBaseAssetAmountStepSize(
		marketIndex: BN,
		stepSize: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketBaseAssetAmountStepSize(
			stepSize,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: await getMarketPublicKey(this.program.programId, marketIndex),
				},
			}
		);
	}

	public async updateMarketExpiry(
		perpMarketIndex: BN,
		expiryTs: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketExpiry(expiryTs, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async updateWhitelistMint(
		whitelistMint?: PublicKey
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateWhitelistMint(whitelistMint, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateDiscountMint(
		discountMint: PublicKey
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateDiscountMint(discountMint, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateMaxDeposit(maxDeposit: BN): Promise<TransactionSignature> {
		return await this.program.rpc.updateMaxDeposit(maxDeposit, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateFundingPaused(
		fundingPaused: boolean
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateFundingPaused(fundingPaused, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}
	public async updateExchangePaused(
		exchangePaused: boolean
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateExchangePaused(exchangePaused, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async disableAdminControlsPrices(): Promise<TransactionSignature> {
		return await this.program.rpc.disableAdminControlsPrices({
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updatePerpAuctionDuration(
		minDuration: BN | number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpAuctionDuration(
			typeof minDuration === 'number' ? minDuration : minDuration.toNumber(),
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateSpotAuctionDuration(
		defaultAuctionDuration: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotAuctionDuration(
			defaultAuctionDuration,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateMaxBaseAssetAmountRatio(
		marketIndex: BN,
		maxBaseAssetAmountRatio: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMaxBaseAssetAmountRatio(
			maxBaseAssetAmountRatio,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: this.getPerpMarketAccount(marketIndex).pubkey,
				},
			}
		);
	}

	public async updateMaxSlippageRatio(
		marketIndex: BN,
		maxSlippageRatio: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMaxSlippageRatio(maxSlippageRatio, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: this.getPerpMarketAccount(marketIndex).pubkey,
			},
		});
	}

	public async updateMarketMaxImbalances(
		marketIndex: BN,
		unrealizedMaxImbalance: BN,
		maxRevenueWithdrawPerPeriod: BN,
		quoteMaxInsurance: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketMaxImbalances(
			unrealizedMaxImbalance,
			maxRevenueWithdrawPerPeriod,
			quoteMaxInsurance,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: await getMarketPublicKey(this.program.programId, marketIndex),
				},
			}
		);
	}

	public async updateSerumVault(
		srmVault: PublicKey
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSerumVault({
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				srmVault: srmVault,
			},
		});
	}
}
