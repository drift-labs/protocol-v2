import {
	bnStringToNumber,
	DepositRecord,
	RecordTypes,
	SerializedMarketFilter,
	TradeRecord,
} from '@backend/common';
import {
	BASE_PRECISION,
	VelocityEnv,
	initialize,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
} from '@velocity-exchange/sdk';
import { AnalyticsDepositRecord, AnalyticsTradeRecord } from './analytics-types';

const driftEnv = (process.env.ENV || 'mainnet-beta') as VelocityEnv;
const { PERP_MARKETS, SPOT_MARKETS } = initialize({ env: driftEnv });

const getDateParts = (ts: number) => {
	const date = new Date(ts * 1000);
	const year = date.getUTCFullYear().toString();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');

	return {
		dt: `${year}-${month}-${day}`,
		year,
		month,
		day,
	};
};

const getSpotMarket = (marketIndex: number) =>
	SPOT_MARKETS.find((market) => market.marketIndex === Number(marketIndex));

const getPerpMarket = (marketIndex: number) =>
	PERP_MARKETS.find((market) => market.marketIndex === Number(marketIndex));

const getMarketSymbol = ({
	marketType,
	marketIndex,
	symbol,
}: {
	marketType?: string;
	marketIndex: number;
	symbol?: string;
}) => {
	if (marketType === SerializedMarketFilter.SPOT) {
		return getSpotMarket(marketIndex)?.symbol ?? symbol ?? String(marketIndex);
	}

	return getPerpMarket(marketIndex)?.symbol ?? symbol ?? String(marketIndex);
};

const getBasePrecision = ({
	marketType,
	marketIndex,
}: {
	marketType: string;
	marketIndex: number;
}) => {
	if (marketType === SerializedMarketFilter.SPOT) {
		return getSpotMarket(marketIndex)?.precision || BASE_PRECISION;
	}

	return BASE_PRECISION;
};

const parseIntField = (value: unknown) => Number(value ?? 0);

const parseNullableString = (value: unknown) => {
	if (value === null || value === undefined || value === '') {
		return undefined;
	}

	return String(value);
};

const parseBnField = (value: string | number | undefined, precision: number) =>
	bnStringToNumber(value?.toString() ?? '0', precision);

type SerializedRecord<
	TRecord,
	TOverrides extends Record<string, unknown>,
	TEventType extends RecordTypes,
> = Omit<TRecord, keyof TOverrides> &
	TOverrides & {
		eventType: TEventType;
	};

type RawTradeRecord = SerializedRecord<
	TradeRecord,
	{
		ts: string | number;
		fillerReward?: string | number;
		fillRecordId: string | number;
		baseAssetAmountFilled: string | number;
		quoteAssetAmountFilled: string | number;
		takerFee: string | number;
		makerFee: string | number;
		referrerReward: string | number;
		quoteAssetAmountSurplus: string | number;
		spotFulfillmentMethodFee: string | number;
		takerOrderId?: string | number;
		takerOrderBaseAssetAmount?: string | number;
		takerOrderCumulativeBaseAssetAmountFilled?: string | number;
		takerOrderCumulativeQuoteAssetAmountFilled?: string | number;
		makerOrderId?: string | number;
		makerOrderBaseAssetAmount?: string | number;
		makerOrderCumulativeBaseAssetAmountFilled?: string | number;
		makerOrderCumulativeQuoteAssetAmountFilled?: string | number;
		oraclePrice: string | number;
		takerExistingQuoteEntryAmount?: string | number;
		takerExistingBaseAssetAmount?: string | number;
		makerExistingQuoteEntryAmount?: string | number;
		makerExistingBaseAssetAmount?: string | number;
		triggerPrice?: string | number;
		builderIdx?: string | number | null;
		builderFee?: string | number;
	},
	RecordTypes.TradeRecord
>;

type RawDepositRecord = SerializedRecord<
	DepositRecord,
	{
		ts: string | number;
		depositRecordId: string | number;
		amount: string | number;
		oraclePrice: string | number;
		marketDepositBalance: string | number;
		marketWithdrawBalance: string | number;
		marketCumulativeDepositInterest: string | number;
		marketCumulativeBorrowInterest: string | number;
		totalDepositsAfter: string | number;
		totalWithdrawsAfter: string | number;
		transferUser?: string;
		signer?: string;
		userTokenAmountAfter?: string | number;
	},
	RecordTypes.DepositRecord
>;

export const transformTradeRecordToAnalytics = ({
	record,
	makerAuthority,
	takerAuthority,
}: {
	record: RawTradeRecord;
	makerAuthority?: string;
	takerAuthority?: string;
}): AnalyticsTradeRecord => {
	const ts = Number(record.ts);
	const basePrecision = getBasePrecision({
		marketType: record.marketType,
		marketIndex: record.marketIndex,
	});

	return {
		...getDateParts(ts),
		ts,
		action: record.action,
		actionexplanation: parseNullableString(record.actionExplanation),
		marketindex: Number(record.marketIndex),
		market: getMarketSymbol({
			marketType: record.marketType,
			marketIndex: Number(record.marketIndex),
			symbol: record.symbol,
		}),
		markettype: record.marketType,
		filler: parseNullableString(record.filler),
		fillerreward: parseBnField(record.fillerReward, QUOTE_PRECISION),
		fillrecordid: parseIntField(record.fillRecordId),
		baseassetamountfilled: parseBnField(record.baseAssetAmountFilled, basePrecision),
		quoteassetamountfilled: parseBnField(record.quoteAssetAmountFilled, QUOTE_PRECISION),
		takerfee: parseBnField(record.takerFee, QUOTE_PRECISION),
		makerfee: parseBnField(record.makerFee, QUOTE_PRECISION),
		referrerreward: parseBnField(record.referrerReward, QUOTE_PRECISION),
		quoteassetamountsurplus: parseBnField(record.quoteAssetAmountSurplus, QUOTE_PRECISION),
		spotfulfillmentmethodfee: parseBnField(record.spotFulfillmentMethodFee, QUOTE_PRECISION),
		taker: parseNullableString(record.taker),
		taker_authority: takerAuthority,
		takerorderid: parseIntField(record.takerOrderId),
		takerorderdirection: parseNullableString(record.takerOrderDirection),
		takerorderbaseassetamount: parseBnField(record.takerOrderBaseAssetAmount, basePrecision),
		takerordercumulativebaseassetamountfilled: parseBnField(
			record.takerOrderCumulativeBaseAssetAmountFilled,
			basePrecision
		),
		takerordercumulativequoteassetamountfilled: parseBnField(
			record.takerOrderCumulativeQuoteAssetAmountFilled,
			QUOTE_PRECISION
		),
		maker: parseNullableString(record.maker),
		maker_authority: makerAuthority,
		makerorderid: parseIntField(record.makerOrderId),
		makerorderdirection: parseNullableString(record.makerOrderDirection),
		makerorderbaseassetamount: parseBnField(record.makerOrderBaseAssetAmount, basePrecision),
		makerordercumulativebaseassetamountfilled: parseBnField(
			record.makerOrderCumulativeBaseAssetAmountFilled,
			basePrecision
		),
		makerordercumulativequoteassetamountfilled: parseBnField(
			record.makerOrderCumulativeQuoteAssetAmountFilled,
			QUOTE_PRECISION
		),
		oracleprice: parseBnField(record.oraclePrice, PRICE_PRECISION),
		txsig: record.txSig,
		slot: Number(record.slot),
		eventtype: 'TradeRecord',
		txsigindex: Number(record.txSigIndex),
		source: record.source,
		marketfilter: parseNullableString(record.marketFilter),
		bitflags: Number(record.bitFlags ?? 0),
		takerexistingquoteentryamount: parseBnField(
			record.takerExistingQuoteEntryAmount,
			QUOTE_PRECISION
		),
		takerexistingbaseassetamount: parseBnField(
			record.takerExistingBaseAssetAmount,
			basePrecision
		),
		makerexistingquoteentryamount: parseBnField(
			record.makerExistingQuoteEntryAmount,
			QUOTE_PRECISION
		),
		makerexistingbaseassetamount: parseBnField(
			record.makerExistingBaseAssetAmount,
			basePrecision
		),
		triggerprice: parseBnField(record.triggerPrice, PRICE_PRECISION),
		builderidx: parseNullableString(record.builderIdx),
		builderfee: parseBnField(record.builderFee, QUOTE_PRECISION),
	};
};

export const transformDepositRecordToAnalytics = ({
	record,
}: {
	record: RawDepositRecord;
}): AnalyticsDepositRecord => {
	const ts = Number(record.ts);
	const tokenPrecision = getSpotMarket(record.marketIndex)?.precision ?? QUOTE_PRECISION;

	return {
		...getDateParts(ts),
		ts,
		userauthority: record.userAuthority,
		user: record.user,
		direction: record.direction,
		depositrecordid: parseIntField(record.depositRecordId),
		amount: parseBnField(record.amount, tokenPrecision),
		marketindex: Number(record.marketIndex),
		market: getMarketSymbol({
			marketType: SerializedMarketFilter.SPOT,
			marketIndex: Number(record.marketIndex),
			symbol: record.symbol,
		}),
		oracleprice: parseBnField(record.oraclePrice, PRICE_PRECISION),
		marketdepositbalance: parseBnField(
			record.marketDepositBalance,
			SPOT_MARKET_BALANCE_PRECISION
		),
		marketwithdrawbalance: parseBnField(
			record.marketWithdrawBalance,
			SPOT_MARKET_BALANCE_PRECISION
		),
		marketcumulativedepositinterest: parseBnField(
			record.marketCumulativeDepositInterest,
			SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
		),
		marketcumulativeborrowinterest: parseBnField(
			record.marketCumulativeBorrowInterest,
			SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
		),
		totaldepositsafter: parseBnField(record.totalDepositsAfter, QUOTE_PRECISION),
		totalwithdrawsafter: parseBnField(record.totalWithdrawsAfter, QUOTE_PRECISION),
		explanation: record.explanation,
		transferuser: parseNullableString(record.transferUser),
		txsig: record.txSig,
		slot: Number(record.slot),
		eventtype: 'DepositRecord',
		txsigindex: Number(record.txSigIndex),
		source: record.source,
		signer: parseNullableString(record.signer),
		usertokenamountafter: parseBnField(record.userTokenAmountAfter, tokenPrecision),
	};
};

export const isSupportedAnalyticsEventType = (eventType: string) =>
	eventType === RecordTypes.TradeRecord || eventType === RecordTypes.DepositRecord;
