import { PublicKey } from '@solana/web3.js';
import { BN, DriftEnv, OracleSource } from '../';
import {
	SPOT_MARKET_BALANCE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION_EXP,
	LAMPORTS_EXP,
	LAMPORTS_PRECISION,
} from './numericConstants';

export type SpotMarketConfig = {
	symbol: string;
	marketIndex: BN;
	oracle: PublicKey;
	mint: PublicKey;
	oracleSource: OracleSource;
	precision: BN;
	precisionExp: BN;
};

export const WRAPPED_SOL_MINT = new PublicKey(
	'So11111111111111111111111111111111111111112'
);

export const DevnetSpotMarkets: SpotMarketConfig[] = [
	{
		symbol: 'USDC',
		marketIndex: new BN(0),
		oracle: PublicKey.default,
		oracleSource: OracleSource.QUOTE_ASSET,
		mint: new PublicKey('8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2'),
		precision: SPOT_MARKET_BALANCE_PRECISION,
		precisionExp: SPOT_MARKET_BALANCE_PRECISION_EXP,
	},
	{
		symbol: 'SOL',
		marketIndex: new BN(1),
		oracle: new PublicKey('J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey(WRAPPED_SOL_MINT),
		precision: LAMPORTS_PRECISION,
		precisionExp: LAMPORTS_EXP,
	},
	{
		symbol: 'BTC',
		marketIndex: new BN(2),
		oracle: new PublicKey('HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('3BZPwbcqB5kKScF3TEXxwNfx5ipV13kbRVDvfVp5c6fv'),
		precision: SPOT_MARKET_BALANCE_PRECISION,
		precisionExp: SPOT_MARKET_BALANCE_PRECISION_EXP,
	},
];

export const MainnetSpotMarkets: SpotMarketConfig[] = [
	{
		symbol: 'USDC',
		marketIndex: new BN(0),
		oracle: PublicKey.default,
		oracleSource: OracleSource.QUOTE_ASSET,
		mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
		precision: SPOT_MARKET_BALANCE_PRECISION,
		precisionExp: SPOT_MARKET_BALANCE_PRECISION_EXP,
	},
];

export const SpotMarkets: { [key in DriftEnv]: SpotMarketConfig[] } = {
	devnet: DevnetSpotMarkets,
	'mainnet-beta': MainnetSpotMarkets,
};
