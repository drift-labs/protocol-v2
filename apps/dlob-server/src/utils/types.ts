import { AssetType, MarketTypeStr } from '@velocity-exchange/sdk';
import { TradeOffsetPrice } from '@velocity-exchange/common';

export type AuctionParamArgs = {
	// mandatory args
	marketIndex: number;
	marketType: MarketTypeStr;
	direction: 'long' | 'short';
	amount: string;
	assetType: AssetType;

	// optional settings args
	reduceOnly?: boolean;
	allowInfSlippage?: boolean;
	slippageTolerance?: number;
	isOracleOrder?: boolean;
	auctionDuration?: number;
	auctionStartPriceOffset?: number | 'marketBased';
	auctionEndPriceOffset?: number;
	auctionStartPriceOffsetFrom?: TradeOffsetPrice | 'marketBased';
	auctionEndPriceOffsetFrom?: TradeOffsetPrice;
	additionalEndPriceBuffer?: string;
	userOrderId?: number;
	forceUpToSlippage?: boolean;
	maxLeverageSelected?: boolean;
	maxLeverageOrderSize?: string;
};
