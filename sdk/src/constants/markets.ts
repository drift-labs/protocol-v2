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
		symbol: 'ETH/USD',
		baseAssetSymbol: 'ETH',
		marketIndex: new BN(2),
	},
	{
		symbol: 'COPE/USD',
		baseAssetSymbol: 'COPE',
		marketIndex: new BN(3),
	},
];

export default Markets;
