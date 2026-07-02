import { PublicKey } from '@solana/web3.js';
import {
	QUOTE_PRECISION,
	QUOTE_PRECISION_EXP,
	LAMPORTS_EXP,
	LAMPORTS_PRECISION,
	SIX,
} from './numericConstants';
import { OracleSource } from '../types';
import { BN } from '../isomorphic/anchor';
import { VelocityEnv } from '../config';

export type SpotMarketConfig = {
	symbol: string;
	marketIndex: number;
	poolId: number;
	oracle: PublicKey;
	mint: PublicKey;
	oracleSource: OracleSource;
	precision: BN;
	precisionExp: BN;
	launchTs?: number;
	pythFeedId?: string;
	pythLazerId?: number;
};

export const WRAPPED_SOL_MINT = new PublicKey(
	'So11111111111111111111111111111111111111112'
);

// Reflects what is actually deployed on devnet (per on-chain enumeration of
// State.numberOfSpotMarkets). Update when devnet adds/changes a spot market.
export const DevnetSpotMarkets: SpotMarketConfig[] = [
	{
		symbol: 'dUSDT',
		marketIndex: 0,
		poolId: 0,
		oracle: new PublicKey('Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4'),
		oracleSource: OracleSource.PYTH_LAZER_STABLE_COIN,
		mint: new PublicKey('GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		pythLazerId: 8,
	},
	{
		symbol: 'SOL',
		marketIndex: 1,
		poolId: 0,
		oracle: new PublicKey('2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV'),
		oracleSource: OracleSource.PYTH_LAZER,
		mint: WRAPPED_SOL_MINT,
		precision: LAMPORTS_PRECISION,
		precisionExp: LAMPORTS_EXP,
		pythLazerId: 6,
	},
];

// Relaunch set from deploy-scripts/params/relaunch-spot-markets.json (PR #188).
// Oracles are the velocity program's pyth_lazer PDAs:
// findProgramAddress(["pyth_lazer", u32le(lazerFeedId)], VELOCITY_PROGRAM_ID).
export const MainnetSpotMarkets: SpotMarketConfig[] = [
	{
		symbol: 'USDT',
		marketIndex: 0,
		poolId: 0,
		oracle: new PublicKey('Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4'),
		oracleSource: OracleSource.PYTH_LAZER_STABLE_COIN,
		mint: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
		precision: QUOTE_PRECISION,
		precisionExp: QUOTE_PRECISION_EXP,
		pythFeedId:
			'0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
		pythLazerId: 8,
	},
	{
		symbol: 'SOL',
		marketIndex: 1,
		poolId: 0,
		oracle: new PublicKey('2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV'),
		oracleSource: OracleSource.PYTH_LAZER,
		mint: WRAPPED_SOL_MINT,
		precision: LAMPORTS_PRECISION,
		precisionExp: LAMPORTS_EXP,
		pythFeedId:
			'0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
		pythLazerId: 6,
	},
];

export const SpotMarkets: { [key in VelocityEnv]: SpotMarketConfig[] } = {
	devnet: DevnetSpotMarkets,
	'mainnet-beta': MainnetSpotMarkets,
};
