import { PublicKey } from '@solana/web3.js';
import { MarketStatus, OracleSource } from '../types';
import { VelocityEnv } from '../config';

export type PerpMarketConfig = {
	fullName?: string;
	category?: string[];
	symbol: string;
	baseAssetSymbol: string;
	marketIndex: number;
	launchTs: number;
	oracle: PublicKey;
	oracleSource: OracleSource;
	pythFeedId?: string;
	pythLazerId?: number;
	marketStatus?: MarketStatus;
};

// Reflects what is actually deployed on devnet (per on-chain enumeration of
// State.numberOfMarkets). Update when devnet adds/changes a perp market.
export const DevnetPerpMarkets: PerpMarketConfig[] = [
	{
		fullName: 'Solana',
		category: ['L1', 'Infra'],
		symbol: 'SOL-PERP',
		baseAssetSymbol: 'SOL',
		marketIndex: 0,
		oracle: new PublicKey('2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV'),
		launchTs: 1655751353000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythLazerId: 6,
	},
];

// Relaunch set from deploy-scripts/params/relaunch-perp-markets.json (PR #188).
// Oracles are the velocity program's pyth_lazer PDAs:
// findProgramAddress(["pyth_lazer", u32le(lazerFeedId)], VELOCITY_PROGRAM_ID).
// launchTs = planned 2026-07 mainnet relaunch init.
export const MainnetPerpMarkets: PerpMarketConfig[] = [
	{
		fullName: 'Solana',
		category: ['L1', 'Infra', 'Solana'],
		symbol: 'SOL-PERP',
		baseAssetSymbol: 'SOL',
		marketIndex: 0,
		oracle: new PublicKey('2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV'),
		launchTs: 1782950400000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
		pythLazerId: 6,
	},
	{
		fullName: 'Bitcoin',
		category: ['L1', 'Payment'],
		symbol: 'BTC-PERP',
		baseAssetSymbol: 'BTC',
		marketIndex: 1,
		oracle: new PublicKey('J7Fp8iTKuKdCM7PnzqHXTdTo5Jr7ykAmiDyvpz58GJGZ'),
		launchTs: 1782950400000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
		pythLazerId: 1,
	},
	{
		fullName: 'Ethereum',
		category: ['L1', 'Infra'],
		symbol: 'ETH-PERP',
		baseAssetSymbol: 'ETH',
		marketIndex: 2,
		oracle: new PublicKey('6wQ5RiQ7usJ3TqYZSiuAPZHrVCeSWNrvace84khDKEmH'),
		launchTs: 1782950400000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
		pythLazerId: 2,
	},
	{
		fullName: 'Hyperliquid',
		category: ['DEX'],
		symbol: 'HYPE-PERP',
		baseAssetSymbol: 'HYPE',
		marketIndex: 3,
		oracle: new PublicKey('Nc9hadTxNbLw6SiYVGVGjp4WZjanWUuNiKSxdHwHNtK'),
		launchTs: 1782950400000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b',
		pythLazerId: 110,
	},
];

export const PerpMarkets: { [key in VelocityEnv]: PerpMarketConfig[] } = {
	devnet: DevnetPerpMarkets,
	'mainnet-beta': MainnetPerpMarkets,
};
