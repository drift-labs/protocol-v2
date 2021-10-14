import BN from 'bn.js';

type Market = {
	symbol: string;
	baseAssetSymbol: string;
	marketIndex: BN;
	devnetPythOracle: string;
	mainnetPythOracle: string;
};

const Markets: Market[] = [
	{
		symbol: 'SOL/USD',
		baseAssetSymbol: 'SOL',
		marketIndex: new BN(0),
		devnetPythOracle: 'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix',
		mainnetPythOracle: 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG',
	},
	// {
	// 	symbol: 'BTC/USD',
	// 	baseAssetSymbol: 'BTC',
	// 	marketIndex: new BN(1),
	// 	devnetPythOracle: 'HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J',
	// 	mainnetPythOracle: 'GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU',
	// },
	// {
	// 	symbol: 'ETH/USD',
	// 	baseAssetSymbol: 'ETH',
	// 	marketIndex: new BN(2),
	// 	devnetPythOracle: 'EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw',
	// 	mainnetPythOracle: 'JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB',
	// },
	// {
	// 	symbol: 'COPE/USD',
	// 	baseAssetSymbol: 'COPE',
	// 	marketIndex: new BN(3),
	// 	devnetPythOracle: 'BAXDJUXtz6P5ARhHH1aPwgv4WENzHwzyhmLYK4daFwiM',
	// 	mainnetPythOracle: '9xYBiDWYsh2fHzpsz3aaCnNHCKWBNtfEDLtU6kS4aFD9',
	// },
];

export default Markets;
