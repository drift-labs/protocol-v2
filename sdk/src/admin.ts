import {
	PublicKey,
	SYSVAR_RENT_PUBKEY,
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
} from './types';
import { DEFAULT_MARKET_NAME, encodeName } from './userName';
import { BN } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import {
	getClearingHouseStateAccountPublicKeyAndNonce,
	getSpotMarketPublicKey,
	getSpotMarketVaultPublicKey,
	getPerpMarketPublicKey,
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
		_adminControlsPrices: boolean
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

		const initializeTx = await this.program.transaction.initialize({
			accounts: {
				admin: this.wallet.publicKey,
				state: clearingHouseStatePublicKey,
				quoteAssetMint: usdcMint,
				rent: SYSVAR_RENT_PUBKEY,
				clearingHouseSigner: this.getSignerPublicKey(),
				systemProgram: anchor.web3.SystemProgram.programId,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});

		const { txSig: initializeTxSig } = await this.txSender.send(
			initializeTx,
			[],
			this.opts
		);

		return [initializeTxSig];
	}

	public async initializeSpotMarket(
		mint: PublicKey,
		optimalUtilization: number,
		optimalRate: number,
		maxRate: number,
		oracle: PublicKey,
		oracleSource: OracleSource,
		initialAssetWeight: BN,
		maintenanceAssetWeight: BN,
		initialLiabilityWeight: BN,
		maintenanceLiabilityWeight: BN,
		imfFactor = new BN(0),
		liquidationFee = ZERO,
		activeStatus = true
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
			activeStatus,
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
		marketIndex: number,
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

	public async initializePerpMarket(
		priceOracle: PublicKey,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_PRECISION,
		oracleSource: OracleSource = OracleSource.PYTH,
		marginRatioInitial = 2000,
		marginRatioMaintenance = 500,
		liquidationFee = ZERO,
		activeStatus = true,
		name = DEFAULT_MARKET_NAME
	): Promise<TransactionSignature> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			this.getStateAccount().numberOfMarkets
		);

		const nameBuffer = encodeName(name);
		const initializeMarketTx =
			await this.program.transaction.initializePerpMarket(
				baseAssetReserve,
				quoteAssetReserve,
				periodicity,
				pegMultiplier,
				oracleSource,
				marginRatioInitial,
				marginRatioMaintenance,
				liquidationFee,
				activeStatus,
				nameBuffer,
				{
					accounts: {
						state: await this.getStatePublicKey(),
						admin: this.wallet.publicKey,
						oracle: priceOracle,
						perpMarket: perpMarketPublicKey,
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
		perpMarketIndex: number,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		sqrtK?: BN
	): Promise<TransactionSignature> {
		const marketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
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
		perpMarketIndex: number,
		sqrtK: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateK(sqrtK, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
				oracle: this.getPerpMarketAccount(perpMarketIndex).amm.oracle,
			},
		});
	}

	public async updatePerpMarketConcentrationScale(
		perpMarketIndex: number,
		concentrationScale: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateConcentrationCoef(concentrationScale, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async moveAmmToPrice(
		perpMarketIndex: number,
		targetPrice: BN
	): Promise<TransactionSignature> {
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

		return await this.program.rpc.moveAmmPrice(
			newBaseAssetAmount,
			newQuoteAssetAmount,
			perpMarket.amm.sqrtK,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	public async repegAmmCurve(
		newPeg: BN,
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);
		const ammData = this.getPerpMarketAccount(perpMarketIndex).amm;

		return await this.program.rpc.repegAmmCurve(newPeg, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				perpMarket: perpMarketPublicKey,
			},
		});
	}

	public async updatePerpMarketAmmOracleTwap(
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const ammData = this.getPerpMarketAccount(perpMarketIndex).amm;
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.rpc.updatePerpMarketAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				perpMarket: perpMarketPublicKey,
			},
		});
	}

	public async resetPerpMarketAmmOracleTwap(
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		const ammData = this.getPerpMarketAccount(perpMarketIndex).amm;
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.rpc.resetPerpMarketAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
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
		const spotMarket = this.getQuoteSpotMarketAccount();

		return await this.program.rpc.depositIntoPerpMarketFeePool(amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
				sourceVault,
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

	public async updatePerpMarketCurveUpdateIntensity(
		perpMarketIndex: number,
		curveUpdateIntensity: number
	): Promise<TransactionSignature> {
		// assert(curveUpdateIntensity >= 0 && curveUpdateIntensity <= 100);
		// assert(Number.isInteger(curveUpdateIntensity));

		return await this.program.rpc.updatePerpMarketCurveUpdateIntensity(
			curveUpdateIntensity,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
		return await this.program.rpc.updatePerpMarketMarginRatio(
			marginRatioInitial,
			marginRatioMaintenance,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
		return await this.program.rpc.updatePerpMarketBaseSpread(baseSpread, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async updateAmmJitIntensity(
		perpMarketIndex: number,
		ammJitIntensity: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateAmmJitIntensity(ammJitIntensity, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async updatePerpMarketName(
		perpMarketIndex: number,
		name: string
	): Promise<TransactionSignature> {
		const nameBuffer = encodeName(name);

		return await this.program.rpc.updatePerpMarketName(nameBuffer, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async updatePerpMarketMaxSpread(
		perpMarketIndex: number,
		maxSpread: number
	): Promise<TransactionSignature> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.rpc.updatePerpMarketMaxSpread(maxSpread, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
			},
		});
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
		spotMarketIndex: number,
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
		return await this.program.rpc.updateSpotMarketIfFactor(
			spotMarketIndex,
			userIfFactor,
			totalIfFactor,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
		return await this.program.rpc.updateSpotMarketRevenueSettlePeriod(
			revenueSettlePeriod,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
		return await this.program.rpc.updateSpotMarketMaxTokenDeposits(
			maxTokenDeposits,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
		return await this.program.rpc.updateInsuranceFundUnstakingPeriod(
			insuranceWithdrawEscrowPeriod,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
		return await this.program.rpc.updateLpCooldownTime(cooldownTime, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updatePerpMarketOracle(
		perpMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketOracle(oracle, oracleSource, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async updatePerpMarketStepSizeAndTickSize(
		perpMarketIndex: number,
		stepSize: BN,
		tickSize: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketStepSizeAndTickSize(
			stepSize,
			tickSize,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
		return await this.program.rpc.updatePerpMarketMinOrderSize(orderSize, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async updatePerpMarketExpiry(
		perpMarketIndex: number,
		expiryTs: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketExpiry(expiryTs, {
			accounts: {
				admin: this.wallet.publicKey,
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
		return await this.program.rpc.updatePerpMarketOracle(oracle, oracleSource, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

	public async updateSpotMarketExpiry(
		spotMarketIndex: number,
		expiryTs: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotMarketExpiry(expiryTs, {
			accounts: {
				admin: this.wallet.publicKey,
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

	public async updateSpotMarketMarginWeights(
		spotMarketIndex: number,
		initialAssetWeight: BN,
		maintenanceAssetWeight: BN,
		initialLiabilityWeight: BN,
		maintenanceLiabilityWeight: BN,
		imfFactor = new BN(0)
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotMarketMarginWeights(
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			imfFactor,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
		return await this.program.rpc.updateSpotMarketAssetTier(assetTier, {
			accounts: {
				admin: this.wallet.publicKey,
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
		return await this.program.rpc.updateSpotMarketStatus(marketStatus, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
			},
		});
	}

	public async updatePerpMarketStatus(
		perpMarketIndex: number,
		marketStatus: MarketStatus
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketStatus(marketStatus, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async updatePerpMarketContractTier(
		perpMarketIndex: number,
		contractTier: ContractTier
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketContractTier(contractTier, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async updateExchangeStatus(
		exchangeStatus: ExchangeStatus
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateExchangeStatus(exchangeStatus, {
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

	public async updatePerpMarketMaxFillReserveFraction(
		perpMarketIndex: number,
		maxBaseAssetAmountRatio: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketMaxFillReserveFraction(
			maxBaseAssetAmountRatio,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: this.getPerpMarketAccount(perpMarketIndex).pubkey,
				},
			}
		);
	}

	public async updateMaxSlippageRatio(
		perpMarketIndex: number,
		maxSlippageRatio: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMaxSlippageRatio(maxSlippageRatio, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: this.getPerpMarketAccount(perpMarketIndex).pubkey,
			},
		});
	}

	public async updatePerpMarketMaxImbalances(
		perpMarketIndex: number,
		unrealizedMaxImbalance: BN,
		maxRevenueWithdrawPerPeriod: BN,
		quoteMaxInsurance: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketMaxImbalances(
			unrealizedMaxImbalance,
			maxRevenueWithdrawPerPeriod,
			quoteMaxInsurance,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
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
