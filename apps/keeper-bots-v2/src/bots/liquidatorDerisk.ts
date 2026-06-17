/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
	BN,
	DriftClient,
	isVariant,
	PRICE_PRECISION,
	PerpPosition,
	SpotPosition,
	SpotMarketAccount,
	ZERO,
	getTokenAmount,
	getSignedTokenAmount,
	standardizeBaseAssetAmount,
	PositionDirection,
	JupiterClient,
	MarketType,
	getVariant,
	OraclePriceData,
	UserAccount,
	OptionalOrderParams,
	TEN,
	QuoteResponse,
	getLimitOrderParams,
	PERCENTAGE_PRECISION,
	DLOB,
	calculateEstimatedPerpEntryPrice,
	deriveOracleAuctionParams,
	getOrderParams,
	OrderType,
	getTokenValue,
	WRAPPED_SOL_MINT,
	findDirectionToClose,
	calculateMarketAvailablePNL,
	RECOMMENDED_JUPITER_API,
} from '@drift-labs/sdk';
import {
	ComputeBudgetProgram,
	AddressLookupTableAccount,
	TransactionInstruction,
} from '@solana/web3.js';
import {
	createAssociatedTokenAccountInstruction,
	createCloseAccountInstruction,
	getAssociatedTokenAddress,
} from '@solana/spl-token';
import { logger } from '../logger';
import { LiquidatorConfig } from '../config';
import { PriorityFeeSubscriber } from '@drift-labs/sdk';
import {
	checkIfAccountExists,
	simulateAndGetTxWithCUs,
	SimulateAndGetTxWithCUsResponse,
	isSolLstToken,
} from '../utils';

const BPS_PRECISION = 10000;

export type SpotDeriskMethod = 'jupiter' | 'drift';
export type PerpDeriskMethod = 'swift' | 'on-chain';

export class LiquidatorDerisk {
	private driftClient: DriftClient;
	private userMap: any; // UserMap (typed in parent repo)
	private config: LiquidatorConfig;
	private name: string;
	private priorityFeeSubscriber: PriorityFeeSubscriber;
	private jupiterClient?: JupiterClient;
	private driftLookupTables?: AddressLookupTableAccount[];
	private driftSpotLookupTables?: AddressLookupTableAccount;
	private spotDeriskMethod?: SpotDeriskMethod;
	private perpDeriskMethod?: PerpDeriskMethod;

	constructor(opts: {
		driftClient: DriftClient;
		userMap: any;
		config: LiquidatorConfig;
		name: string;
		priorityFeeSubscriber: PriorityFeeSubscriber;
		driftLookupTables?: AddressLookupTableAccount[];
		driftSpotLookupTables?: AddressLookupTableAccount;
		spotDeriskMethod?: SpotDeriskMethod;
		perpDeriskMethod?: PerpDeriskMethod;
	}) {
		this.driftClient = opts.driftClient;
		this.userMap = opts.userMap;
		this.config = opts.config;
		this.name = opts.name;
		this.priorityFeeSubscriber = opts.priorityFeeSubscriber;
		this.driftLookupTables = opts.driftLookupTables;
		this.driftSpotLookupTables = opts.driftSpotLookupTables;
		this.spotDeriskMethod = opts.spotDeriskMethod ?? 'jupiter';
		this.perpDeriskMethod = opts.perpDeriskMethod ?? 'swift';

		if (this.spotDeriskMethod === 'jupiter') {
			this.jupiterClient = new JupiterClient({
				connection: this.driftClient.connection,
				url: RECOMMENDED_JUPITER_API,
			});
		}
	}

	public setLookupTables(
		luts: AddressLookupTableAccount[],
		spotLut?: AddressLookupTableAccount
	) {
		this.driftLookupTables = luts;
		this.driftSpotLookupTables = spotLut;
	}

	private calculateOrderLimitPrice(
		price: BN,
		direction: PositionDirection
	): BN {
		const slippageBN = new BN(
			(this.config.maxSlippageBps! / BPS_PRECISION) *
				PERCENTAGE_PRECISION.toNumber()
		);
		if (isVariant(direction, 'long')) {
			return price
				.mul(PERCENTAGE_PRECISION.add(slippageBN))
				.div(PERCENTAGE_PRECISION);
		} else {
			return price
				.mul(PERCENTAGE_PRECISION.sub(slippageBN))
				.div(PERCENTAGE_PRECISION);
		}
	}

	private calculateDeriskAuctionStartPrice(
		oracle: OraclePriceData,
		direction: PositionDirection
	): BN {
		let auctionStartPrice: BN;
		if (isVariant(direction, 'long')) {
			auctionStartPrice = oracle.price.sub(oracle.confidence);
		} else {
			auctionStartPrice = oracle.price.add(oracle.confidence);
		}
		return auctionStartPrice;
	}

	private async buildVersionedTransactionWithSimulatedCus(
		ixs: Array<TransactionInstruction>,
		luts: Array<AddressLookupTableAccount>,
		cuPriceMicroLamports?: number
	): Promise<SimulateAndGetTxWithCUsResponse> {
		const fullIxs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 1_400_000,
			}),
		];
		if (cuPriceMicroLamports !== undefined) {
			fullIxs.push(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: cuPriceMicroLamports,
				})
			);
		}
		fullIxs.push(...ixs);

		let resp: SimulateAndGetTxWithCUsResponse;
		try {
			const recentBlockhash =
				await this.driftClient.connection.getLatestBlockhash('confirmed');
			resp = await simulateAndGetTxWithCUs({
				ixs: fullIxs,
				connection: this.driftClient.connection,
				payerPublicKey: this.driftClient.wallet.publicKey,
				lookupTableAccounts: luts,
				cuLimitMultiplier: 1.2,
				doSimulation: true,
				dumpTx: false,
				recentBlockhash: recentBlockhash.blockhash,
			});
		} catch (e) {
			const err = e as Error;
			logger.error(
				`error in buildVersionedTransactionWithSimulatedCus: ${err.message}\n${err.stack}`
			);
			resp = {
				cuEstimate: -1,
				simTxLogs: null,
				simError: err,
				simTxDuration: -1,
				// @ts-ignore
				tx: undefined,
			};
		}
		return resp;
	}

	private async driftSpotTrade(
		orderDirection: PositionDirection,
		marketIndex: number,
		tokenAmount: BN,
		limitPrice: BN,
		subAccountId: number
	): Promise<boolean> {
		const position = this.driftClient.getSpotPosition(marketIndex);
		if (!position) {
			return false;
		}
		const positionNetOpenOrders = tokenAmount.gt(ZERO)
			? tokenAmount.add(position.openAsks)
			: tokenAmount.add(position.openBids);

		const spotMarket = this.driftClient.getSpotMarketAccount(marketIndex)!;
		const standardizedTokenAmount = standardizeBaseAssetAmount(
			positionNetOpenOrders,
			spotMarket.orderStepSize
		);

		if (standardizedTokenAmount.eq(ZERO)) {
			logger.info(
				`Skipping drift spot trade, would have traded 0. ${tokenAmount.toString()} -> ${positionNetOpenOrders.toString()} -> ${standardizedTokenAmount.toString()}`
			);
			return false;
		}

		const oracle = this.driftClient.getOracleDataForSpotMarket(marketIndex);
		const auctionStartPrice = this.calculateDeriskAuctionStartPrice(
			oracle,
			orderDirection
		);

		const cancelOrdersIx = await this.driftClient.getCancelOrdersIx(
			MarketType.SPOT,
			marketIndex,
			orderDirection,
			subAccountId
		);
		const placeOrderIx = await this.driftClient.getPlaceSpotOrderIx(
			getLimitOrderParams({
				marketIndex: marketIndex,
				direction: orderDirection,
				baseAssetAmount: standardizedTokenAmount,
				reduceOnly: true,
				price: limitPrice,
				auctionDuration: this.config.deriskAuctionDurationSlots!,
				auctionStartPrice,
				auctionEndPrice: limitPrice,
			}),
			subAccountId
		);

		const simResult = await this.buildVersionedTransactionWithSimulatedCus(
			[cancelOrdersIx, placeOrderIx],
			this.driftLookupTables!,
			Math.floor(this.priorityFeeSubscriber.getCustomStrategyResult())
		);
		if (simResult.simError !== null) {
			logger.error(
				`Error trying to close spot position for market ${marketIndex}, subaccount ${subAccountId}, simError: ${JSON.stringify(
					simResult.simError
				)}`
			);
		} else {
			const resp = await this.driftClient.txSender.sendVersionedTransaction(
				simResult.tx,
				undefined,
				this.driftClient.opts
			);
			logger.info(
				`Sent derisk placeSpotOrder tx for market ${marketIndex} tx: ${resp.txSig} `
			);
			return true;
		}
		return false;
	}

	private async cancelOpenOrdersForSpotMarket(
		marketIndex: number,
		subAccountId: number
	): Promise<boolean> {
		const cancelOrdersIx = await this.driftClient.getCancelOrdersIx(
			MarketType.SPOT,
			marketIndex,
			null,
			subAccountId
		);
		const simResult = await this.buildVersionedTransactionWithSimulatedCus(
			[cancelOrdersIx],
			this.driftLookupTables!,
			Math.floor(this.priorityFeeSubscriber.getCustomStrategyResult())
		);
		if (simResult.simError !== null) {
			logger.error(
				`Error trying to close spot orders for market ${marketIndex}, subaccount ${subAccountId}, simError: ${JSON.stringify(
					simResult.simError
				)}`
			);
		} else {
			const resp = await this.driftClient.txSender.sendVersionedTransaction(
				simResult.tx,
				undefined,
				this.driftClient.opts
			);
			logger.info(
				`Sent cancel orders tx for market ${marketIndex} tx: ${resp.txSig} `
			);
			return true;
		}
		return false;
	}

	private async jupiterSpotSwap(
		orderDirection: PositionDirection,
		inMarketIndex: number,
		outMarketIndex: number,
		quote: QuoteResponse,
		slippageBps: number,
		subAccountId: number
	): Promise<boolean> {
		if (!this.jupiterClient) return false;
		const swapIx = await this.driftClient.getJupiterSwapIxV6({
			jupiterClient: this.jupiterClient!,
			outMarketIndex,
			inMarketIndex,
			amount: new BN(quote.inAmount),
			quote,
			slippageBps,
			userAccountPublicKey: await this.driftClient.getUserAccountPublicKey(
				subAccountId
			),
		});
		const lookupTables = [...swapIx.lookupTables, ...this.driftLookupTables!];
		if (this.driftSpotLookupTables) {
			lookupTables.push(this.driftSpotLookupTables);
		}

		const simResult = await this.buildVersionedTransactionWithSimulatedCus(
			swapIx.ixs,
			lookupTables,
			Math.floor(this.priorityFeeSubscriber.getCustomStrategyResult())
		);
		if (simResult.simError !== null) {
			logger.error(
				`Error trying to ${getVariant(
					orderDirection
				)} on inMarketIndex ${inMarketIndex}, outMarketIndex ${outMarketIndex} on jupiter, subaccount ${subAccountId}, simError: ${JSON.stringify(
					simResult.simError
				)}`
			);
		} else {
			const resp = await this.driftClient.txSender.sendVersionedTransaction(
				simResult.tx,
				undefined,
				this.driftClient.opts
			);
			logger.info(
				`Closed spot position inMarketIndex ${inMarketIndex}, outMarketIndex ${outMarketIndex} on subaccount ${subAccountId}: ${resp.txSig} `
			);
			return true;
		}
		return false;
	}

	private async determineBestSpotSwapRoute(
		spotMarketIndex: number,
		orderDirection: PositionDirection,
		baseAmountIn: BN,
		slippageBps: number
	): Promise<
		| { quote: QuoteResponse; inMarketIndex: number; outMarketIndex: number }
		| undefined
	> {
		if (!this.jupiterClient) {
			logger.warn(
				`No jupiter client available for spot market ${spotMarketIndex}, direction: ${getVariant(
					orderDirection
				)}`
			);
			return undefined;
		}
		const oraclePriceData =
			this.driftClient.getOracleDataForSpotMarket(spotMarketIndex);
		const dlob = await this.userMap!.getDLOB(oraclePriceData.slot.toNumber());
		if (!dlob) {
			logger.error('failed to load DLOB');
		}

		let dlobFillQuoteAmount: BN | undefined;
		if (dlob) {
			dlobFillQuoteAmount = dlob.estimateFillWithExactBaseAmount({
				marketIndex: spotMarketIndex,
				marketType: MarketType.SPOT,
				baseAmount: baseAmountIn,
				orderDirection,
				slot: oraclePriceData.slot.toNumber(),
				oraclePriceData,
			});
		}

		let outMarket: SpotMarketAccount | undefined;
		let inMarket: SpotMarketAccount | undefined;
		let amountIn: BN | undefined;
		const spotMarketIsSolLst = isSolLstToken(spotMarketIndex);
		if (isVariant(orderDirection, 'long')) {
			if (spotMarketIsSolLst) {
				inMarket = this.driftClient.getSpotMarketAccount(1);
				outMarket = this.driftClient.getSpotMarketAccount(spotMarketIndex);
			} else {
				inMarket = this.driftClient.getSpotMarketAccount(0);
				outMarket = this.driftClient.getSpotMarketAccount(spotMarketIndex);
			}
			if (!inMarket || !outMarket) {
				logger.error('failed to get spot markets');
				return undefined;
			}
			const inPrecision = TEN.pow(new BN(inMarket.decimals));
			const outPrecision = TEN.pow(new BN(outMarket.decimals));
			amountIn = oraclePriceData.price
				.mul(baseAmountIn)
				.mul(inPrecision)
				.div(PRICE_PRECISION.mul(outPrecision));
		} else {
			if (spotMarketIsSolLst) {
				inMarket = this.driftClient.getSpotMarketAccount(spotMarketIndex);
				outMarket = this.driftClient.getSpotMarketAccount(1);
			} else {
				inMarket = this.driftClient.getSpotMarketAccount(spotMarketIndex);
				outMarket = this.driftClient.getSpotMarketAccount(0);
			}
			amountIn = baseAmountIn;
		}

		if (!inMarket || !outMarket) {
			logger.error('failed to get spot markets');
			return undefined;
		}

		logger.info(
			`Getting jupiter quote, ${getVariant(
				orderDirection
			)} amount: ${amountIn.toString()}, inMarketIdx: ${
				inMarket.marketIndex
			}, outMarketIdx: ${outMarket.marketIndex}, slippageBps: ${slippageBps}`
		);
		let quote: QuoteResponse | undefined;
		try {
			quote = await this.jupiterClient.getQuote({
				inputMint: inMarket.mint,
				outputMint: outMarket.mint,
				amount: amountIn.abs(),
				slippageBps: slippageBps,
				maxAccounts: 45,
				excludeDexes: ['Raydium CLMM'],
			});
		} catch (e) {
			const err = e as Error;
			logger.error(
				`Error getting Jupiter quote: ${err.message}\n${
					err.stack ? err.stack : ''
				}`
			);
			return undefined;
		}

		if (!quote) {
			logger.warn(
				`Jupiter quote is undefined for spot market ${spotMarketIndex}, direction: ${getVariant(
					orderDirection
				)}, inMarket: ${inMarket.marketIndex}, outMarket: ${
					outMarket.marketIndex
				}, amountIn: ${amountIn.toString()}`
			);
			return undefined;
		}

		if (!quote.routePlan || quote.routePlan.length === 0) {
			logger.info(
				`Found no jupiter route for spot market ${spotMarketIndex}, direction: ${getVariant(
					orderDirection
				)}, inMarket: ${inMarket.marketIndex}, outMarket: ${
					outMarket.marketIndex
				}, amountIn: ${amountIn.toString()}`
			);
			return undefined;
		}

		logger.info(
			`Jupiter quote found for spot market ${spotMarketIndex}, direction: ${getVariant(
				orderDirection
			)}, inAmount: ${quote.inAmount}, outAmount: ${
				quote.outAmount
			}, routePlan length: ${quote.routePlan.length}`
		);

		if (isVariant(orderDirection, 'long')) {
			const jupAmountIn = new BN(quote.inAmount);

			if (
				dlobFillQuoteAmount?.gt(ZERO) &&
				dlobFillQuoteAmount?.lt(jupAmountIn)
			) {
				logger.info(
					`Want to long spot market ${spotMarketIndex}, dlob fill amount ${dlobFillQuoteAmount} < jup amount in ${jupAmountIn}, dont trade on jup`
				);
				return undefined;
			} else {
				logger.info(
					`Using Jupiter route for LONG spot market ${spotMarketIndex}, inMarket: ${
						inMarket.marketIndex
					}, outMarket: ${outMarket.marketIndex}, inAmount: ${
						quote.inAmount
					}, outAmount: ${quote.outAmount}, dlobFillQuoteAmount: ${
						dlobFillQuoteAmount?.toString() ?? 'undefined'
					}`
				);
				return {
					quote,
					inMarketIndex: inMarket.marketIndex,
					outMarketIndex: outMarket.marketIndex,
				};
			}
		} else {
			const jupAmountOut = new BN(quote.outAmount);
			if (dlobFillQuoteAmount?.gt(jupAmountOut)) {
				logger.info(
					`Want to short spot market ${spotMarketIndex}, dlob fill amount ${dlobFillQuoteAmount} > jup amount out ${jupAmountOut}, dont trade on jup`
				);
				return undefined;
			} else {
				logger.info(
					`Using Jupiter route for SHORT spot market ${spotMarketIndex}, inMarket: ${
						inMarket.marketIndex
					}, outMarket: ${outMarket.marketIndex}, inAmount: ${
						quote.inAmount
					}, outAmount: ${quote.outAmount}, dlobFillQuoteAmount: ${
						dlobFillQuoteAmount?.toString() ?? 'undefined'
					}`
				);
				return {
					quote,
					inMarketIndex: inMarket.marketIndex,
					outMarketIndex: outMarket.marketIndex,
				};
			}
		}
	}

	private getOrderParamsForPerpDerisk(
		subaccountId: number,
		position: PerpPosition,
		dlob: DLOB
	): OptionalOrderParams | undefined {
		let baseAssetAmount = position.baseAssetAmount;

		const positionPlusOpenOrders = baseAssetAmount.gt(ZERO)
			? baseAssetAmount.add(position.openAsks)
			: baseAssetAmount.add(position.openBids);

		if (baseAssetAmount.gt(ZERO) && positionPlusOpenOrders.lte(ZERO)) {
			logger.info(
				`already have open orders on subaccount ${subaccountId} for market ${position.marketIndex}, skipping closing`
			);
			return undefined;
		}

		if (baseAssetAmount.lt(ZERO) && positionPlusOpenOrders.gte(ZERO)) {
			logger.info(
				`already have open orders on subaccount ${subaccountId} for market ${position.marketIndex}, skipping`
			);
			return undefined;
		}

		baseAssetAmount = standardizeBaseAssetAmount(
			baseAssetAmount,
			this.driftClient.getPerpMarketAccount(position.marketIndex)!.amm
				.orderStepSize
		);

		if (baseAssetAmount.eq(ZERO)) {
			return undefined;
		}

		const oracle = this.driftClient.getMMOracleDataForPerpMarket(
			position.marketIndex
		);
		const direction = findDirectionToClose(position);
		let entryPrice;
		let bestPrice;
		try {
			({ entryPrice, bestPrice } = calculateEstimatedPerpEntryPrice(
				'base',
				baseAssetAmount.abs(),
				direction,
				this.driftClient.getPerpMarketAccount(position.marketIndex)!,
				oracle,
				dlob,
				this.userMap.getSlot()
			));
		} catch (e) {
			const err = e as Error;
			logger.error(
				`Failed to calculate estimated perp entry price on market: ${
					position.marketIndex
				}, amt: ${baseAssetAmount.toString()}, ${getVariant(direction)}: ${
					err.message
				}\n${err.stack ? err.stack : ''}`
			);
			throw e;
		}
		const limitPrice = this.calculateOrderLimitPrice(entryPrice, direction);
		const { auctionStartPrice, auctionEndPrice, oraclePriceOffset } =
			deriveOracleAuctionParams({
				direction,
				oraclePrice: oracle.price,
				auctionStartPrice: bestPrice,
				auctionEndPrice: limitPrice,
				limitPrice,
			});

		return getOrderParams({
			orderType: OrderType.ORACLE,
			direction,
			baseAssetAmount,
			reduceOnly: true,
			marketIndex: position.marketIndex,
			auctionDuration: this.config.deriskAuctionDurationSlots!,
			auctionStartPrice,
			auctionEndPrice,
			oraclePriceOffset,
		});
	}

	private async deriskPerpPositions(
		userAccount: UserAccount,
		dlob: DLOB
	): Promise<boolean> {
		let didWork = false;
		for (const position of userAccount.perpPositions) {
			const perpMarket = this.driftClient.getPerpMarketAccount(
				position.marketIndex
			)!;
			if (!position.baseAssetAmount.isZero()) {
				if (position.baseAssetAmount.abs().lt(perpMarket.amm.minOrderSize)) {
					continue;
				}

				const orderParams = this.getOrderParamsForPerpDerisk(
					userAccount.subAccountId,
					position,
					dlob
				);
				if (orderParams === undefined) {
					continue;
				}
				const cancelOrdersIx = await this.driftClient.getCancelOrdersIx(
					MarketType.PERP,
					position.marketIndex,
					orderParams.direction,
					userAccount.subAccountId
				);
				const placeOrderIx = await this.driftClient.getPlacePerpOrderIx(
					orderParams,
					userAccount.subAccountId
				);

				const simResult = await this.buildVersionedTransactionWithSimulatedCus(
					[cancelOrdersIx, placeOrderIx],
					this.driftLookupTables!,
					Math.floor(this.priorityFeeSubscriber.getCustomStrategyResult())
				);

				if (simResult.simError !== null) {
					logger.error(
						`Error in placePerpOrder in market: ${
							position.marketIndex
						}, simError: ${JSON.stringify(simResult.simError)}`
					);
				} else {
					const resp = await this.driftClient.txSender.sendVersionedTransaction(
						simResult.tx,
						undefined,
						this.driftClient.opts
					);
					logger.info(
						`Sent deriskPerpPosition tx on market ${position.marketIndex}: ${resp.txSig} `
					);
					didWork = true;
				}
			} else if (position.quoteAssetAmount.lt(ZERO)) {
				const userAccountPubkey =
					await this.driftClient.getUserAccountPublicKey(
						userAccount.subAccountId
					);
				logger.info(
					`Settling negative perp pnl for ${userAccountPubkey.toBase58()} on market ${
						position.marketIndex
					}`
				);
				const ix = await this.driftClient.getSettlePNLsIxs(
					[
						{
							settleeUserAccountPublicKey: userAccountPubkey,
							settleeUserAccount: userAccount,
						},
					],
					[position.marketIndex]
				);

				const simResult = await this.buildVersionedTransactionWithSimulatedCus(
					ix,
					this.driftLookupTables!,
					Math.floor(this.priorityFeeSubscriber.getCustomStrategyResult())
				);
				if (simResult.simError !== null) {
					logger.error(
						`Error in SettlePnl for userAccount ${userAccountPubkey.toBase58()} on market ${
							position.marketIndex
						}, simError: ${JSON.stringify(simResult.simError)}`
					);
				} else {
					const resp = await this.driftClient.txSender.sendVersionedTransaction(
						simResult.tx,
						undefined,
						this.driftClient.opts
					);
					logger.info(
						`Sent settlePnl (negative pnl) tx for ${userAccountPubkey.toBase58()} on market ${
							position.marketIndex
						} tx: ${resp.txSig} `
					);
					didWork = true;
				}
			} else if (position.quoteAssetAmount.gt(ZERO)) {
				const availablePnl = calculateMarketAvailablePNL(
					this.driftClient.getPerpMarketAccount(position.marketIndex)!,
					this.driftClient.getQuoteSpotMarketAccount()
				);
				if (availablePnl.gt(ZERO)) {
					const userAccountPubkey =
						await this.driftClient.getUserAccountPublicKey(
							userAccount.subAccountId
						);
					logger.info(
						`Settling positive perp pnl for ${userAccountPubkey.toBase58()} on market ${
							position.marketIndex
						}`
					);
					const ix = await this.driftClient.getSettlePNLsIxs(
						[
							{
								settleeUserAccountPublicKey: userAccountPubkey,
								settleeUserAccount: userAccount,
							},
						],
						[position.marketIndex]
					);
					const simResult =
						await this.buildVersionedTransactionWithSimulatedCus(
							ix,
							this.driftLookupTables!,
							Math.floor(this.priorityFeeSubscriber.getCustomStrategyResult())
						);
					if (simResult.simError !== null) {
						logger.error(
							`Error in SettlePnl for userAccount ${userAccountPubkey.toBase58()} on market ${
								position.marketIndex
							}, simError: ${JSON.stringify(simResult.simError)}`
						);
					} else {
						const resp =
							await this.driftClient.txSender.sendVersionedTransaction(
								simResult.tx,
								undefined,
								this.driftClient.opts
							);
						logger.info(
							`Sent settlePnl (positive pnl) tx for ${userAccountPubkey.toBase58()} on market ${
								position.marketIndex
							} tx: ${resp.txSig} `
						);
						didWork = true;
					}
				}
			}
		}
		return didWork;
	}

	/**
	 * Withdraws dust from a spot position if the value of the position is less than this.config.spotDustValueThresholdBN
	 * @param userAccount
	 * @param position
	 * @returns
	 */
	private async withdrawDust(
		userAccount: UserAccount,
		position: SpotPosition
	): Promise<boolean> {
		if (this.config.spotDustValueThresholdBN === undefined) {
			return false;
		}

		if (isVariant(position.balanceType, 'borrow')) {
			return false;
		}
		const spotMarket = this.driftClient.getSpotMarketAccount(
			position.marketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`failed to get spot market account for market ${position.marketIndex}`
			);
		}
		const oracle = this.driftClient.getOracleDataForSpotMarket(
			position.marketIndex
		);
		const tokenAmount = getTokenAmount(
			position.scaledBalance,
			spotMarket,
			position.balanceType
		);
		const spotPositionValue = getTokenValue(
			tokenAmount,
			spotMarket.decimals,
			oracle
		);
		if (spotPositionValue.lte(this.config.spotDustValueThresholdBN)) {
			let userTokenAccount = await getAssociatedTokenAddress(
				spotMarket.mint,
				userAccount.authority
			);
			const ixs: TransactionInstruction[] = [];
			const isSolWithdraw = spotMarket.mint.equals(WRAPPED_SOL_MINT);
			if (isSolWithdraw) {
				const { ixs: startIxs, pubkey } =
					await this.driftClient.getWrappedSolAccountCreationIxs(
						tokenAmount,
						true
					);
				ixs.push(...startIxs);
				userTokenAccount = pubkey;
			} else {
				const accountExists = await checkIfAccountExists(
					this.driftClient.connection,
					userTokenAccount
				);

				if (!accountExists) {
					ixs.push(
						createAssociatedTokenAccountInstruction(
							this.driftClient.wallet.publicKey,
							userTokenAccount,
							this.driftClient.wallet.publicKey,
							spotMarket.mint,
							this.driftClient.getTokenProgramForSpotMarket(spotMarket)
						)
					);
				}
			}

			ixs.push(
				await this.driftClient.getWithdrawIx(
					tokenAmount,
					position.marketIndex,
					userTokenAccount,
					undefined,
					userAccount.subAccountId
				)
			);
			if (isSolWithdraw) {
				ixs.push(
					createCloseAccountInstruction(
						userTokenAccount,
						userAccount.authority,
						userAccount.authority,
						[]
					)
				);
			}

			const simResult = await this.buildVersionedTransactionWithSimulatedCus(
				ixs,
				this.driftLookupTables!,
				Math.floor(this.priorityFeeSubscriber.getCustomStrategyResult())
			);
			if (simResult.simError !== null) {
				logger.error(
					`Error trying to withdraw spot dust for market ${
						position.marketIndex
					}, subaccount ${userAccount.subAccountId}, simError: ${JSON.stringify(
						simResult.simError
					)}`
				);
				return false;
			} else {
				const resp = await this.driftClient.txSender.sendVersionedTransaction(
					simResult.tx,
					undefined,
					this.driftClient.opts
				);
				logger.info(
					`Sent withdraw dust on market ${position.marketIndex} tx: ${resp.txSig} `
				);
				return true;
			}
		}

		return false;
	}

	private getOrderParamsForSpotDerisk(
		subaccountId: number,
		position: SpotPosition
	):
		| { tokenAmount: BN; limitPrice: BN; direction: PositionDirection }
		| undefined {
		const spotMarket = this.driftClient.getSpotMarketAccount(
			position.marketIndex
		);
		if (!spotMarket) {
			logger.error(
				`failed to get spot market account for market ${position.marketIndex}`
			);
			return undefined;
		}

		const tokenAmount = getSignedTokenAmount(
			getTokenAmount(position.scaledBalance, spotMarket, position.balanceType),
			position.balanceType
		);

		if (tokenAmount.abs().lt(spotMarket.minOrderSize)) {
			return undefined;
		}

		let direction: PositionDirection = PositionDirection.LONG;
		if (isVariant(position.balanceType, 'deposit')) {
			direction = PositionDirection.SHORT;
		}

		const oracle = this.driftClient.getOracleDataForSpotMarket(
			position.marketIndex
		);
		const limitPrice = this.calculateOrderLimitPrice(oracle.price, direction);

		return {
			tokenAmount,
			limitPrice,
			direction,
		};
	}

	private async deriskSpotPositions(
		userAccount: UserAccount
	): Promise<boolean> {
		let didWork = false;
		for (const position of userAccount.spotPositions) {
			if (position.scaledBalance.eq(ZERO) || position.marketIndex === 0) {
				if (position.openOrders != 0) {
					const cancelled = await this.cancelOpenOrdersForSpotMarket(
						position.marketIndex,
						userAccount.subAccountId
					);
					if (cancelled) didWork = true;
				}
				continue;
			}

			const dustWithdrawn = await this.withdrawDust(userAccount, position);
			if (dustWithdrawn) {
				continue;
			}

			const orderParams = this.getOrderParamsForSpotDerisk(
				userAccount.subAccountId,
				position
			);
			if (orderParams === undefined) {
				continue;
			}

			const slippageBps = this.config.maxSlippageBps!;
			const jupQuote = await this.determineBestSpotSwapRoute(
				position.marketIndex,
				orderParams.direction,
				orderParams.tokenAmount,
				slippageBps
			);
			if (!jupQuote) {
				console.log('no jup quote');
				const placed = await this.driftSpotTrade(
					orderParams.direction,
					position.marketIndex,
					orderParams.tokenAmount,
					orderParams.limitPrice,
					userAccount.subAccountId
				);
				if (placed) didWork = true;
			} else {
				const swapped = await this.jupiterSpotSwap(
					orderParams.direction,
					jupQuote.inMarketIndex,
					jupQuote.outMarketIndex,
					jupQuote.quote,
					slippageBps,
					userAccount.subAccountId
				);
				if (swapped) didWork = true;
			}
		}
		return didWork;
	}

	public async deriskForSubaccount(
		subaccountId: number,
		dlob: DLOB
	): Promise<boolean> {
		this.driftClient.switchActiveUser(subaccountId, this.driftClient.authority);
		const userAccount = this.driftClient.getUserAccount(subaccountId);
		if (!userAccount) {
			logger.error('failed to get user account');
			return false;
		}
		if (userAccount.subAccountId !== subaccountId) {
			logger.error('failed to switch user account');
			return false;
		}

		const perp = await this.deriskPerpPositions(userAccount, dlob);
		const spot = await this.deriskSpotPositions(userAccount);
		return perp || spot;
	}

	public async deriskAllSubaccounts(
		dlob: DLOB,
		subaccountIds: number[]
	): Promise<boolean> {
		let didWork = false;
		for (const subAccountId of subaccountIds) {
			const subDidWork: boolean = await this.deriskForSubaccount(
				subAccountId,
				dlob
			);
			if (subDidWork) didWork = true;
		}
		return didWork;
	}
}
