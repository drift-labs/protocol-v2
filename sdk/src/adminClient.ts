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
} from './addresses/pda';
import { squareRootBN } from './math/utils';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DriftClient } from './driftClient';
import { PEG_PRECISION } from './constants/numericConstants';
import { calculateTargetPriceTrade } from './math/trade';
import { calculateAmmReservesAfterSwap, getSwapDirection } from './math/amm';
import { PROGRAM_ID as PHOENIX_PROGRAM_ID } from '@ellipsis-labs/phoenix-sdk';

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
				admin: this.wallet.publicKey,
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
		activeStatus = true,
		name = DEFAULT_MARKET_NAME
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
			activeStatus,
			nameBuffer,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket,
					spotMarketVault,
					insuranceFundVault,
					driftSigner: this.getSignerPublicKey(),
					spotMarketMint: mint,
					oracle,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);

		const tx = await this.buildTransaction(initializeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		// const { txSig } = await this.sendTransaction(initializeTx, [], this.opts);

		await this.accountSubscriber.addSpotMarket(spotMarketIndex);
		await this.accountSubscriber.addOracle({
			source: oracleSource,
			publicKey: oracle,
		});
		await this.accountSubscriber.setSpotOracleMap();

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

		const initializeIx =
			await this.program.instruction.initializeSerumFulfillmentConfig(
				marketIndex,
				{
					accounts: {
						admin: this.wallet.publicKey,
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

		const tx = await this.buildTransaction(initializeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async initializePhoenixFulfillmentConfig(
		marketIndex: number,
		phoenixMarket: PublicKey
	): Promise<TransactionSignature> {
		const phoenixFulfillmentConfig = getPhoenixFulfillmentConfigPublicKey(
			this.program.programId,
			phoenixMarket
		);

		const initializeIx =
			await this.program.instruction.initializePhoenixFulfillmentConfig(
				marketIndex,
				{
					accounts: {
						admin: this.wallet.publicKey,
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

		const tx = await this.buildTransaction(initializeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async initializePerpMarket(
		marketIndex: number,
		priceOracle: PublicKey,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_PRECISION,
		oracleSource: OracleSource = OracleSource.PYTH,
		marginRatioInitial = 2000,
		marginRatioMaintenance = 500,
		liquidatorFee = 0,
		activeStatus = true,
		name = DEFAULT_MARKET_NAME
	): Promise<TransactionSignature> {
		const currentPerpMarketIndex = this.getStateAccount().numberOfMarkets;
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			currentPerpMarketIndex
		);

		const nameBuffer = encodeName(name);
		const initializeMarketIx =
			await this.program.instruction.initializePerpMarket(
				marketIndex,
				baseAssetReserve,
				quoteAssetReserve,
				periodicity,
				pegMultiplier,
				oracleSource,
				marginRatioInitial,
				marginRatioMaintenance,
				liquidatorFee,
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
		const tx = await this.buildTransaction(initializeMarketIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		while (this.getStateAccount().numberOfMarkets <= currentPerpMarketIndex) {
			await this.fetchAccounts();
		}

		await this.accountSubscriber.addPerpMarket(currentPerpMarketIndex);
		await this.accountSubscriber.addOracle({
			source: oracleSource,
			publicKey: priceOracle,
		});
		await this.accountSubscriber.setPerpOracleMap();

		return txSig;
	}

	public async deleteInitializedPerpMarket(
		marketIndex: number
	): Promise<TransactionSignature> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		const deleteInitializeMarketIx =
			await this.program.instruction.deleteInitializedPerpMarket(marketIndex, {
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					perpMarket: perpMarketPublicKey,
				},
			});

		const tx = await this.buildTransaction(deleteInitializeMarketIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

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

		const moveAmmPriceIx = await this.program.instruction.moveAmmPrice(
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

		const tx = await this.buildTransaction(moveAmmPriceIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateK(
		perpMarketIndex: number,
		sqrtK: BN
	): Promise<TransactionSignature> {
		const updateKIx = await this.program.instruction.updateK(sqrtK, {
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

		const tx = await this.buildTransaction(updateKIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async recenterPerpMarketAmm(
		perpMarketIndex: number,
		pegMultiplier: BN,
		sqrtK: BN
	): Promise<TransactionSignature> {
		const marketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		const recenterPerpMarketAmmIx =
			await this.program.instruction.recenterPerpMarketAmm(
				pegMultiplier,
				sqrtK,
				{
					accounts: {
						state: await this.getStatePublicKey(),
						admin: this.wallet.publicKey,
						perpMarket: marketPublicKey,
					},
				}
			);

		const tx = await this.buildTransaction(recenterPerpMarketAmmIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updatePerpMarketConcentrationScale(
		perpMarketIndex: number,
		concentrationScale: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketConcentrationCoef(
			concentrationScale,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
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

		const moveAmmPriceIx = await this.program.instruction.moveAmmPrice(
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

		const tx = await this.buildTransaction(moveAmmPriceIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
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

		const repegAmmCurveIx = await this.program.instruction.repegAmmCurve(
			newPeg,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					oracle: ammData.oracle,
					perpMarket: perpMarketPublicKey,
				},
			}
		);

		const tx = await this.buildTransaction(repegAmmCurveIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
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

		const depositIntoPerpMarketFeePoolIx =
			await this.program.instruction.depositIntoPerpMarketFeePool(amount, {
				accounts: {
					admin: this.wallet.publicKey,
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

		const tx = await this.buildTransaction(depositIntoPerpMarketFeePoolIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateAdmin(admin: PublicKey): Promise<TransactionSignature> {
		const updateAdminIx = await this.program.instruction.updateAdmin(admin, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});

		const tx = await this.buildTransaction(updateAdminIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
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

	public async updatePerpMarketTargetBaseAssetAmountPerLp(
		perpMarketIndex: number,
		targetBaseAssetAmountPerLP: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketTargetBaseAssetAmountPerLp(
			targetBaseAssetAmountPerLP,
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
		const updatePerpMarketMarginRatioIx =
			await this.program.instruction.updatePerpMarketMarginRatio(
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

		const tx = await this.buildTransaction(updatePerpMarketMarginRatioIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updatePerpMarketFundingPeriod(
		perpMarketIndex: number,
		fundingPeriod: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketMarginRatioIx =
			await this.program.instruction.updatePerpMarketFundingRate(
				fundingPeriod,
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

		const tx = await this.buildTransaction(updatePerpMarketMarginRatioIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updatePerpMarketImfFactor(
		perpMarketIndex: number,
		imfFactor: number,
		unrealizedPnlImfFactor: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketImfFactor(
			imfFactor,
			unrealizedPnlImfFactor,
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
		const updatePerpMarketBaseSpreadIx =
			await this.program.instruction.updatePerpMarketBaseSpread(baseSpread, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			});

		const tx = await this.buildTransaction(updatePerpMarketBaseSpreadIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateAmmJitIntensity(
		perpMarketIndex: number,
		ammJitIntensity: number
	): Promise<TransactionSignature> {
		const updateAmmJitIntensityIx =
			await this.program.instruction.updateAmmJitIntensity(ammJitIntensity, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			});

		const tx = await this.buildTransaction(updateAmmJitIntensityIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updatePerpMarketName(
		perpMarketIndex: number,
		name: string
	): Promise<TransactionSignature> {
		const nameBuffer = encodeName(name);

		const updatePerpMarketNameIx =
			await this.program.instruction.updatePerpMarketName(nameBuffer, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			});

		const tx = await this.buildTransaction(updatePerpMarketNameIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateSpotMarketName(
		spotMarketIndex: number,
		name: string
	): Promise<TransactionSignature> {
		const nameBuffer = encodeName(name);

		return await this.program.rpc.updateSpotMarketName(nameBuffer, {
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

	public async updatePerpMarketPerLpBase(
		perpMarketIndex: number,
		perLpBase: number
	): Promise<TransactionSignature> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		return await this.program.rpc.updatePerpMarketPerLpBase(perLpBase, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
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
		const updatePerpFeeStructureIx =
			this.program.instruction.updatePerpFeeStructure(feeStructure, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			});

		const tx = await this.buildTransaction(updatePerpFeeStructureIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateSpotFeeStructure(
		feeStructure: FeeStructure
	): Promise<TransactionSignature> {
		const updateSpotFeeStructureIx =
			await this.program.instruction.updateSpotFeeStructure(feeStructure, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			});

		const tx = await this.buildTransaction(updateSpotFeeStructureIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateInitialPctToLiquidate(
		initialPctToLiquidate: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateInitialPctToLiquidate(
			initialPctToLiquidate,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateLiquidationDuration(
		liquidationDuration: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateLiquidationDuration(
			liquidationDuration,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateLiquidationMarginBufferRatio(
		updateLiquidationMarginBufferRatio: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateLiquidationMarginBufferRatio(
			updateLiquidationMarginBufferRatio,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateOracleGuardRails(
		oracleGuardRails: OracleGuardRails
	): Promise<TransactionSignature> {
		const updateOracleGuardRailsIx =
			await this.program.instruction.updateOracleGuardRails(oracleGuardRails, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			});

		const tx = await this.buildTransaction(updateOracleGuardRailsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateStateSettlementDuration(
		settlementDuration: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateStateSettlementDuration(
			settlementDuration,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateStateMaxNumberOfSubAccounts(
		maxNumberOfSubAccounts: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateStateMaxNumberOfSubAccounts(
			maxNumberOfSubAccounts,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateStateMaxInitializeUserFee(
		maxInitializeUserFee: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateStateMaxInitializeUserFee(
			maxInitializeUserFee,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
			await this.program.instruction.updateWithdrawGuardThreshold(
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

		const tx = await this.buildTransaction(updateWithdrawGuardThresholdIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateSpotMarketIfFactor(
		spotMarketIndex: number,
		userIfFactor: BN,
		totalIfFactor: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketIfFactorIx =
			await this.program.instruction.updateSpotMarketIfFactor(
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

		const tx = await this.buildTransaction(updateSpotMarketIfFactorIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateSpotMarketRevenueSettlePeriod(
		spotMarketIndex: number,
		revenueSettlePeriod: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketRevenueSettlePeriodIx =
			await this.program.instruction.updateSpotMarketRevenueSettlePeriod(
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

		const tx = await this.buildTransaction(
			updateSpotMarketRevenueSettlePeriodIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateSpotMarketMaxTokenDeposits(
		spotMarketIndex: number,
		maxTokenDeposits: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketMaxTokenDepositsIx =
			this.program.instruction.updateSpotMarketMaxTokenDeposits(
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

		const tx = await this.buildTransaction(updateSpotMarketMaxTokenDepositsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateSpotMarketScaleInitialAssetWeightStart(
		spotMarketIndex: number,
		scaleInitialAssetWeightStart: BN
	): Promise<TransactionSignature> {
		const updateSpotMarketScaleInitialAssetWeightStartIx =
			this.program.instruction.updateSpotMarketScaleInitialAssetWeightStart(
				scaleInitialAssetWeightStart,
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

		const tx = await this.buildTransaction(
			updateSpotMarketScaleInitialAssetWeightStartIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateInsuranceFundUnstakingPeriod(
		spotMarketIndex: number,
		insuranceWithdrawEscrowPeriod: BN
	): Promise<TransactionSignature> {
		const updateInsuranceFundUnstakingPeriodIx =
			await this.program.instruction.updateInsuranceFundUnstakingPeriod(
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

		const tx = await this.buildTransaction(
			updateInsuranceFundUnstakingPeriodIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateLpCooldownTime(
		cooldownTime: BN
	): Promise<TransactionSignature> {
		const updateLpCooldownTimeIx =
			await this.program.instruction.updateLpCooldownTime(cooldownTime, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			});

		const tx = await this.buildTransaction(updateLpCooldownTimeIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updatePerpMarketOracle(
		perpMarketIndex: number,
		oracle: PublicKey,
		oracleSource: OracleSource
	): Promise<TransactionSignature> {
		const updatePerpMarketOracleIx =
			await this.program.instruction.updatePerpMarketOracle(
				oracle,
				oracleSource,
				{
					accounts: {
						admin: this.wallet.publicKey,
						state: await this.getStatePublicKey(),
						perpMarket: await getPerpMarketPublicKey(
							this.program.programId,
							perpMarketIndex
						),
						oracle: oracle,
					},
				}
			);

		const tx = await this.buildTransaction(updatePerpMarketOracleIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updatePerpMarketStepSizeAndTickSize(
		perpMarketIndex: number,
		stepSize: BN,
		tickSize: BN
	): Promise<TransactionSignature> {
		const updatePerpMarketStepSizeAndTickSizeIx =
			await this.program.instruction.updatePerpMarketStepSizeAndTickSize(
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

		const tx = await this.buildTransaction(
			updatePerpMarketStepSizeAndTickSizeIx
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
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

	public async updateSpotMarketStepSizeAndTickSize(
		spotMarketIndex: number,
		stepSize: BN,
		tickSize: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotMarketStepSizeAndTickSize(
			stepSize,
			tickSize,
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

	public async updateSpotMarketMinOrderSize(
		spotMarketIndex: number,
		orderSize: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotMarketMinOrderSize(orderSize, {
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
		return await this.program.rpc.updateSpotMarketOracle(oracle, oracleSource, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				spotMarket: await getSpotMarketPublicKey(
					this.program.programId,
					spotMarketIndex
				),
				oracle: oracle,
			},
		});
	}

	public async updateSpotMarketOrdersEnabled(
		spotMarketIndex: number,
		ordersEnabled: boolean
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotMarketOrdersEnabled(ordersEnabled, {
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

	public async updateSerumFulfillmentConfigStatus(
		serumFulfillmentConfig: PublicKey,
		status: SpotFulfillmentConfigStatus
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSerumFulfillmentConfigStatus(status, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				serumFulfillmentConfig,
			},
		});
	}

	public async updatePhoenixFulfillmentConfigStatus(
		phoenixFulfillmentConfig: PublicKey,
		status: SpotFulfillmentConfigStatus
	): Promise<TransactionSignature> {
		return await this.program.rpc.phoenixFulfillmentConfigStatus(status, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				phoenixFulfillmentConfig,
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
		const updateWhitelistMintIx =
			await this.program.instruction.updateWhitelistMint(whitelistMint, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			});

		const tx = await this.buildTransaction(updateWhitelistMintIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateDiscountMint(
		discountMint: PublicKey
	): Promise<TransactionSignature> {
		const updateDiscountMintIx =
			await this.program.instruction.updateDiscountMint(discountMint, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			});

		const tx = await this.buildTransaction(updateDiscountMintIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateSpotMarketMarginWeights(
		spotMarketIndex: number,
		initialAssetWeight: number,
		maintenanceAssetWeight: number,
		initialLiabilityWeight: number,
		maintenanceLiabilityWeight: number,
		imfFactor = 0
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

	public async updateSpotMarketBorrowRate(
		spotMarketIndex: number,
		optimalUtilization: number,
		optimalBorrowRate: number,
		optimalMaxRate: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotMarketBorrowRate(
			optimalUtilization,
			optimalBorrowRate,
			optimalMaxRate,
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
		const updateSpotMarketAssetTierIx =
			await this.program.instruction.updateSpotMarketAssetTier(assetTier, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			});

		const tx = await this.buildTransaction(updateSpotMarketAssetTierIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateSpotMarketStatus(
		spotMarketIndex: number,
		marketStatus: MarketStatus
	): Promise<TransactionSignature> {
		const updateSpotMarketStatusIx =
			await this.program.instruction.updateSpotMarketStatus(marketStatus, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					spotMarket: await getSpotMarketPublicKey(
						this.program.programId,
						spotMarketIndex
					),
				},
			});

		const tx = await this.buildTransaction(updateSpotMarketStatusIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateSpotMarketPausedOperations(
		spotMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionSignature> {
		const updateSpotMarketPausedOperationsIx =
			await this.program.instruction.updateSpotMarketPausedOperations(
				pausedOperations,
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

		const tx = await this.buildTransaction(updateSpotMarketPausedOperationsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updatePerpMarketStatus(
		perpMarketIndex: number,
		marketStatus: MarketStatus
	): Promise<TransactionSignature> {
		const updatePerpMarketStatusIx =
			await this.program.instruction.updatePerpMarketStatus(marketStatus, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					perpMarket: await getPerpMarketPublicKey(
						this.program.programId,
						perpMarketIndex
					),
				},
			});

		const tx = await this.buildTransaction(updatePerpMarketStatusIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updatePerpMarketPausedOperations(
		perpMarketIndex: number,
		pausedOperations: number
	): Promise<TransactionSignature> {
		const updatePerpMarketPausedOperationsIx =
			await this.program.instruction.updatePerpMarketPausedOperations(
				pausedOperations,
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

		const tx = await this.buildTransaction(updatePerpMarketPausedOperationsIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updatePerpMarketContractTier(
		perpMarketIndex: number,
		contractTier: ContractTier
	): Promise<TransactionSignature> {
		const updatePerpMarketContractTierIx =
			await this.program.instruction.updatePerpMarketContractTier(
				contractTier,
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

		const tx = await this.buildTransaction(updatePerpMarketContractTierIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async updateExchangeStatus(
		exchangeStatus: ExchangeStatus
	): Promise<TransactionSignature> {
		const updateExchangeStatusIx =
			await this.program.instruction.updateExchangeStatus(exchangeStatus, {
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			});

		const tx = await this.buildTransaction(updateExchangeStatusIx);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
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
		return await this.program.rpc.updateMaxSlippageRatio(maxSlippageRatio, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				perpMarket: this.getPerpMarketAccount(perpMarketIndex).pubkey,
			},
		});
	}

	public async updatePerpMarketUnrealizedAssetWeight(
		perpMarketIndex: number,
		unrealizedInitialAssetWeight: number,
		unrealizedMaintenanceAssetWeight: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketUnrealizedAssetWeight(
			unrealizedInitialAssetWeight,
			unrealizedMaintenanceAssetWeight,
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

	public async updatePerpMarketMaxOpenInterest(
		perpMarketIndex: number,
		maxOpenInterest: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketMaxOpenInterest(
			maxOpenInterest,
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

	public async updatePerpMarketFeeAdjustment(
		perpMarketIndex: number,
		feeAdjustment: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketFeeAdjustment(feeAdjustment, {
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

	public async updatePerpMarketLiquidationFee(
		perpMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePerpMarketLiquidationFee(
			liquidatorFee,
			ifLiquidationFee,
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

	public async updateSpotMarketLiquidationFee(
		spotMarketIndex: number,
		liquidatorFee: number,
		ifLiquidationFee: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateSpotMarketLiquidationFee(
			liquidatorFee,
			ifLiquidationFee,
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

	public async initializeProtocolIfSharesTransferConfig(): Promise<TransactionSignature> {
		return await this.program.rpc.initializeProtocolIfSharesTransferConfig({
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
				protocolIfSharesTransferConfig:
					getProtocolIfSharesTransferConfigPublicKey(this.program.programId),
			},
		});
	}

	public async updateProtocolIfSharesTransferConfig(
		whitelistedSigners?: PublicKey[],
		maxTransferPerEpoch?: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateProtocolIfSharesTransferConfig(
			whitelistedSigners || null,
			maxTransferPerEpoch,
			{
				accounts: {
					admin: this.wallet.publicKey,
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
		const params = {
			perpMarketIndex,
			price: price || null,
			maxPrice: maxPrice || null,
		};
		return await this.program.rpc.initializePrelaunchOracle(params, {
			accounts: {
				admin: this.wallet.publicKey,
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
		const params = {
			perpMarketIndex,
			price: price || null,
			maxPrice: maxPrice || null,
		};
		return await this.program.rpc.updatePrelaunchOracleParams(params, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				prelaunchOracle: await getPrelaunchOraclePublicKey(
					this.program.programId,
					perpMarketIndex
				),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}

	public async deletePrelaunchOracle(
		perpMarketIndex: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.deletePrelaunchOracle(perpMarketIndex, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				prelaunchOracle: await getPrelaunchOraclePublicKey(
					this.program.programId,
					perpMarketIndex
				),
				perpMarket: await getPerpMarketPublicKey(
					this.program.programId,
					perpMarketIndex
				),
			},
		});
	}
}
