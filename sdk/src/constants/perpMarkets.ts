import { OracleSource } from '../';
import { DriftEnv } from '../';
import { PublicKey } from '@solana/web3.js';

export type PerpMarketConfig = {
	fullName?: string;
	category?: string[];
	symbol: string;
	baseAssetSymbol: string;
	marketIndex: number;
	launchTs: number;
	oracle: PublicKey;
	oracleSource: OracleSource;
};

export const DevnetPerpMarkets: PerpMarketConfig[] = [
	{
		fullName: 'Solana',
		category: ['L1', 'Infra'],
		symbol: 'SOL-PERP',
		baseAssetSymbol: 'SOL',
		marketIndex: 0,
		oracle: new PublicKey('J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix'),
		launchTs: 1655751353000,
		oracleSource: OracleSource.PYTH,
	},
	{
		fullName: 'Bitcoin',
		category: ['L1', 'Payment'],
		symbol: 'BTC-PERP',
		baseAssetSymbol: 'BTC',
		marketIndex: 1,
		oracle: new PublicKey('HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J'),
		launchTs: 1655751353000,
		oracleSource: OracleSource.PYTH,
	},
	{
		fullName: 'Ethereum',
		category: ['L1', 'Infra'],
		symbol: 'ETH-PERP',
		baseAssetSymbol: 'ETH',
		marketIndex: 2,
		oracle: new PublicKey('EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw'),
		launchTs: 1637691133472,
		oracleSource: OracleSource.PYTH,
	},
];

export const MainnetMarkets: PerpMarketConfig[] = [];

export const PerpMarkets: { [key in DriftEnv]: PerpMarketConfig[] } = {
	devnet: DevnetPerpMarkets,
	'mainnet-beta': [],
};
