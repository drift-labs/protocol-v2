import BN from 'bn.js';

type Market = {
	symbol: string;
	baseAssetSymbol: string;
	marketIndex: BN;
};

const Markets: Market[] = [
	{
		symbol: 'SOL/USD',
		baseAssetSymbol: 'SOL',
		marketIndex: new BN(0),
	},
	{
		symbol: 'BTC/USD',
		baseAssetSymbol: 'BTC',
		marketIndex: new BN(1),
	},
	{
		symbol: 'SPY/USD',
		baseAssetSymbol: 'SPY',
		marketIndex: new BN(2),
	},
];

export default Markets;
