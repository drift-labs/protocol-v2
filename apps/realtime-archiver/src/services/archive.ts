import {
	bnStringToNumber,
	DBRecord,
	DepositRecord,
	EntityTypes,
	FundingPaymentRecord,
	FundingRateRecord,
	getRecordFileName,
	getRecordPathName,
	getUniqueRecords,
	IngestionSource,
	InsuranceFundRecord,
	InsuranceFundStakeRecord,
	InsuranceFundSwapRecord,
	isFeatureEnabled,
	LiquidationRecord,
	logger,
	LPMintRedeemRecord,
	LPRecord,
	OrderActionRecord,
	OrderRecord,
	PageData,
	RecordTypes,
	SerializedMarketFilter,
	SettlePnlRecord,
	SwapRecord,
	TransformedRecord,
	VaultDepositorRecord,
} from '@backend/common';
import { S3 } from '@backend/s3';
import {
	AMM_RESERVE_PRECISION,
	BASE_PRECISION,
	VelocityEnv,
	FUNDING_RATE_PRECISION,
	initialize,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
} from '@velocity-exchange/sdk';
import Bottleneck from 'bottleneck';

export const WHITELIST_EVENTS: string[] = [
	RecordTypes.PredictionRecord,
	RecordTypes.TradeRecord,
	RecordTypes.SettlePnlRecord,
	RecordTypes.DepositRecord,
	RecordTypes.RewardRecord,
	RecordTypes.LiquidationRecord,
	RecordTypes.LPRecord,
	RecordTypes.LPMintRedeemRecord,
	RecordTypes.FundingPaymentRecord,
	RecordTypes.InsuranceFundStakeRecord,
	RecordTypes.InsuranceFundRecord,
	RecordTypes.InsuranceFundSwapRecord,
	RecordTypes.FundingRateRecord,
	RecordTypes.SwapRecord,
	...(isFeatureEnabled('VAULT_DEPOSITOR') ? [RecordTypes.VaultDepositorRecord] : []),
];

export const PAGE_SIZE = 5000;

const driftEnv = (process.env.ENV || 'mainnet-beta') as VelocityEnv;
const { SPOT_MARKETS, PERP_MARKETS } = initialize({ env: driftEnv });
const LARGE_USER_THRESHOLD = 25000;

const limiter = new Bottleneck({
	maxConcurrent: 25,
});

export const Archiver = () => {
	let largeUserCache: {
		[key: string]: {
			pages: PageData<DBRecord>[];
		};
	} = {};

	const { getObject, listObjects, putObject } = S3();

	const processType = async ({
		key,
		records,
		pageSize = PAGE_SIZE,
	}: {
		key: string;
		records: DBRecord[];
		pageSize?: number;
	}) => {
		let allExistingRecords: DBRecord[] = [];

		try {
			if (largeUserCache[key]) {
				allExistingRecords = largeUserCache[key].pages.flatMap((page) => page.records);
			} else {
				const files = await listObjects(key);

				const fileContents = await Promise.all(
					files.map((file) =>
						limiter.schedule(async () => {
							if (!file.Key) return null;
							const content = await getObject(file.Key);
							return JSON.parse(content) as PageData<DBRecord>;
						})
					)
				);

				allExistingRecords = fileContents
					.filter((content): content is PageData<DBRecord> => content !== null)
					.flatMap((content) => content.records);
			}
		} catch (error) {
			// File doesn't exist, continue with new file creation
		}

		const combinedRecords = [...records, ...allExistingRecords];
		const uniqueRecords = getUniqueRecords({ records: combinedRecords });

		await paginateAndUploadRecords({
			records: uniqueRecords,
			key,
			pageSize,
		});

		logger.info(`Processed and uploaded file for key: ${key}`);
	};

	const paginateAndUploadRecords = async ({
		records,
		key,
		pageSize = PAGE_SIZE,
		cache = true,
	}: {
		records: DBRecord[];
		key: string;
		pageSize?: number;
		cache?: boolean;
	}) => {
		const totalRecords = records.length;
		const totalPages = Math.ceil(totalRecords / pageSize);

		const pages: PageData<DBRecord>[] = Array.from({ length: totalPages }, (_, i) => {
			const startIndex = i * pageSize;
			const pageRecords = records.slice(startIndex, startIndex + pageSize);
			const currentPage = i + 1;

			return {
				meta: {
					records: pageRecords.length,
					currentPage,
					nextPage: currentPage < totalPages ? currentPage + 1 : null,
					totalRecords,
					totalPages,
				},
				records: pageRecords,
			};
		});

		if (cache && totalRecords >= LARGE_USER_THRESHOLD) {
			logger.info(`Caching results for ${key}`);
			largeUserCache[key] = {
				pages,
			};
		}

		await Promise.all(
			pages.map((pageData, i) => {
				const fileName = `${key}/${getRecordFileName({ page: i + 1 })}`;
				return limiter.schedule(() => putObject(fileName, JSON.stringify(pageData)));
			})
		);
	};

	// TODO types
	const sortRecords = ({ records }: { records: any[] }) => {
		const groupedObjects: {
			market: {
				[marketName: string]: DBRecord[];
			};
			authority: {
				[authorityId: string]: DBRecord[];
			};
			user: {
				[userId: string]: DBRecord[];
			};
		} = { market: {}, authority: {}, user: {} };

		const filteredRecords = records.filter((record) =>
			WHITELIST_EVENTS.includes(record.eventType)
		);

		for (const record of filteredRecords) {
			const transformedRecords = transformRecord(record);
			for (const transformedRecord of transformedRecords) {
				const { entity } = transformedRecord;
				switch (entity) {
					case EntityTypes.User: {
						if ('user' in transformedRecord && transformedRecord.user) {
							if (!groupedObjects['user'][transformedRecord.user]) {
								groupedObjects['user'][transformedRecord.user] = [];
							}

							groupedObjects['user'][transformedRecord.user].push(transformedRecord);
						}
						break;
					}
					case EntityTypes.Authority: {
						if ('authority' in transformedRecord && transformedRecord.authority) {
							if (!groupedObjects['authority'][transformedRecord.authority]) {
								groupedObjects['authority'][transformedRecord.authority] = [];
							}

							groupedObjects['authority'][transformedRecord.authority].push(
								transformedRecord
							);
						} else if (
							'userAuthority' in transformedRecord &&
							transformedRecord.userAuthority
						) {
							if (!groupedObjects['authority'][transformedRecord.userAuthority]) {
								groupedObjects['authority'][transformedRecord.userAuthority] = [];
							}

							groupedObjects['authority'][transformedRecord.userAuthority].push(
								transformedRecord
							);
						} else if (
							'depositorAuthority' in transformedRecord &&
							transformedRecord.depositorAuthority
						) {
							if (
								!groupedObjects['authority'][transformedRecord.depositorAuthority]
							) {
								groupedObjects['authority'][transformedRecord.depositorAuthority] =
									[];
							}

							groupedObjects['authority'][transformedRecord.depositorAuthority].push(
								transformedRecord
							);
						}
						break;
					}
					case EntityTypes.Market: {
						if ('symbol' in transformedRecord && transformedRecord.symbol) {
							if (!groupedObjects['market'][transformedRecord.symbol]) {
								groupedObjects['market'][transformedRecord.symbol] = [];
							}

							groupedObjects['market'][transformedRecord.symbol].push(
								transformedRecord
							);
						} else if (
							'inSymbol' in transformedRecord &&
							transformedRecord.inSymbol &&
							'outSymbol' in transformedRecord &&
							transformedRecord.outSymbol
						) {
							const swapRecord = transformedRecord as unknown as SwapRecord;
							const symbol: string = swapRecord.isInMarket
								? swapRecord.inSymbol
								: swapRecord.outSymbol;
							if (!groupedObjects['market'][symbol]) {
								groupedObjects['market'][symbol] = [];
							}
							groupedObjects['market'][symbol].push(transformedRecord);
						}
						break;
					}
				}
			}
		}

		return groupedObjects;
	};

	const transformRecord = <T extends keyof typeof RecordTypes>(
		record: { eventType: T } & Record<string, any>
	): TransformedRecord<T> => {
		const { eventType } = record;

		switch (eventType) {
			case RecordTypes.OrderRecord: {
				const {
					order: { marketType, marketIndex },
				} = record;

				const basePrecision =
					marketType === SerializedMarketFilter.SPOT
						? SPOT_MARKETS.find((x) => x.marketIndex === marketIndex)?.precision ||
						  BASE_PRECISION
						: BASE_PRECISION;

				const market =
					marketType === SerializedMarketFilter.SPOT
						? SPOT_MARKETS.find((x) => x.marketIndex === marketIndex)
						: PERP_MARKETS.find((x) => x.marketIndex === marketIndex);

				const symbol = market?.symbol ?? 'NA';

				const transformedRecord: OrderRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					user: record.user,
					status: record.order.status,
					orderType: record.order.orderType,
					marketType: record.order.marketType,
					marketFilter: record.order.marketFilter,
					orderId: record.order.orderId,
					userOrderId: record.order.userOrderId,
					marketIndex: record.order.marketIndex,
					price: bnStringToNumber(record.order.price, PRICE_PRECISION),
					baseAssetAmount: bnStringToNumber(record.order.baseAssetAmount, basePrecision),
					quoteAssetAmount: bnStringToNumber(
						record.order.quoteAssetAmountFilled,
						QUOTE_PRECISION
					),
					baseAssetAmountFilled: bnStringToNumber(
						record.order.baseAssetAmountFilled,
						basePrecision
					),
					quoteAssetAmountFilled: bnStringToNumber(
						record.order.quoteAssetAmountFilled,
						QUOTE_PRECISION
					),
					direction: record.order.direction,
					reduceOnly: record.order.reduceOnly,
					triggerPrice: bnStringToNumber(record.order.triggerPrice, PRICE_PRECISION),
					triggerCondition: record.order.triggerCondition,
					existingPositionDirection: record.order.existingPositionDirection,
					postOnly: record.order.postOnly,
					immediateOrCancel: record.order.immediateOrCancel,
					oraclePriceOffset: bnStringToNumber(
						record.order.oraclePriceOffset,
						PRICE_PRECISION
					),
					auctionDuration: bnStringToNumber(record.order.auctionDuration),
					auctionStartPrice: bnStringToNumber(
						record.order.auctionStartPrice,
						PRICE_PRECISION
					),
					auctionEndPrice: bnStringToNumber(
						record.order.auctionEndPrice,
						PRICE_PRECISION
					),
					maxTs: bnStringToNumber(record.order.maxTs),
					symbol,
					entity: EntityTypes.User,
					source: record.source || IngestionSource.SEQUENTIAL,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			case RecordTypes.OrderActionRecord:
			case RecordTypes.PredictionRecord:
			case RecordTypes.TradeRecord: {
				const records: OrderActionRecord[] = [];
				const userRecords: Partial<OrderActionRecord>[] = [];

				const basePrecision =
					record.marketType === SerializedMarketFilter.SPOT
						? SPOT_MARKETS.find((x) => x.marketIndex === record.marketIndex)
								?.precision || BASE_PRECISION
						: BASE_PRECISION;

				if (record.taker) {
					userRecords.push({
						...record,
						user: record.taker,
						userOrderId: record.takerOrderId,
						userExistingQuoteEntryAmount: record.takerExistingQuoteEntryAmount
							? bnStringToNumber(
									record.takerExistingQuoteEntryAmount,
									QUOTE_PRECISION
							  )
							: null,
						userExistingBaseAssetAmount: record.takerExistingBaseAssetAmount
							? bnStringToNumber(record.takerExistingBaseAssetAmount, basePrecision)
							: null,
					});
				}
				if (record.maker) {
					userRecords.push({
						...record,
						user: record.maker,
						userOrderId: record.makerOrderId,
						userExistingQuoteEntryAmount: record.makerExistingQuoteEntryAmount
							? bnStringToNumber(
									record.makerExistingQuoteEntryAmount,
									QUOTE_PRECISION
							  )
							: null,
						userExistingBaseAssetAmount: record.makerExistingBaseAssetAmount
							? bnStringToNumber(record.makerExistingBaseAssetAmount, basePrecision)
							: null,
					});
				}

				const parseOrderActionRecord = (
					record: any
				): Omit<OrderActionRecord, 'entity' | 'source'> => {
					const market =
						record.marketType === SerializedMarketFilter.SPOT
							? SPOT_MARKETS.find((x) => x.marketIndex === record.marketIndex)
							: PERP_MARKETS.find((x) => x.marketIndex === record.marketIndex);

					const symbol = market?.symbol ?? 'NA';

					return {
						ts: bnStringToNumber(record.ts),
						txSig: record.txSig,
						txSigIndex: record.txSigIndex,
						slot: record.slot,
						symbol,
						fillerReward: bnStringToNumber(record.fillerReward, QUOTE_PRECISION),
						baseAssetAmountFilled: bnStringToNumber(
							record.baseAssetAmountFilled,
							basePrecision
						),
						quoteAssetAmountFilled: bnStringToNumber(
							record.quoteAssetAmountFilled,
							QUOTE_PRECISION
						),
						takerFee: bnStringToNumber(record.takerFee, QUOTE_PRECISION),
						makerRebate: bnStringToNumber(record.makerFee, QUOTE_PRECISION),
						referrerReward: bnStringToNumber(record.referrerReward, QUOTE_PRECISION),
						quoteAssetAmountSurplus: bnStringToNumber(
							record.quoteAssetAmountSurplus,
							QUOTE_PRECISION
						),
						takerOrderBaseAssetAmount: bnStringToNumber(
							record.takerOrderBaseAssetAmount,
							basePrecision
						),
						takerOrderCumulativeBaseAssetAmountFilled: bnStringToNumber(
							record.takerOrderCumulativeBaseAssetAmountFilled,
							basePrecision
						),
						takerOrderCumulativeQuoteAssetAmountFilled: bnStringToNumber(
							record.takerOrderCumulativeQuoteAssetAmountFilled,
							QUOTE_PRECISION
						),
						makerOrderBaseAssetAmount: bnStringToNumber(
							record.makerOrderBaseAssetAmount,
							basePrecision
						),
						makerOrderCumulativeBaseAssetAmountFilled: bnStringToNumber(
							record.makerOrderCumulativeBaseAssetAmountFilled,
							basePrecision
						),
						makerOrderCumulativeQuoteAssetAmountFilled: bnStringToNumber(
							record.makerOrderCumulativeQuoteAssetAmountFilled,
							QUOTE_PRECISION
						),
						oraclePrice: bnStringToNumber(record.oraclePrice, PRICE_PRECISION),
						makerFee: bnStringToNumber(record.makerFee, QUOTE_PRECISION),
						action: record.action,
						actionExplanation: record.actionExplanation,
						marketIndex: Number(record.marketIndex),
						marketType: record.marketType,
						marketFilter: record.marketFilter,
						filler: record.filler,
						fillRecordId: record.fillRecordId,
						taker: record.taker,
						takerOrderId: record.takerOrderId,
						takerOrderDirection: record.takerOrderDirection,
						maker: record.maker,
						makerOrderId: record.makerOrderId,
						makerOrderDirection: record.makerOrderDirection,
						spotFulfillmentMethodFee: bnStringToNumber(
							record.spotFulfillmentMethodFee,
							QUOTE_PRECISION
						),
						bitFlags: record.bitFlags ?? 0,
						takerExistingQuoteEntryAmount: record.takerExistingQuoteEntryAmount
							? bnStringToNumber(
									record.takerExistingQuoteEntryAmount,
									QUOTE_PRECISION
							  )
							: null,
						takerExistingBaseAssetAmount: record.takerExistingBaseAssetAmount
							? bnStringToNumber(record.takerExistingBaseAssetAmount, basePrecision)
							: null,
						makerExistingQuoteEntryAmount: record.makerExistingQuoteEntryAmount
							? bnStringToNumber(
									record.makerExistingQuoteEntryAmount,
									QUOTE_PRECISION
							  )
							: null,
						makerExistingBaseAssetAmount: record.makerExistingBaseAssetAmount
							? bnStringToNumber(record.makerExistingBaseAssetAmount, basePrecision)
							: null,
					};
				};

				records.push(
					...userRecords.map((record) => {
						return {
							...parseOrderActionRecord(record),
							userExistingQuoteEntryAmount: record.userExistingQuoteEntryAmount,
							userExistingBaseAssetAmount: record.userExistingBaseAssetAmount,
							user: record.user,
							userOrderId: record.userOrderId,
							entity: EntityTypes.User,
							source: record.source || IngestionSource.SEQUENTIAL,
						};
					})
				);

				if (eventType !== RecordTypes.OrderActionRecord) {
					records.push({
						...parseOrderActionRecord(record),
						entity: EntityTypes.Market,
						source: record.source || IngestionSource.SEQUENTIAL,
					});
				}

				return records as TransformedRecord<T>;
			}

			case RecordTypes.SwapRecord: {
				const inMarket = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(record.inMarketIndex)
				);
				const outMarket = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(record.outMarketIndex)
				);

				const inPrecision = inMarket?.precision ?? QUOTE_PRECISION;
				const outPrecision = outMarket?.precision ?? QUOTE_PRECISION;
				const inSymbol = inMarket?.symbol ?? 'NA';
				const outSymbol = outMarket?.symbol ?? 'NA';

				const baseRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					user: record.user,
					amountOut: bnStringToNumber(record.amountOut, outPrecision),
					amountIn: bnStringToNumber(record.amountIn, inPrecision),
					outMarketIndex: record.outMarketIndex,
					inMarketIndex: record.inMarketIndex,
					outOraclePrice: bnStringToNumber(record.outOraclePrice, PRICE_PRECISION),
					inOraclePrice: bnStringToNumber(record.inOraclePrice, PRICE_PRECISION),
					fee: bnStringToNumber(record.fee, outPrecision),
					inSymbol,
					outSymbol,
					source: record.source || IngestionSource.SEQUENTIAL,
				};

				const records: SwapRecord[] = [
					{
						...baseRecord,
						entity: EntityTypes.User,
					},
					{
						...baseRecord,
						isInMarket: true,
						entity: EntityTypes.Market,
					},
					{
						...baseRecord,
						isInMarket: false,
						entity: EntityTypes.Market,
					},
				];

				return records as TransformedRecord<T>;
			}

			case RecordTypes.SettlePnlRecord: {
				const transformedRecord: SettlePnlRecord = {
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					pnl: bnStringToNumber(record.pnl, PRICE_PRECISION),
					user: record.user,
					baseAssetAmount: bnStringToNumber(record.baseAssetAmount, BASE_PRECISION),
					quoteAssetAmountAfter: bnStringToNumber(
						record.quoteAssetAmountAfter,
						QUOTE_PRECISION
					),
					quoteEntryAmount: bnStringToNumber(record.quoteEntryAmount, QUOTE_PRECISION),
					ts: bnStringToNumber(record.ts),
					settlePrice: bnStringToNumber(record.settlePrice, QUOTE_PRECISION),
					marketIndex: record.marketIndex,
					explanation: record.explanation,
					entity: EntityTypes.User,
					source: record.source || IngestionSource.SEQUENTIAL,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			case RecordTypes.RewardRecord:
			case RecordTypes.DepositRecord: {
				const spotMarket = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(record.marketIndex)
				);
				const symbol = spotMarket?.symbol ?? 'NA';
				const tokenPrecision = spotMarket?.precision ?? QUOTE_PRECISION;

				const baseRecord = {
					amount: bnStringToNumber(record.amount, tokenPrecision),
					oraclePrice: bnStringToNumber(record.oraclePrice, PRICE_PRECISION),
					marketDepositBalance: bnStringToNumber(
						record.marketDepositBalance,
						SPOT_MARKET_BALANCE_PRECISION
					),
					marketWithdrawBalance: bnStringToNumber(
						record.marketWithdrawBalance,
						SPOT_MARKET_BALANCE_PRECISION
					),
					marketCumulativeDepositInterest: bnStringToNumber(
						record.marketCumulativeDepositInterest,
						SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
					),
					marketCumulativeBorrowInterest: bnStringToNumber(
						record.marketCumulativeBorrowInterest,
						SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
					),
					totalDepositsAfter: bnStringToNumber(
						record.totalDepositsAfter,
						QUOTE_PRECISION
					),
					totalWithdrawsAfter: bnStringToNumber(
						record.totalWithdrawsAfter,
						QUOTE_PRECISION
					),
					txSigIndex: record.txSigIndex,
					txSig: record.txSig,
					slot: record.slot,
					ts: bnStringToNumber(record.ts),
					depositRecordId: record.depositRecordId,
					userAuthority: record.userAuthority,
					user: record.user,
					direction: record.direction,
					marketIndex: record.marketIndex,
					explanation: record.explanation,
					symbol,
					source: record.source || IngestionSource.SEQUENTIAL,
				};

				const records: DepositRecord[] = [
					{
						...baseRecord,
						entity: EntityTypes.User,
					},
					{
						...baseRecord,
						entity: EntityTypes.Market,
					},
				];

				return records as TransformedRecord<T>;
			}

			case RecordTypes.LiquidationRecord: {
				const liquidatePerp = record.liquidatePerp;
				const liquidateSpot = record.liquidateSpot;
				const liquidateBorrowForPerpPnl = record.liquidateBorrowForPerpPnl;
				const liquidatePerpPnlForDeposit = record.liquidatePerpPnlForDeposit;
				const perpBankruptcy = record.perpBankruptcy;
				const spotBankruptcy = record.spotBankruptcy;

				const spotTokenPrecision = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(liquidateSpot.assetMarketIndex)
				)?.precision;

				const liabilityTokenPrecision = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(liquidateSpot.liabilityMarketIndex)
				)?.precision;

				const bankruptcySpotTokenPrecision = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(spotBankruptcy.marketIndex)
				)?.precision;

				const liquidatePnlForDepositTokenPrecision = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(liquidatePerpPnlForDeposit.assetMarketIndex)
				)?.precision;

				const transformedRecord: LiquidationRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					liquidationType: record.liquidationType,
					user: record.user,
					liquidator: record.liquidator,
					marginRequirement: bnStringToNumber(record.marginRequirement, QUOTE_PRECISION),
					totalCollateral: bnStringToNumber(record.totalCollateral, QUOTE_PRECISION),
					marginFreed: bnStringToNumber(record.marginFreed, QUOTE_PRECISION),
					liquidationId: record.liquidationId,
					bankrupt: record.bankrupt,
					canceledOrderIds: record.canceledOrderIds,
					liquidatePerp_marketIndex: liquidatePerp.marketIndex,
					liquidatePerp_oraclePrice: bnStringToNumber(
						liquidatePerp.oraclePrice,
						PRICE_PRECISION
					),
					liquidatePerp_baseAssetAmount: bnStringToNumber(
						liquidatePerp.baseAssetAmount,
						BASE_PRECISION
					),
					liquidatePerp_quoteAssetAmount: bnStringToNumber(
						liquidatePerp.quoteAssetAmount,
						QUOTE_PRECISION
					),
					liquidatePerp_lpShares: bnStringToNumber(
						liquidatePerp.lpShares,
						AMM_RESERVE_PRECISION
					),
					liquidatePerp_fillRecordId: liquidatePerp.fillRecordId,
					liquidatePerp_userOrderId: liquidatePerp.userOrderId,
					liquidatePerp_liquidatorOrderId: liquidatePerp.liquidatorOrderId,
					liquidatePerp_liquidatorFee: bnStringToNumber(
						liquidatePerp.liquidatorFee,
						QUOTE_PRECISION
					),
					liquidatePerp_ifFee: bnStringToNumber(liquidatePerp.ifFee, QUOTE_PRECISION),
					liquidateSpot_assetMarketIndex: liquidateSpot.assetMarketIndex,
					liquidateSpot_assetPrice: bnStringToNumber(
						liquidateSpot.assetPrice,
						PRICE_PRECISION
					),
					liquidateSpot_assetTransfer: bnStringToNumber(
						liquidateSpot.assetTransfer,
						spotTokenPrecision
					),
					liquidateSpot_liabilityMarketIndex: liquidateSpot.liabilityMarketIndex,
					liquidateSpot_liabilityPrice: bnStringToNumber(
						liquidateSpot.liabilityPrice,
						PRICE_PRECISION
					),
					liquidateSpot_liabilityTransfer: bnStringToNumber(
						liquidateSpot.liabilityTransfer,
						liabilityTokenPrecision
					),
					liquidateSpot_ifFee: bnStringToNumber(
						liquidateSpot.ifFee,
						liabilityTokenPrecision
					),
					liquidateBorrowForPerpPnl_perpMarketIndex:
						liquidateBorrowForPerpPnl.perpMarketIndex,
					liquidateBorrowForPerpPnl_marketOraclePrice: bnStringToNumber(
						liquidateBorrowForPerpPnl.marketOraclePrice,
						PRICE_PRECISION
					),
					liquidateBorrowForPerpPnl_pnlTransfer: bnStringToNumber(
						liquidateBorrowForPerpPnl.pnlTransfer,
						QUOTE_PRECISION
					),
					liquidateBorrowForPerpPnl_liabilityMarketIndex:
						liquidateBorrowForPerpPnl.liabilityMarketIndex,
					liquidateBorrowForPerpPnl_liabilityPrice: bnStringToNumber(
						liquidateBorrowForPerpPnl.liabilityPrice,
						PRICE_PRECISION
					),
					liquidateBorrowForPerpPnl_liabilityTransfer: bnStringToNumber(
						liquidateBorrowForPerpPnl.liabilityTransfer,
						QUOTE_PRECISION
					),
					liquidatePerpPnlForDeposit_perpMarketIndex:
						liquidatePerpPnlForDeposit.perpMarketIndex,
					liquidatePerpPnlForDeposit_marketOraclePrice: bnStringToNumber(
						liquidatePerpPnlForDeposit.marketOraclePrice,
						PRICE_PRECISION
					),
					liquidatePerpPnlForDeposit_pnlTransfer: bnStringToNumber(
						liquidatePerpPnlForDeposit.pnlTransfer,
						QUOTE_PRECISION
					),
					liquidatePerpPnlForDeposit_assetMarketIndex:
						liquidatePerpPnlForDeposit.assetMarketIndex,
					liquidatePerpPnlForDeposit_assetPrice: bnStringToNumber(
						liquidatePerpPnlForDeposit.assetPrice,
						PRICE_PRECISION
					),
					liquidatePerpPnlForDeposit_assetTransfer: bnStringToNumber(
						liquidatePerpPnlForDeposit.assetTransfer,
						liquidatePnlForDepositTokenPrecision
					),
					perpBankruptcy_marketIndex: perpBankruptcy.marketIndex,
					perpBankruptcy_pnl: bnStringToNumber(perpBankruptcy.pnl, QUOTE_PRECISION),
					perpBankruptcy_ifPayment: bnStringToNumber(
						perpBankruptcy.ifPayment,
						QUOTE_PRECISION
					),
					perpBankruptcy_clawbackUser: perpBankruptcy.clawbackUser,
					perpBankruptcy_clawbackUserPayment: bnStringToNumber(
						perpBankruptcy.clawbackUserPayment,
						QUOTE_PRECISION
					),
					perpBankruptcy_cumulativeFundingRateDelta: bnStringToNumber(
						perpBankruptcy.cumulativeFundingRateDelta,
						PRICE_PRECISION
					),
					spotBankruptcy_marketIndex: spotBankruptcy.marketIndex,
					spotBankruptcy_borrowAmount: bnStringToNumber(
						spotBankruptcy.borrowAmount,
						bankruptcySpotTokenPrecision
					),
					spotBankruptcy_ifPayment: bnStringToNumber(
						spotBankruptcy.ifPayment,
						bankruptcySpotTokenPrecision
					),
					spotBankruptcy_cumulativeDepositInterestDelta: bnStringToNumber(
						spotBankruptcy.cumulativeDepositInterestDelta,
						SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
					),
					bitFlags: record.bitFlags || 0,
					entity: EntityTypes.User,
					source: record.source || IngestionSource.SEQUENTIAL,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			case RecordTypes.InsuranceFundSwapRecord: {
				const inMarket = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(record.inMarketIndex)
				);
				const outMarket = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(record.outMarketIndex)
				);

				const inSymbol = inMarket?.symbol ?? 'NA';
				const outSymbol = outMarket?.symbol ?? 'NA';

				const transformedRecord: InsuranceFundSwapRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					rebalanceConfig: record.rebalanceConfig,
					source: record.source || IngestionSource.SEQUENTIAL,
					inAmount: bnStringToNumber(record.inAmount, QUOTE_PRECISION),
					outAmount: bnStringToNumber(record.outAmount, QUOTE_PRECISION),
					inIfTotalSharesBefore: bnStringToNumber(
						record.inIfTotalSharesBefore,
						QUOTE_PRECISION
					),
					outIfTotalSharesBefore: bnStringToNumber(
						record.outIfTotalSharesBefore,
						QUOTE_PRECISION
					),
					inIfUserSharesBefore: bnStringToNumber(
						record.inIfUserSharesBefore,
						QUOTE_PRECISION
					),
					outIfUserSharesBefore: bnStringToNumber(
						record.outIfUserSharesBefore,
						QUOTE_PRECISION
					),
					inIfTotalSharesAfter: bnStringToNumber(
						record.inIfTotalSharesAfter,
						QUOTE_PRECISION
					),
					inFundVaultAmountAfter: bnStringToNumber(
						record.inFundVaultAmountAfter,
						QUOTE_PRECISION
					),
					outFundVaultAmountAfter: bnStringToNumber(
						record.outFundVaultAmountAfter,
						QUOTE_PRECISION
					),
					inIfUserSharesAfter: bnStringToNumber(
						record.inIfUserSharesAfter,
						QUOTE_PRECISION
					),
					outIfUserSharesAfter: bnStringToNumber(
						record.outIfUserSharesAfter,
						QUOTE_PRECISION
					),
					inMarketIndex: record.inMarketIndex,
					outMarketIndex: record.outMarketIndex,
					inSymbol,
					outSymbol,
					isInMarket: false,
					inVaultAmountBefore: bnStringToNumber(
						record.inVaultAmountBefore,
						QUOTE_PRECISION
					),
					outVaultAmountBefore: bnStringToNumber(
						record.outVaultAmountBefore,
						QUOTE_PRECISION
					),
					outIfTotalSharesAfter: bnStringToNumber(
						record.outIfTotalSharesAfter,
						QUOTE_PRECISION
					),
					outOraclePrice: bnStringToNumber(record.outOraclePrice, PRICE_PRECISION),
					outOraclePriceTwap: bnStringToNumber(
						record.outOraclePriceTwap,
						PRICE_PRECISION
					),
					entity: EntityTypes.Market,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			case RecordTypes.LPRecord: {
				const transformedRecord: LPRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					user: record.user,
					action: record.action,
					marketIndex: record.marketIndex,
					nShares: bnStringToNumber(record.nShares, AMM_RESERVE_PRECISION),
					deltaBaseAssetAmount: bnStringToNumber(
						record.deltaBaseAssetAmount,
						BASE_PRECISION
					),
					deltaQuoteAssetAmount: bnStringToNumber(
						record.deltaQuoteAssetAmount,
						QUOTE_PRECISION
					),
					pnl: bnStringToNumber(record.pnl, QUOTE_PRECISION),
					entity: EntityTypes.User,
					source: record.source || IngestionSource.SEQUENTIAL,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			case RecordTypes.LPMintRedeemRecord: {
				const spotMarket = SPOT_MARKETS.find(
					(x) => x.marketIndex === record.spotMarketIndex
				);
				const tokenPrecision = spotMarket?.precision ?? QUOTE_PRECISION;

				const transformedRecord: LPMintRedeemRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					authority: record.authority,
					amount: bnStringToNumber(record.amount, tokenPrecision),
					fee: bnStringToNumber(record.fee, QUOTE_PRECISION),
					spotMarketIndex: record.spotMarketIndex,
					oraclePrice: bnStringToNumber(record.oraclePrice, PRICE_PRECISION),
					mint: record.mint,
					lpAmount: bnStringToNumber(record.lpAmount, QUOTE_PRECISION),
					lpFee: bnStringToNumber(record.lpFee, QUOTE_PRECISION),
					lpPrice: bnStringToNumber(record.lpPrice, PRICE_PRECISION),
					description: record.description,
					constituentIndex: record.constituentIndex,
					mintRedeemId: record.mintRedeemId,
					lastAum: bnStringToNumber(record.lastAum, QUOTE_PRECISION),
					lastAumSlot: bnStringToNumber(record.lastAumSlot),
					inMarketCurrentWeight: bnStringToNumber(
						record.inMarketCurrentWeight,
						PERCENTAGE_PRECISION
					),
					inMarketTargetWeight: bnStringToNumber(
						record.inMarketTargetWeight,
						PERCENTAGE_PRECISION
					),
					lpPool: record.lpPool,
					entity: EntityTypes.Authority,
					source: record.source || IngestionSource.SEQUENTIAL,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			case RecordTypes.FundingPaymentRecord: {
				const transformedRecord: FundingPaymentRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					userAuthority: record.userAuthority,
					user: record.user,
					marketIndex: record.marketIndex,
					fundingPayment: bnStringToNumber(record.fundingPayment, QUOTE_PRECISION),
					baseAssetAmount: bnStringToNumber(record.baseAssetAmount, BASE_PRECISION),
					userLastCumulativeFunding: bnStringToNumber(
						record.userLastCumulativeFunding,
						FUNDING_RATE_PRECISION
					),
					ammCumulativeFundingLong: bnStringToNumber(
						record.ammCumulativeFundingLong,
						FUNDING_RATE_PRECISION
					),
					ammCumulativeFundingShort: bnStringToNumber(
						record.ammCumulativeFundingShort,
						FUNDING_RATE_PRECISION
					),
					entity: EntityTypes.User,
					source: record.source || IngestionSource.SEQUENTIAL,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			case RecordTypes.InsuranceFundStakeRecord: {
				const spotMarket = SPOT_MARKETS.find(
					(x) => x.marketIndex === Number(record.marketIndex)
				);
				const symbol = spotMarket?.symbol ?? 'NA';
				const tokenPrecision = spotMarket?.precision ?? QUOTE_PRECISION;

				const baseRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					amount: bnStringToNumber(record.amount, tokenPrecision),
					userAuthority: record.userAuthority,
					action: record.action,
					marketIndex: record.marketIndex,
					ifSharesBefore: bnStringToNumber(record.ifSharesBefore, QUOTE_PRECISION),
					userIfSharesBefore: bnStringToNumber(
						record.userIfSharesBefore,
						QUOTE_PRECISION
					),
					totalIfSharesBefore: bnStringToNumber(
						record.totalIfSharesBefore,
						QUOTE_PRECISION
					),
					ifSharesAfter: bnStringToNumber(record.ifSharesAfter, QUOTE_PRECISION),
					userIfSharesAfter: bnStringToNumber(record.userIfSharesAfter, QUOTE_PRECISION),
					totalIfSharesAfter: bnStringToNumber(
						record.totalIfSharesAfter,
						QUOTE_PRECISION
					),
					insuranceVaultAmountBefore: bnStringToNumber(
						record.insuranceVaultAmountBefore,
						tokenPrecision
					),
					symbol,
					source: record.source || IngestionSource.SEQUENTIAL,
				};

				const records: InsuranceFundStakeRecord[] = [
					{
						...baseRecord,
						entity: EntityTypes.Authority,
					},
					{
						...baseRecord,
						entity: EntityTypes.Market,
					},
				];

				return records as TransformedRecord<T>;
			}

			case RecordTypes.InsuranceFundRecord: {
				const spotMarket = SPOT_MARKETS.find(
					(x) => x.marketIndex === record.spotMarketIndex
				);
				const symbol = spotMarket?.symbol ?? 'NA';
				const tokenPrecision = spotMarket?.precision ?? QUOTE_PRECISION;

				const transformedRecord: InsuranceFundRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					spotMarketIndex: record.spotMarketIndex,
					perpMarketIndex: record.perpMarketIndex,
					userIfFactor: record.userIfFactor,
					totalIfFactor: record.totalIfFactor,
					symbol,
					vaultAmountBefore: bnStringToNumber(record.vaultAmountBefore, tokenPrecision),
					insuranceVaultAmountBefore: bnStringToNumber(
						record.insuranceVaultAmountBefore,
						tokenPrecision
					),
					totalIfSharesBefore: bnStringToNumber(
						record.totalIfSharesBefore,
						QUOTE_PRECISION
					),
					totalIfSharesAfter: bnStringToNumber(
						record.totalIfSharesAfter,
						QUOTE_PRECISION
					),
					amount: bnStringToNumber(record.amount, tokenPrecision),
					entity: EntityTypes.Market,
					source: record.source || IngestionSource.SEQUENTIAL,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			case RecordTypes.FundingRateRecord: {
				const symbol =
					PERP_MARKETS.find((x) => x.marketIndex === record.marketIndex)?.symbol ?? 'NA';

				const transformedRecord: FundingRateRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					recordId: record.recordId,
					marketIndex: record.marketIndex,
					symbol,
					fundingRate: bnStringToNumber(record.fundingRate, FUNDING_RATE_PRECISION),
					fundingRateLong: bnStringToNumber(
						record.fundingRateLong,
						FUNDING_RATE_PRECISION
					),
					fundingRateShort: bnStringToNumber(
						record.fundingRateShort,
						FUNDING_RATE_PRECISION
					),
					cumulativeFundingRateLong: bnStringToNumber(
						record.cumulativeFundingRateLong,
						FUNDING_RATE_PRECISION
					),
					cumulativeFundingRateShort: bnStringToNumber(
						record.cumulativeFundingRateShort,
						FUNDING_RATE_PRECISION
					),
					oraclePriceTwap: bnStringToNumber(record.oraclePriceTwap, PRICE_PRECISION),
					markPriceTwap: bnStringToNumber(record.markPriceTwap, PRICE_PRECISION),
					periodRevenue: bnStringToNumber(record.periodRevenue, QUOTE_PRECISION),
					baseAssetAmountWithAmm: bnStringToNumber(
						record.baseAssetAmountWithAmm,
						BASE_PRECISION
					),
					baseAssetAmountWithUnsettledLp: bnStringToNumber(
						record.baseAssetAmountWithUnsettledLp,
						BASE_PRECISION
					),
					entity: EntityTypes.Market,
					source: record.source || IngestionSource.SEQUENTIAL,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			case RecordTypes.VaultDepositorRecord: {
				const spotMarket = SPOT_MARKETS.find(
					(x) => x.marketIndex === record.spotMarketIndex
				);
				const tokenPrecision = spotMarket?.precision;

				const transformedRecord: VaultDepositorRecord = {
					ts: bnStringToNumber(record.ts),
					txSig: record.txSig,
					txSigIndex: record.txSigIndex,
					slot: record.slot,
					vault: record.vault,
					depositorAuthority: record.depositorAuthority,
					action: record.action,
					spotMarketIndex: record.spotMarketIndex,
					amount: bnStringToNumber(record.amount, tokenPrecision),
					vaultSharesBefore: bnStringToNumber(record.vaultSharesBefore),
					vaultSharesAfter: bnStringToNumber(record.vaultSharesAfter),
					vaultEquityBefore: bnStringToNumber(record.vaultEquityBefore, tokenPrecision),
					userVaultSharesBefore: bnStringToNumber(record.userVaultSharesBefore),
					totalVaultSharesBefore: bnStringToNumber(record.totalVaultSharesBefore),
					userVaultSharesAfter: bnStringToNumber(record.userVaultSharesAfter),
					totalVaultSharesAfter: bnStringToNumber(record.totalVaultSharesAfter),
					profitShare: bnStringToNumber(record.profitShare, PERCENTAGE_PRECISION),
					managementFee: bnStringToNumber(record.managementFee, PERCENTAGE_PRECISION),
					managementFeeShares: bnStringToNumber(record.managementFeeShares),
					depositOraclePrice: bnStringToNumber(
						record.depositOraclePrice,
						PRICE_PRECISION
					),
					entity: EntityTypes.Authority,
					source: record.source || IngestionSource.SEQUENTIAL,
				};
				return [transformedRecord] as TransformedRecord<T>;
			}

			default:
				throw Error(`Cannot transform record: ${record.eventType}`);
		}
	};

	const destructureKey = (key: string) => {
		const eventType = key.match(/eventType=(\w+)/)?.[1];
		const year = key.match(/year=(\d{4})/)?.[1];
		const month = key.match(/month=(\d{2})/)?.[1];
		const day = key.match(/day=(\d{2})/)?.[1];

		const identifierMatch = key.match(/(user|userAuthority|market)=([^/]+)/);
		const identifierType = identifierMatch?.[1];
		const identifierValue = identifierMatch?.[2];

		return {
			[identifierType || 'id']: identifierValue,
			eventType: eventType as RecordTypes,
			year: year ? parseInt(year) : undefined,
			month: month ? parseInt(month) : undefined,
			day: day ? parseInt(day) : undefined,
		};
	};

	const getRecords = ({ content }: { content: string }) => {
		return content
			.trim()
			.split('\n')
			.filter((line) => line.trim() !== '')
			.map((line) => JSON.parse(line));
	};

	const flushLargeUserCache = () => {
		logger.info('Flushing the large user cache');
		largeUserCache = {};
	};

	return {
		sortRecords,
		getRecords,
		getUniqueRecords,
		processType,
		flushLargeUserCache,
		transformRecord,
		getRecordFileName,
		getRecordPathName,
		destructureKey,
		paginateAndUploadRecords,
	};
};
