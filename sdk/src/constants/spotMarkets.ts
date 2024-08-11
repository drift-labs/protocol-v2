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
	openbookMarket?: PublicKey;
	launchTs?: number;
	pythFeedId?: string;
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
		pythFeedId:
			'0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
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
		pythFeedId:
			'0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
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
		pythFeedId:
			'0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
	},
	{
		symbol: 'PYUSD',
		marketIndex: 3,
		oracle: new PublicKey('HpMoKp3TCd3QT4MWYUKk2zCBwmhr5Df45fB6wdxYqEeh'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('GLfF72ZCUnS6N9iDJw8kedHzd6WFVf3VbpwdKKy76FRk'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		pythFeedId:
			'0xc1da1b73d7f01e7ddd54b3766cf7fcd644395ad14f70aa706ec5384c59e76692',
	},
];

export const MainnetSpotMarkets: SpotMarketConfig[] = [
	{
		symbol: 'USDC',
		marketIndex: 0,
		oracle: new PublicKey('En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce'),
		oracleSource: OracleSource.PYTH_STABLE_COIN_PULL,
		mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
		precision: QUOTE_PRECISION,
		precisionExp: QUOTE_PRECISION_EXP,
		pythFeedId:
			'0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
	},
	{
		symbol: 'SOL',
		marketIndex: 1,
		oracle: new PublicKey('BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey(WRAPPED_SOL_MINT),
		precision: LAMPORTS_PRECISION,
		precisionExp: LAMPORTS_EXP,
		serumMarket: new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'),
		phoenixMarket: new PublicKey(
			'4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg'
		),
		pythFeedId:
			'0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
	},
	{
		symbol: 'mSOL',
		marketIndex: 2,
		oracle: new PublicKey('FAq7hqjn7FWGXKDwJHzsXGgBcydGTcK4kziJpAGWXjDb'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		serumMarket: new PublicKey('9Lyhks5bQQxb9EyyX55NtgKQzpM4WK7JCmeaWuQ5MoXD'),
		pythFeedId:
			'0xc2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4',
	},
	{
		symbol: 'wBTC',
		marketIndex: 3,
		oracle: new PublicKey('486kr3pmFPfTsS4aZgcsQ7kS4i9rjMsYYZup6HQNSTT4'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'),
		precision: new BN(10).pow(EIGHT),
		precisionExp: EIGHT,
		serumMarket: new PublicKey('3BAKsQd3RuhZKES2DGysMhjBdwjZYKYmxRqnSMtZ4KSN'),
		pythFeedId:
			'0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
	},
	{
		symbol: 'wETH',
		marketIndex: 4,
		oracle: new PublicKey('6bEp2MiyoiiiDxcVqE8rUHQWwHirXUXtKfAEATTVqNzT'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'),
		precision: new BN(10).pow(EIGHT),
		precisionExp: EIGHT,
		serumMarket: new PublicKey('BbJgE7HZMaDp5NTYvRh5jZSkQPVDTU8ubPFtpogUkEj4'),
		phoenixMarket: new PublicKey(
			'Ew3vFDdtdGrknJAVVfraxCA37uNJtimXYPY4QjnfhFHH'
		),
		pythFeedId:
			'0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
	},
	{
		symbol: 'USDT',
		marketIndex: 5,
		oracle: new PublicKey('BekJ3P5G3iFeC97sXHuKnUHofCFj9Sbo7uyF2fkKwvit'),
		oracleSource: OracleSource.PYTH_STABLE_COIN_PULL,
		mint: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
		precision: QUOTE_PRECISION,
		precisionExp: QUOTE_PRECISION_EXP,
		serumMarket: new PublicKey('B2na8Awyd7cpC59iEU43FagJAPLigr3AP3s38KM982bu'),
		pythFeedId:
			'0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
	},
	{
		symbol: 'jitoSOL',
		marketIndex: 6,
		oracle: new PublicKey('9QE1P5EfzthYDgoQ9oPeTByCEKaRJeZbVVqKJfgU9iau'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		serumMarket: new PublicKey('DkbVbMhFxswS32xnn1K2UY4aoBugXooBTxdzkWWDWRkH'),
		phoenixMarket: new PublicKey(
			'5LQLfGtqcC5rm2WuGxJf4tjqYmDjsQAbKo2AMLQ8KB7p'
		),
		pythFeedId:
			'0x67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb',
	},
	{
		symbol: 'PYTH',
		marketIndex: 7,
		oracle: new PublicKey('GqkCu7CbsPVz1H6W6AAHuReqbJckYG59TXz7Y5HDV7hr'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		serumMarket: new PublicKey('4E17F3BxtNVqzVsirxguuqkpYLtFgCR6NfTpccPh82WE'),
		phoenixMarket: new PublicKey(
			'2sTMN9A1D1qeZLF95XQgJCUPiKe5DiV52jLfZGqMP46m'
		),
		pythFeedId:
			'0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff',
	},
	{
		symbol: 'bSOL',
		marketIndex: 8,
		oracle: new PublicKey('BmDWPMsytWmYkh9n6o7m79eVshVYf2B5GVaqQ2EWKnGH'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		serumMarket: new PublicKey('ARjaHVxGCQfTvvKjLd7U7srvk6orthZSE6uqWchCczZc'),
		pythFeedId:
			'0x89875379e70f8fbadc17aef315adf3a8d5d160b811435537e03c97e8aac97d9c',
	},
	{
		symbol: 'JTO',
		marketIndex: 9,
		oracle: new PublicKey('Ffq6ACJ17NAgaxC6ocfMzVXL3K61qxB2xHg6WUawWPfP'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		serumMarket: new PublicKey('H87FfmHABiZLRGrDsXRZtqq25YpARzaokCzL1vMYGiep'),
		phoenixMarket: new PublicKey(
			'BRLLmdtPGuuFn3BU6orYw4KHaohAEptBToi3dwRUnHQZ'
		),
		pythFeedId:
			'0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2',
	},
	{
		symbol: 'WIF',
		marketIndex: 10,
		oracle: new PublicKey('6x6KfE7nY2xoLCRSMPT1u83wQ5fpGXoKNBqFjrCwzsCQ'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		serumMarket: new PublicKey('2BtDHBTCTUxvdur498ZEcMgimasaFrY5GzLv8wS8XgCb'),
		phoenixMarket: new PublicKey(
			'6ojSigXF7nDPyhFRgmn3V9ywhYseKF9J32ZrranMGVSX'
		),
		openbookMarket: new PublicKey(
			'CwGmEwYFo7u5D7vghGwtcCbRToWosytaZa3Ys3JAto6J'
		),
		pythFeedId:
			'0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
	},
	{
		symbol: 'JUP',
		marketIndex: 11,
		oracle: new PublicKey('AwqRpfJ36jnSZQykyL1jYY35mhMteeEAjh7o8LveRQin'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		phoenixMarket: new PublicKey(
			'2pspvjWWaf3dNgt3jsgSzFCNvMGPb7t8FrEYvLGjvcCe'
		),
		launchTs: 1706731200000,
		pythFeedId:
			'0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
	},
	{
		symbol: 'RENDER',
		marketIndex: 12,
		oracle: new PublicKey('8TQztfGcNjHGRusX4ejQQtPZs3Ypczt9jWF6pkgQMqUX'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'),
		precision: new BN(10).pow(EIGHT),
		precisionExp: EIGHT,
		serumMarket: new PublicKey('2m7ZLEKtxWF29727DSb5D91erpXPUY1bqhRWRC3wQX7u'),
		launchTs: 1708964021000,
		pythFeedId:
			'0x3d4a2bd9535be6ce8059d75eadeba507b043257321aa544717c56fa19b49e35d',
	},
	{
		symbol: 'W',
		marketIndex: 13,
		oracle: new PublicKey('4HbitGsdcFbtFotmYscikQFAAKJ3nYx4t7sV7fTvsk8U'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		phoenixMarket: new PublicKey(
			'8dFTCTAbtGuHsdDL8WEPrTU6pXFDrU1QSjBTutw8fwZk'
		),
		launchTs: 1712149014000,
		pythFeedId:
			'0xeff7446475e218517566ea99e72a4abec2e1bd8498b43b7d8331e29dcb059389',
	},
	{
		symbol: 'TNSR',
		marketIndex: 14,
		oracle: new PublicKey('13jpjpVyU5hGpjsZ4HzCcmBo85wze4N8Au7U6cC3GMip'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		phoenixMarket: new PublicKey(
			'AbJCZ9TAJiby5AY3cHcXS2gUdENC6mtsm6m7XpC2ZMvE'
		),
		launchTs: 1712593532000,
		pythFeedId:
			'0x05ecd4597cd48fe13d6cc3596c62af4f9675aee06e2e0b94c06d8bee2b659e05',
	},
	{
		symbol: 'DRIFT',
		marketIndex: 15,
		oracle: new PublicKey('23KmX7SNikmUr2axSCy6Zer7XPBnvmVcASALnDGqBVRR'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		phoenixMarket: new PublicKey(
			'8BV6rrWsUabnTDA3dE6A69oUDJAj3hMhtBHTJyXB7czp'
		),
		launchTs: 1715860800000,
		pythFeedId:
			'0x5c1690b27bb02446db17cdda13ccc2c1d609ad6d2ef5bf4983a85ea8b6f19d07',
	},
	{
		symbol: 'INF',
		marketIndex: 16,
		oracle: new PublicKey('B7RUYg2zF6UdUSHv2RmpnriPVJccYWojgFydNS1NY5F8'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		launchTs: 1716595200000,
		pythFeedId:
			'0xf51570985c642c49c2d6e50156390fdba80bb6d5f7fa389d2f012ced4f7d208f',
	},
	{
		symbol: 'dSOL',
		marketIndex: 17,
		oracle: new PublicKey('HJ9K9AamqVMp86j3uQgpA1tdJNRAwfVuL75FD9P3QBrn'),
		oracleSource: OracleSource.SWITCHBOARD,
		mint: new PublicKey('Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		launchTs: 1716595200000,
	},
	{
		symbol: 'USDY',
		marketIndex: 18,
		oracle: new PublicKey('BPTQgHV4y2x4jvKPPkkd9aS8jY7L3DGZBwjEZC8Vm27o'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		launchTs: 1718811089000,
		pythFeedId:
			'0xe393449f6aff8a4b6d3e1165a7c9ebec103685f3b41e60db4277b5b6d10e7326',
	},
	{
		symbol: 'JLP',
		marketIndex: 19,
		oracle: new PublicKey('5Mb11e5rt1Sp6A286B145E4TmgMzsM2UX9nCF2vas5bs'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		launchTs: 1719415157000,
	},
	{
		symbol: 'POPCAT',
		marketIndex: 20,
		oracle: new PublicKey('H3pn43tkNvsG5z3qzmERguSvKoyHZvvY6VPmNrJqiW5X'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		launchTs: 1720013054000,
		phoenixMarket: new PublicKey(
			'31XgvAQ1HgFQEk31KdszbPkVXKaQqB1bgYZPoDrFpSR2'
		),
		pythFeedId:
			'0xb9312a7ee50e189ef045aa3c7842e099b061bd9bdc99ac645956c3b660dc8cce',
	},
	{
		symbol: 'CLOUD',
		marketIndex: 21,
		oracle: new PublicKey('4FG7UyPkszGvcSVCCKaLSZsArGjyxitwhJeQhYu2bFTS'),
		oracleSource: OracleSource.SWITCHBOARD,
		mint: new PublicKey('CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		launchTs: 1721316817000,
	},
	{
		symbol: 'PYUSD',
		marketIndex: 22,
		oracle: new PublicKey('HpMoKp3TCd3QT4MWYUKk2zCBwmhr5Df45fB6wdxYqEeh'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'),
		precision: new BN(10).pow(SIX),
		precisionExp: SIX,
		pythFeedId:
			'0xc1da1b73d7f01e7ddd54b3766cf7fcd644395ad14f70aa706ec5384c59e76692',
	},
	{
		symbol: 'USDe',
		marketIndex: 23,
		oracle: new PublicKey('BXej5boX2nWudwAfZQedo212B9XJxhjTeeF3GbCwXmYa'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		pythFeedId:
			'0x6ec879b1e9963de5ee97e9c8710b742d6228252a5e2ca12d4ae81d7fe5ee8c5d',
	},
	{
		symbol: 'sUSDe',
		marketIndex: 24,
		oracle: new PublicKey('BRuNuzLAPHHGSSVAJPKMcmJMdgDfrekvnSxkxPDGdeqp'),
		oracleSource: OracleSource.PYTH_PULL,
		mint: new PublicKey('Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN'),
		precision: new BN(10).pow(NINE),
		precisionExp: NINE,
		pythFeedId:
			'0xca3ba9a619a4b3755c10ac7d5e760275aa95e9823d38a84fedd416856cdba37c',
	},
];

export const SpotMarkets: { [key in DriftEnv]: SpotMarketConfig[] } = {
	devnet: DevnetSpotMarkets,
	'mainnet-beta': MainnetSpotMarkets,
};
