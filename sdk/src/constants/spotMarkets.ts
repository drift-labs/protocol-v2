import { PublicKey } from '@solana/web3.js';
import { BN, DriftEnv, OracleSource } from '../';
import {
	QUOTE_PRECISION,
	QUOTE_PRECISION_EXP,
	LAMPORTS_EXP,
	LAMPORTS_PRECISION,
	SIX,
	EIGHT,
	NINE,
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
	launchTs?: number;
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
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		serumMarket: new PublicKey('9Lyhks5bQQxb9EyyX55NtgKQzpM4WK7JCmeaWuQ5MoXD'),
	},
	{
		symbol: 'wBTC',
		marketIndex: 3,
		oracle: new PublicKey('GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'),
		precision: new BN(10).pow(EIGHT),
		precisionExp: EIGHT,
		serumMarket: new PublicKey('3BAKsQd3RuhZKES2DGysMhjBdwjZYKYmxRqnSMtZ4KSN'),
	},
	{
		symbol: 'wETH',
		marketIndex: 4,
		oracle: new PublicKey('JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'),
		precision: new BN(10).pow(EIGHT),
		precisionExp: EIGHT,
		serumMarket: new PublicKey('BbJgE7HZMaDp5NTYvRh5jZSkQPVDTU8ubPFtpogUkEj4'),
		phoenixMarket: new PublicKey(
			'Ew3vFDdtdGrknJAVVfraxCA37uNJtimXYPY4QjnfhFHH'
		),
	},
	{
		symbol: 'USDT',
		marketIndex: 5,
		oracle: new PublicKey('3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL'),
		oracleSource: OracleSource.PYTH_STABLE_COIN,
		mint: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
		precision: QUOTE_PRECISION,
		precisionExp: QUOTE_PRECISION_EXP,
		serumMarket: new PublicKey('B2na8Awyd7cpC59iEU43FagJAPLigr3AP3s38KM982bu'),
	},
	{
		symbol: 'jitoSOL',
		marketIndex: 6,
		oracle: new PublicKey('7yyaeuJ1GGtVBLT2z2xub5ZWYKaNhF28mj1RdV4VDFVk'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		serumMarket: new PublicKey('DkbVbMhFxswS32xnn1K2UY4aoBugXooBTxdzkWWDWRkH'),
	},
	{
		symbol: 'PYTH',
		marketIndex: 7,
		oracle: new PublicKey('nrYkQQQur7z8rYTST3G9GqATviK5SxTDkrqd21MW6Ue'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		serumMarket: new PublicKey('4E17F3BxtNVqzVsirxguuqkpYLtFgCR6NfTpccPh82WE'),
		phoenixMarket: new PublicKey(
			'2sTMN9A1D1qeZLF95XQgJCUPiKe5DiV52jLfZGqMP46m'
		),
	},
	{
		symbol: 'bSOL',
		marketIndex: 8,
		oracle: new PublicKey('AFrYBhb5wKQtxRS9UA9YRS4V3dwFm7SqmS6DHKq6YVgo'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		serumMarket: new PublicKey('ARjaHVxGCQfTvvKjLd7U7srvk6orthZSE6uqWchCczZc'),
	},
	{
		symbol: 'JTO',
		marketIndex: 9,
		oracle: new PublicKey('D8UUgr8a3aR3yUeHLu7v8FWK7E8Y5sSU7qrYBXUJXBQ5'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		serumMarket: new PublicKey('H87FfmHABiZLRGrDsXRZtqq25YpARzaokCzL1vMYGiep'),
		phoenixMarket: new PublicKey(
			'BRLLmdtPGuuFn3BU6orYw4KHaohAEptBToi3dwRUnHQZ'
		),
	},
	{
		symbol: 'WIF',
		marketIndex: 10,
		oracle: new PublicKey('6ABgrEZk8urs6kJ1JNdC1sspH5zKXRqxy8sg3ZG2cQps'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		serumMarket: new PublicKey('2BtDHBTCTUxvdur498ZEcMgimasaFrY5GzLv8wS8XgCb'),
		phoenixMarket: new PublicKey(
			'6ojSigXF7nDPyhFRgmn3V9ywhYseKF9J32ZrranMGVSX'
		),
	},
	{
		symbol: 'JUP',
		marketIndex: 11,
		oracle: new PublicKey('g6eRCbboSwK4tSWngn773RCMexr1APQr4uA9bGZBYfo'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		phoenixMarket: new PublicKey(
			'2pspvjWWaf3dNgt3jsgSzFCNvMGPb7t8FrEYvLGjvcCe'
		),
		launchTs: 1706731200000,
	},
];

export const SpotMarkets: { [key in DriftEnv]: SpotMarketConfig[] } = {
	devnet: DevnetSpotMarkets,
	'mainnet-beta': MainnetSpotMarkets,
};
