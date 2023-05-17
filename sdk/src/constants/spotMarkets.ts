import { PublicKey } from '@solana/web3.js';
import { BN, DriftEnv, OracleSource } from '../';
import {
	QUOTE_PRECISION,
	QUOTE_PRECISION_EXP,
	LAMPORTS_EXP,
	LAMPORTS_PRECISION,
	SIX,
} from './numericConstants';

export type SpotMarketConfig = {
	symbol: string;
	marketIndex: number;
	oracle: PublicKey;
	mint: PublicKey;
	oracleSource: OracleSource;
	precision: BN;
	precisionExp: BN;
	serumMarket?: PublicKey;
	phoenixMarket?: PublicKey;
};

export const WRAPPED_SOL_MINT = new PublicKey(
	'So11111111111111111111111111111111111111112'
);

export const DevnetSpotMarkets: SpotMarketConfig[] = [
	{
		symbol: 'USDC',
		marketIndex: 0,
		oracle: new PublicKey('5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7'),
		oracleSource: OracleSource.PYTH_STABLE_COIN,
		mint: new PublicKey('8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
	},
	{
		symbol: 'SOL',
		marketIndex: 1,
		oracle: new PublicKey('J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey(WRAPPED_SOL_MINT),
		precision: LAMPORTS_PRECISION,
		precisionExp: LAMPORTS_EXP,
		serumMarket: new PublicKey('8N37SsnTu8RYxtjrV9SStjkkwVhmU8aCWhLvwduAPEKW'),
		phoenixMarket: new PublicKey(
			'78ehDnHgbkFxqXZwdFxa8HK7saX58GymeX2wNGdkqYLp'
		),
	},
	{
		symbol: 'BTC',
		marketIndex: 2,
		oracle: new PublicKey('HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('3BZPwbcqB5kKScF3TEXxwNfx5ipV13kbRVDvfVp5c6fv'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		serumMarket: new PublicKey('AGsmbVu3MS9u68GEYABWosQQCZwmLcBHu4pWEuBYH7Za'),
	},
	{
		symbol: 'mSOL',
		marketIndex: 3,
		oracle: new PublicKey('9a6RNx3tCu1TSs6TBSfV2XRXEPEZXQ6WB7jRojZRvyeZ'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		// serumMarket: new PublicKey('AGsmbVu3MS9u68GEYABWosQQCZwmLcBHu4pWEuBYH7Za'), TODO
	},
];

export const MainnetSpotMarkets: SpotMarketConfig[] = [
	{
		symbol: 'USDC',
		marketIndex: 0,
		oracle: new PublicKey('Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD'),
		oracleSource: OracleSource.PYTH_STABLE_COIN,
		mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
		precision: QUOTE_PRECISION,
		precisionExp: QUOTE_PRECISION_EXP,
	},
	{
		symbol: 'SOL',
		marketIndex: 1,
		oracle: new PublicKey('H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey(WRAPPED_SOL_MINT),
		precision: LAMPORTS_PRECISION,
		precisionExp: LAMPORTS_EXP,
		serumMarket: new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'),
		phoenixMarket: new PublicKey(
			'4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg'
		),
	},
	{
		symbol: 'mSOL',
		marketIndex: 2,
		oracle: new PublicKey('E4v1BBgoso9s64TQvmyownAVJbhbEPGyzA3qn4n46qj9'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		serumMarket: new PublicKey('9Lyhks5bQQxb9EyyX55NtgKQzpM4WK7JCmeaWuQ5MoXD'),
	},
];

export const SpotMarkets: { [key in DriftEnv]: SpotMarketConfig[] } = {
	devnet: DevnetSpotMarkets,
	'mainnet-beta': MainnetSpotMarkets,
};
