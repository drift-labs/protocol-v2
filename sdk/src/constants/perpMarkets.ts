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
	pythFeedId?: string;
	pythLazerId?: number;
};

export const DevnetPerpMarkets: PerpMarketConfig[] = [
	{
		fullName: 'Solana',
		category: ['L1', 'Infra'],
		symbol: 'SOL-PERP',
		baseAssetSymbol: 'SOL',
		marketIndex: 0,
		oracle: new PublicKey('3m6i4RFWEDw2Ft4tFHPJtYgmpPe21k56M3FHeWYrgGBz'),
		launchTs: 1655751353000,
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
		oracle: new PublicKey('35MbvS1Juz2wf7GsyHrkCw8yfKciRLxVpEhfZDZFrB4R'),
		launchTs: 1655751353000,
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
		oracle: new PublicKey('93FG52TzNKCnMiasV14Ba34BYcHDb9p4zK4GjZnLwqWR'),
		launchTs: 1637691133472,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
		pythLazerId: 2,
	},
	{
		fullName: 'Aptos',
		category: ['L1', 'Infra'],
		symbol: 'APT-PERP',
		baseAssetSymbol: 'APT',
		marketIndex: 3,
		oracle: new PublicKey('79EWaCYU9jiQN8SbvVzGFAhAncUZYp3PjNg7KxmN5cLE'),
		launchTs: 1675610186000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x03ae4db29ed4ae33d323568895aa00337e658e348b37509f5372ae51f0af00d5',
		pythLazerId: 28,
	},
	{
		fullName: 'Bonk',
		category: ['Meme', 'Dog'],
		symbol: '1MBONK-PERP',
		baseAssetSymbol: '1MBONK',
		marketIndex: 4,
		oracle: new PublicKey('GojbSnJuPdKDT1ZuHuAM5t9oz6bxTo1xhUKpTua2F72p'),
		launchTs: 1677068931000,
		oracleSource: OracleSource.PYTH_1M_PULL,
		pythFeedId:
			'0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
		pythLazerId: 9,
	},
	{
		fullName: 'Polygon',
		category: ['L2', 'Infra'],
		symbol: 'POL-PERP',
		baseAssetSymbol: 'POL',
		marketIndex: 5,
		oracle: new PublicKey('BrzyDgwELy4jjjsqLQpBeUxzrsueYyMhuWpYBaUYcXvi'),
		launchTs: 1677690149000, //todo
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xffd11c5a1cfd42f80afb2df4d9f264c15f956d68153335374ec10722edd70472',
		pythLazerId: 32,
	},
	{
		fullName: 'Arbitrum',
		category: ['L2', 'Infra'],
		symbol: 'ARB-PERP',
		baseAssetSymbol: 'ARB',
		marketIndex: 6,
		oracle: new PublicKey('8ocfAdqVRnzvfdubQaTxar4Kz5HJhNbPNmkLxswqiHUD'),
		launchTs: 1679501812000, //todo
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5',
		pythLazerId: 37,
	},
	{
		fullName: 'Doge',
		category: ['Meme', 'Dog'],
		symbol: 'DOGE-PERP',
		baseAssetSymbol: 'DOGE',
		marketIndex: 7,
		oracle: new PublicKey('23y63pHVwKfYSCDFdiGRaGbTYWoyr8UzhUE7zukyf6gK'),
		launchTs: 1680808053000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
		pythLazerId: 13,
	},
	{
		fullName: 'Binance Coin',
		category: ['Exchange'],
		symbol: 'BNB-PERP',
		baseAssetSymbol: 'BNB',
		marketIndex: 8,
		oracle: new PublicKey('Dk8eWjuQHMbxJAwB9Sg7pXQPH4kgbg8qZGcUrWcD9gTm'),
		launchTs: 1680808053000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
		pythLazerId: 15,
	},
	{
		fullName: 'Sui',
		category: ['L1'],
		symbol: 'SUI-PERP',
		baseAssetSymbol: 'SUI',
		marketIndex: 9,
		oracle: new PublicKey('HBordkz5YxjzNURmKUY4vfEYFG9fZyZNeNF1VDLMoemT'),
		launchTs: 1683125906000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
		pythLazerId: 11,
	},
	{
		fullName: 'Pepe',
		category: ['Meme'],
		symbol: '1MPEPE-PERP',
		baseAssetSymbol: '1MPEPE',
		marketIndex: 10,
		oracle: new PublicKey('CLxofhtzvLiErpn25wvUzpZXEqBhuZ6WMEckEraxyuGt'),
		launchTs: 1683781239000,
		oracleSource: OracleSource.PYTH_1M_PULL,
		pythFeedId:
			'0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4',
		pythLazerId: 4,
	},
	{
		fullName: 'OP',
		category: ['L2', 'Infra'],
		symbol: 'OP-PERP',
		baseAssetSymbol: 'OP',
		marketIndex: 11,
		oracle: new PublicKey('C9Zi2Y3Mt6Zt6pcFvobN3N29HcrzKujPAPBDDTDRcUa2'),
		launchTs: 1686091480000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x385f64d993f7b77d8182ed5003d97c60aa3361f3cecfe711544d2d59165e9bdf',
		pythLazerId: 41,
	},
	{
		fullName: 'RENDER',
		category: ['Infra'],
		symbol: 'RENDER-PERP',
		baseAssetSymbol: 'RENDER',
		marketIndex: 12,
		oracle: new PublicKey('8TQztfGcNjHGRusX4ejQQtPZs3Ypczt9jWF6pkgQMqUX'),
		launchTs: 1687201081000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x3d4a2bd9535be6ce8059d75eadeba507b043257321aa544717c56fa19b49e35d',
		pythLazerId: 34,
	},
	{
		fullName: 'XRP',
		category: ['Payments'],
		symbol: 'XRP-PERP',
		baseAssetSymbol: 'XRP',
		marketIndex: 13,
		oracle: new PublicKey('9757epAjXWCWQH98kyK9vzgehd1XDVEf7joNHUaKk3iV'),
		launchTs: 1689270550000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
		pythLazerId: 14,
	},
	{
		fullName: 'HNT',
		category: ['IoT'],
		symbol: 'HNT-PERP',
		baseAssetSymbol: 'HNT',
		marketIndex: 14,
		oracle: new PublicKey('9b1rcK9RUPK2vAqwNYCYEG34gUVpS2WGs2YCZZy2X5Tb'),
		launchTs: 1692294955000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x649fdd7ec08e8e2a20f425729854e90293dcbe2376abc47197a14da6ff339756',
	},
	{
		fullName: 'INJ',
		category: ['L1', 'Exchange'],
		symbol: 'INJ-PERP',
		baseAssetSymbol: 'INJ',
		marketIndex: 15,
		oracle: new PublicKey('BfXcyDWJmYADa5eZD7gySSDd6giqgjvm7xsAhQ239SUD'),
		launchTs: 1698074659000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592',
		pythLazerId: 46,
	},
	{
		fullName: 'LINK',
		category: ['Oracle'],
		symbol: 'LINK-PERP',
		baseAssetSymbol: 'LINK',
		marketIndex: 16,
		oracle: new PublicKey('Gwvob7yoLMgQRVWjScCRyQFMsgpRKrSAYisYEyjDJwEp'),
		launchTs: 1698074659000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
		pythLazerId: 19,
	},
	{
		fullName: 'Rollbit',
		category: ['Exchange'],
		symbol: 'RLB-PERP',
		baseAssetSymbol: 'RLB',
		marketIndex: 17,
		oracle: new PublicKey('4CyhPqyVK3UQHFWhEpk91Aw4WbBsN3JtyosXH6zjoRqG'),
		launchTs: 1699265968000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x2f2d17abbc1e781bd87b4a5d52c8b2856886f5c482fa3593cebf6795040ab0b6',
	},
	{
		fullName: 'Pyth',
		category: ['Oracle'],
		symbol: 'PYTH-PERP',
		baseAssetSymbol: 'PYTH',
		marketIndex: 18,
		oracle: new PublicKey('GqkCu7CbsPVz1H6W6AAHuReqbJckYG59TXz7Y5HDV7hr'),
		launchTs: 1700542800000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff',
		pythLazerId: 3,
	},
	{
		fullName: 'Celestia',
		category: ['Data'],
		symbol: 'TIA-PERP',
		baseAssetSymbol: 'TIA',
		marketIndex: 19,
		oracle: new PublicKey('C6LHPUrgjrgo5eNUitC8raNEdEttfoRhmqdJ3BHVBJhi'),
		launchTs: 1701880540000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x09f7c1d7dfbb7df2b8fe3d3d87ee94a2259d212da4f30c1f0540d066dfa44723',
		pythLazerId: 48,
	},
	{
		fullName: 'Jito',
		category: ['MEV'],
		symbol: 'JTO-PERP',
		baseAssetSymbol: 'JTO',
		marketIndex: 20,
		oracle: new PublicKey('Ffq6ACJ17NAgaxC6ocfMzVXL3K61qxB2xHg6WUawWPfP'),
		launchTs: 1701967240000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2',
		pythLazerId: 91,
	},
	{
		fullName: 'SEI',
		category: ['L1'],
		symbol: 'SEI-PERP',
		baseAssetSymbol: 'SEI',
		marketIndex: 21,
		oracle: new PublicKey('EVyoxFo5jWpv1vV7p6KVjDWwVqtTqvrZ4JMFkieVkVsD'),
		launchTs: 1703173331000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x53614f1cb0c031d4af66c04cb9c756234adad0e1cee85303795091499a4084eb',
		pythLazerId: 51,
	},
	{
		fullName: 'AVAX',
		category: ['Rollup', 'Infra'],
		symbol: 'AVAX-PERP',
		baseAssetSymbol: 'AVAX',
		marketIndex: 22,
		oracle: new PublicKey('FgBGHNex4urrBmNbSj8ntNQDGqeHcWewKtkvL6JE6dEX'),
		launchTs: 1704209558000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7',
		pythLazerId: 18,
	},
	{
		fullName: 'Wormhole',
		category: ['Bridge'],
		symbol: 'W-PERP',
		baseAssetSymbol: 'W',
		marketIndex: 23,
		oracle: new PublicKey('J9nrFWjDUeDVZ4BhhxsbQXWgLcLEgQyNBrCbwSADmJdr'),
		launchTs: 1709852537000,
		oracleSource: OracleSource.SWITCHBOARD_ON_DEMAND,
		pythFeedId:
			'0xeff7446475e218517566ea99e72a4abec2e1bd8498b43b7d8331e29dcb059389',
		pythLazerId: 102,
	},
	{
		fullName: 'Kamino',
		category: ['Lending'],
		symbol: 'KMNO-PERP',
		baseAssetSymbol: 'KMNO',
		marketIndex: 24,
		oracle: new PublicKey('7aqj2wH1BH8XT3QQ3MWtvt3My7RAGf5Stm3vx5fiysJz'),
		launchTs: 1711475936000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xb17e5bc5de742a8a378b54c9c75442b7d51e30ada63f28d9bd28d3c0e26511a0',
	},
	{
		fullName: 'Wen',
		category: ['Solana', 'Meme'],
		symbol: '1KWEN-PERP',
		baseAssetSymbol: '1KWEN',
		marketIndex: 25,
		oracle: new PublicKey('F47c7aJgYkfKXQ9gzrJaEpsNwUKHprysregTWXrtYLFp'),
		launchTs: 1720572064000,
		oracleSource: OracleSource.PYTH_1K_PULL,
		pythFeedId:
			'0x5169491cd7e2a44c98353b779d5eb612e4ac32e073f5cc534303d86307c2f1bc',
	},
	{
		fullName: 'TRUMP-WIN-2024',
		category: ['Prediction', 'Election'],
		symbol: 'TRUMP-WIN-2024-PREDICT',
		baseAssetSymbol: 'TRUMP-WIN-2024',
		marketIndex: 26,
		oracle: new PublicKey('3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA'),
		launchTs: 1722214583000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'KAMALA-POPULAR-VOTE-2024',
		category: ['Prediction', 'Election'],
		symbol: 'KAMALA-POPULAR-VOTE-2024-PREDICT',
		baseAssetSymbol: 'KAMALA-POPULAR-VOTE',
		marketIndex: 27,
		oracle: new PublicKey('GU6CA7a2KCyhpfqZNb36UAfc9uzKBM8jHjGdt245QhYX'),
		launchTs: 1722214583000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'RANDOM-2024',
		category: ['Prediction'],
		symbol: 'RANDOM-2024-PREDICT',
		baseAssetSymbol: 'RANDOM-2024',
		marketIndex: 28,
		oracle: new PublicKey('sDAQaZQJQ4RXAxH3x526mbEXyQZT15ktkL84d7hmk7M'),
		launchTs: 1729622442000,
		oracleSource: OracleSource.Prelaunch,
	},
];

export const MainnetPerpMarkets: PerpMarketConfig[] = [
	{
		fullName: 'Solana',
		category: ['L1', 'Infra', 'Solana'],
		symbol: 'SOL-PERP',
		baseAssetSymbol: 'SOL',
		marketIndex: 0,
		oracle: new PublicKey('BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF'),
		launchTs: 1667560505000,
		oracleSource: OracleSource.PYTH_PULL,
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
		oracle: new PublicKey('486kr3pmFPfTsS4aZgcsQ7kS4i9rjMsYYZup6HQNSTT4'),
		launchTs: 1670347281000,
		oracleSource: OracleSource.PYTH_PULL,
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
		oracle: new PublicKey('6bEp2MiyoiiiDxcVqE8rUHQWwHirXUXtKfAEATTVqNzT'),
		launchTs: 1670347281000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
		pythLazerId: 2,
	},
	{
		fullName: 'Aptos',
		category: ['L1', 'Infra'],
		symbol: 'APT-PERP',
		baseAssetSymbol: 'APT',
		marketIndex: 3,
		oracle: new PublicKey('CXZhzKePYajrZgZyrzgvHYFKK3c5tNgDrRobAgySo8Nb'),
		launchTs: 1675802661000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x03ae4db29ed4ae33d323568895aa00337e658e348b37509f5372ae51f0af00d5',
		pythLazerId: 28,
	},
	{
		fullName: 'Bonk',
		category: ['Meme', 'Solana'],
		symbol: '1MBONK-PERP',
		baseAssetSymbol: '1MBONK',
		marketIndex: 4,
		oracle: new PublicKey('GojbSnJuPdKDT1ZuHuAM5t9oz6bxTo1xhUKpTua2F72p'),
		launchTs: 1677690149000,
		oracleSource: OracleSource.PYTH_1M_PULL,
		pythFeedId:
			'0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
		pythLazerId: 9,
	},
	{
		fullName: 'Polygon',
		category: ['L2', 'Infra'],
		symbol: 'POL-PERP',
		baseAssetSymbol: 'POL',
		marketIndex: 5,
		oracle: new PublicKey('HDveCibToLf157NtUqShCEWX3GcF4Aq8Ngt2bst1s1cc'),
		launchTs: 1677690149000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xffd11c5a1cfd42f80afb2df4d9f264c15f956d68153335374ec10722edd70472',
		pythLazerId: 32,
	},
	{
		fullName: 'Arbitrum',
		category: ['L2', 'Infra'],
		symbol: 'ARB-PERP',
		baseAssetSymbol: 'ARB',
		marketIndex: 6,
		oracle: new PublicKey('5DYEjGpr28q3EsLKAnLXiDq6UeaFgDFZ5Gdwgp5RmPAp'),
		launchTs: 1679501812000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5',
		pythLazerId: 37,
	},
	{
		fullName: 'Doge',
		category: ['Meme', 'Dog'],
		symbol: 'DOGE-PERP',
		baseAssetSymbol: 'DOGE',
		marketIndex: 7,
		oracle: new PublicKey('23y63pHVwKfYSCDFdiGRaGbTYWoyr8UzhUE7zukyf6gK'),
		launchTs: 1680808053000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
		pythLazerId: 13,
	},
	{
		fullName: 'Binance Coin',
		category: ['Exchange'],
		symbol: 'BNB-PERP',
		baseAssetSymbol: 'BNB',
		marketIndex: 8,
		oracle: new PublicKey('A9J2j1pRB2aPqAbjUTtKy94niSCTuPUrpimfzvpZHKG1'),
		launchTs: 1680808053000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
		pythLazerId: 15,
	},
	{
		fullName: 'Sui',
		category: ['L1'],
		symbol: 'SUI-PERP',
		baseAssetSymbol: 'SUI',
		marketIndex: 9,
		oracle: new PublicKey('HmeJeBKgceqvSBd5XBXZUYECLabnbS1SefLkeJKH8ERK'),
		launchTs: 1683125906000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
		pythLazerId: 11,
	},
	{
		fullName: 'Pepe',
		category: ['Meme'],
		symbol: '1MPEPE-PERP',
		baseAssetSymbol: '1MPEPE',
		marketIndex: 10,
		oracle: new PublicKey('Eo8x9Y1289GvsuYVwRS2R8HfiWRXxYofL1KYvHK2ZM2o'),
		launchTs: 1683781239000,
		oracleSource: OracleSource.PYTH_LAZER_1M,
		pythFeedId:
			'0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4',
		pythLazerId: 4,
	},
	{
		fullName: 'OP',
		category: ['L2', 'Infra'],
		symbol: 'OP-PERP',
		baseAssetSymbol: 'OP',
		marketIndex: 11,
		oracle: new PublicKey('7GPbmQee2T4jMsJg99GuzWyMuzr8c2Uk7rAR9qvvQkzf'),
		launchTs: 1686091480000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x385f64d993f7b77d8182ed5003d97c60aa3361f3cecfe711544d2d59165e9bdf',
		pythLazerId: 41,
	},
	{
		fullName: 'RENDER',
		category: ['Infra', 'Solana'],
		symbol: 'RENDER-PERP',
		baseAssetSymbol: 'RENDER',
		marketIndex: 12,
		oracle: new PublicKey('97EqsAGbTnShB7oYWAFFCVVAx8PWXgDYDhcpm99izNQ4'),
		launchTs: 1687201081000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x3d4a2bd9535be6ce8059d75eadeba507b043257321aa544717c56fa19b49e35d',
		pythLazerId: 34,
	},
	{
		fullName: 'XRP',
		category: ['Payments'],
		symbol: 'XRP-PERP',
		baseAssetSymbol: 'XRP',
		marketIndex: 13,
		oracle: new PublicKey('92VexDMsSzYvVq7eiEoodEzZxCLqYnfGKpVTqpkX12FY'),
		launchTs: 1689270550000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
		pythLazerId: 14,
	},
	{
		fullName: 'HNT',
		category: ['IoT', 'Solana'],
		symbol: 'HNT-PERP',
		baseAssetSymbol: 'HNT',
		marketIndex: 14,
		oracle: new PublicKey('9b1rcK9RUPK2vAqwNYCYEG34gUVpS2WGs2YCZZy2X5Tb'),
		launchTs: 1692294955000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x649fdd7ec08e8e2a20f425729854e90293dcbe2376abc47197a14da6ff339756',
	},
	{
		fullName: 'INJ',
		category: ['L1', 'Exchange'],
		symbol: 'INJ-PERP',
		baseAssetSymbol: 'INJ',
		marketIndex: 15,
		oracle: new PublicKey('Ac442xcU276nb6gJFUCsNYAwAo6KWuw4xocxmG3nvDym'),
		launchTs: 1698074659000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592',
		pythLazerId: 46,
	},
	{
		fullName: 'LINK',
		category: ['Oracle'],
		symbol: 'LINK-PERP',
		baseAssetSymbol: 'LINK',
		marketIndex: 16,
		oracle: new PublicKey('rwyPmfH5xsHdjPf6XsVxvyQEZogX2k4pmhaKEVvgseW'),
		launchTs: 1698074659000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
		pythLazerId: 19,
	},
	{
		fullName: 'Rollbit',
		category: ['Exchange'],
		symbol: 'RLB-PERP',
		baseAssetSymbol: 'RLB',
		marketIndex: 17,
		oracle: new PublicKey('4CyhPqyVK3UQHFWhEpk91Aw4WbBsN3JtyosXH6zjoRqG'),
		launchTs: 1699265968000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x2f2d17abbc1e781bd87b4a5d52c8b2856886f5c482fa3593cebf6795040ab0b6',
	},
	{
		fullName: 'Pyth',
		category: ['Oracle', 'Solana'],
		symbol: 'PYTH-PERP',
		baseAssetSymbol: 'PYTH',
		marketIndex: 18,
		oracle: new PublicKey('6Sfx8ZAt6xaEgMXTahR6GrT7oYB6nFBMoVyCmMyHmeJV'),
		launchTs: 1700542800000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff',
		pythLazerId: 3,
	},
	{
		fullName: 'Celestia',
		category: ['Data'],
		symbol: 'TIA-PERP',
		baseAssetSymbol: 'TIA',
		marketIndex: 19,
		oracle: new PublicKey('2rDfWydvqvMQjDuf7vQsgfpa6dLMZehrWrpoXitn6gPx'),
		launchTs: 1701880540000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x09f7c1d7dfbb7df2b8fe3d3d87ee94a2259d212da4f30c1f0540d066dfa44723',
		pythLazerId: 48,
	},
	{
		fullName: 'Jito',
		category: ['MEV', 'Solana'],
		symbol: 'JTO-PERP',
		baseAssetSymbol: 'JTO',
		marketIndex: 20,
		oracle: new PublicKey('CGCz4mB8NsDddCq6BZToRUDUuktzsAfpKYh6ATgyyCGF'),
		launchTs: 1701967240000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2',
		pythLazerId: 91,
	},
	{
		fullName: 'SEI',
		category: ['L1'],
		symbol: 'SEI-PERP',
		baseAssetSymbol: 'SEI',
		marketIndex: 21,
		oracle: new PublicKey('Edk1TWipQtsaD8nnBXYQV1CEAiQb1GFtEAKeFZCi2A4C'),
		launchTs: 1703173331000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x53614f1cb0c031d4af66c04cb9c756234adad0e1cee85303795091499a4084eb',
		pythLazerId: 51,
	},
	{
		fullName: 'AVAX',
		category: ['Rollup', 'Infra'],
		symbol: 'AVAX-PERP',
		baseAssetSymbol: 'AVAX',
		marketIndex: 22,
		oracle: new PublicKey('5ASZLwk3GFCwZiDQ3XpmduRqNPEUGHXjELMX85u8McK3'),
		launchTs: 1704209558000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7',
		pythLazerId: 18,
	},
	{
		fullName: 'WIF',
		category: ['Meme', 'Dog', 'Solana'],
		symbol: 'WIF-PERP',
		baseAssetSymbol: 'WIF',
		marketIndex: 23,
		oracle: new PublicKey('4QXWStoyEErTZFVsvKrvxuNa6QT8zpeA8jddZunSGvYE'),
		launchTs: 1706219971000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
		pythLazerId: 10,
	},
	{
		fullName: 'JUP',
		category: ['Exchange', 'Infra', 'Solana'],
		symbol: 'JUP-PERP',
		baseAssetSymbol: 'JUP',
		marketIndex: 24,
		oracle: new PublicKey('AwqRpfJ36jnSZQykyL1jYY35mhMteeEAjh7o8LveRQin'),
		launchTs: 1706713201000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
		pythLazerId: 92,
	},
	{
		fullName: 'Dymension',
		category: ['Rollup', 'Infra'],
		symbol: 'DYM-PERP',
		baseAssetSymbol: 'DYM',
		marketIndex: 25,
		oracle: new PublicKey('HWDqaKbbNrEsgWPLMeKG39AguefMbHsWcvNSthToXG2t'),
		launchTs: 1708448765000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xa9f3b2a89c6f85a6c20a9518abde39b944e839ca49a0c92307c65974d3f14a57',
		pythLazerId: 83,
	},
	{
		fullName: 'BITTENSOR',
		category: ['AI', 'Infra'],
		symbol: 'TAO-PERP',
		baseAssetSymbol: 'TAO',
		marketIndex: 26,
		oracle: new PublicKey('44fqbLqAkKK5kEj1FFvuEPYq56XoQQL3ABzCPrqsW3Cv'),
		launchTs: 1709136669000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x410f41de235f2db824e562ea7ab2d3d3d4ff048316c61d629c0b93f58584e1af',
		pythLazerId: 36,
	},
	{
		fullName: 'Wormhole',
		category: ['Bridge'],
		symbol: 'W-PERP',
		baseAssetSymbol: 'W',
		marketIndex: 27,
		oracle: new PublicKey('CsFUXiA5dM4eCKjVBBy8tXhXzDkDRNoYjU5rjpHyfNEZ'),
		launchTs: 1710418343000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xeff7446475e218517566ea99e72a4abec2e1bd8498b43b7d8331e29dcb059389',
		pythLazerId: 102,
	},
	{
		fullName: 'Kamino',
		category: ['Lending', 'Solana'],
		symbol: 'KMNO-PERP',
		baseAssetSymbol: 'KMNO',
		marketIndex: 28,
		oracle: new PublicKey('7aqj2wH1BH8XT3QQ3MWtvt3My7RAGf5Stm3vx5fiysJz'),
		launchTs: 1712240681000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xb17e5bc5de742a8a378b54c9c75442b7d51e30ada63f28d9bd28d3c0e26511a0',
	},
	{
		fullName: 'Tensor',
		category: ['NFT', 'Solana'],
		symbol: 'TNSR-PERP',
		baseAssetSymbol: 'TNSR',
		marketIndex: 29,
		oracle: new PublicKey('EX6r1GdfsgcUsY6cQ6YsToV4RGsb4HKpjrkokK2DrmsS'),
		launchTs: 1712593532000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x05ecd4597cd48fe13d6cc3596c62af4f9675aee06e2e0b94c06d8bee2b659e05',
		pythLazerId: 99,
	},
	{
		fullName: 'Drift',
		category: ['DEX', 'Solana'],
		symbol: 'DRIFT-PERP',
		baseAssetSymbol: 'DRIFT',
		marketIndex: 30,
		oracle: new PublicKey('23KmX7SNikmUr2axSCy6Zer7XPBnvmVcASALnDGqBVRR'),
		launchTs: 1716595200000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x5c1690b27bb02446db17cdda13ccc2c1d609ad6d2ef5bf4983a85ea8b6f19d07',
	},
	{
		fullName: 'Sanctum',
		category: ['LST', 'Solana'],
		symbol: 'CLOUD-PERP',
		baseAssetSymbol: 'CLOUD',
		marketIndex: 31,
		oracle: new PublicKey('FNFejcXENaPgKaCTfstew9vSSvdQPnXjGTkJjUnnYvHU'),
		launchTs: 1717597648000,
		oracleSource: OracleSource.SWITCHBOARD_ON_DEMAND,
	},
	{
		fullName: 'IO',
		category: ['DePIN', 'Solana'],
		symbol: 'IO-PERP',
		baseAssetSymbol: 'IO',
		marketIndex: 32,
		oracle: new PublicKey('8x84eFZVGD9C8vmQqnB9P8UDPMdDWduFaULspKUYGthP'),
		launchTs: 1718021389000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x82595d1509b770fa52681e260af4dda9752b87316d7c048535d8ead3fa856eb1',
		pythLazerId: 90,
	},
	{
		fullName: 'ZEX',
		category: ['DEX', 'Solana'],
		symbol: 'ZEX-PERP',
		baseAssetSymbol: 'ZEX',
		marketIndex: 33,
		oracle: new PublicKey('HVwBCaR4GEB1fHrp7xCTzbYoZXL3V8b1aek2swPrmGx3'),
		launchTs: 1719415157000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x3d63be09d1b88f6dffe6585d0170670592124fd9fa4e0fe8a09ff18464f05e3a',
	},
	{
		fullName: 'POPCAT',
		category: ['Meme', 'Solana'],
		symbol: 'POPCAT-PERP',
		baseAssetSymbol: 'POPCAT',
		marketIndex: 34,
		oracle: new PublicKey('H3pn43tkNvsG5z3qzmERguSvKoyHZvvY6VPmNrJqiW5X'),
		launchTs: 1720013054000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xb9312a7ee50e189ef045aa3c7842e099b061bd9bdc99ac645956c3b660dc8cce',
	},
	{
		fullName: 'Wen',
		category: ['Solana', 'Meme'],
		symbol: '1KWEN-PERP',
		baseAssetSymbol: '1KWEN',
		marketIndex: 35,
		oracle: new PublicKey('F47c7aJgYkfKXQ9gzrJaEpsNwUKHprysregTWXrtYLFp'),
		launchTs: 1720633344000,
		oracleSource: OracleSource.PYTH_1K_PULL,
		pythFeedId:
			'0x5169491cd7e2a44c98353b779d5eb612e4ac32e073f5cc534303d86307c2f1bc',
	},
	{
		fullName: 'TRUMP-WIN-2024-BET',
		category: ['Prediction', 'Election'],
		symbol: 'TRUMP-WIN-2024-BET',
		baseAssetSymbol: 'TRUMP-WIN-2024',
		marketIndex: 36,
		oracle: new PublicKey('7YrQUxmxGdbk8pvns9KcL5ojbZSL2eHj62hxRqggtEUR'),
		launchTs: 1723996800000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'KAMALA-POPULAR-VOTE-2024-BET',
		category: ['Prediction', 'Election'],
		symbol: 'KAMALA-POPULAR-VOTE-2024-BET',
		baseAssetSymbol: 'KAMALA-POPULAR-VOTE-2024',
		marketIndex: 37,
		oracle: new PublicKey('AowFw1dCVjS8kngvTCoT3oshiUyL69k7P1uxqXwteWH4'),
		launchTs: 1723996800000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'FED-CUT-50-SEPT-2024-BET',
		category: ['Prediction', 'Election'],
		symbol: 'FED-CUT-50-SEPT-2024-BET',
		baseAssetSymbol: 'FED-CUT-50-SEPT-2024',
		marketIndex: 38,
		oracle: new PublicKey('5QzgqAbEhJ1cPnLX4tSZEXezmW7sz7PPVVg2VanGi8QQ'),
		launchTs: 1724250126000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'REPUBLICAN-POPULAR-AND-WIN-BET',
		category: ['Prediction', 'Election'],
		symbol: 'REPUBLICAN-POPULAR-AND-WIN-BET',
		baseAssetSymbol: 'REPUBLICAN-POPULAR-AND-WIN',
		marketIndex: 39,
		oracle: new PublicKey('BtUUSUc9rZSzBmmKhQq4no65zHQTzMFeVYss7xcMRD53'),
		launchTs: 1724250126000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'BREAKPOINT-IGGYERIC-BET',
		category: ['Prediction', 'Solana'],
		symbol: 'BREAKPOINT-IGGYERIC-BET',
		baseAssetSymbol: 'BREAKPOINT-IGGYERIC',
		marketIndex: 40,
		oracle: new PublicKey('2ftYxoSupperd4ULxy9xyS2Az38wfAe7Lm8FCAPwjjVV'),
		launchTs: 1724250126000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'DEMOCRATS-WIN-MICHIGAN-BET',
		category: ['Prediction', 'Election'],
		symbol: 'DEMOCRATS-WIN-MICHIGAN-BET',
		baseAssetSymbol: 'DEMOCRATS-WIN-MICHIGAN',
		marketIndex: 41,
		oracle: new PublicKey('8HTDLjhb2esGU5mu11v3pq3eWeFqmvKPkQNCnTTwKAyB'),
		launchTs: 1725551484000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'TON',
		category: ['L1'],
		symbol: 'TON-PERP',
		baseAssetSymbol: 'TON',
		marketIndex: 42,
		oracle: new PublicKey('Cbhiaky9kxDsviokcQaS9qc4HmpAzLaGjfmdSah1qakL'),
		launchTs: 1725551484000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x8963217838ab4cf5cadc172203c1f0b763fbaa45f346d8ee50ba994bbcac3026',
		pythLazerId: 12,
	},
	{
		fullName: 'LANDO-F1-SGP-WIN-BET',
		category: ['Prediction', 'Sports'],
		symbol: 'LANDO-F1-SGP-WIN-BET',
		baseAssetSymbol: 'LANDO-F1-SGP-WIN',
		marketIndex: 43,
		oracle: new PublicKey('DpJz7rjTJLxxnuqrqZTUjMWtnaMFAEfZUv5ATdb9HTh1'),
		launchTs: 1726646453000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'MOTHER',
		category: ['Solana', 'Meme'],
		symbol: 'MOTHER-PERP',
		baseAssetSymbol: 'MOTHER',
		marketIndex: 44,
		oracle: new PublicKey('56ap2coZG7FPWUigVm9XrpQs3xuCwnwQaWtjWZcffEUG'),
		launchTs: 1727291859000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x62742a997d01f7524f791fdb2dd43aaf0e567d765ebf8fd0406a994239e874d4',
	},
	{
		fullName: 'MOODENG',
		category: ['Solana', 'Meme'],
		symbol: 'MOODENG-PERP',
		baseAssetSymbol: 'MOODENG',
		marketIndex: 45,
		oracle: new PublicKey('21gjgEcuDppthwV16J1QpFzje3vmgMp2uSzh7pJsG7ob'),
		launchTs: 1727965864000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xffff73128917a90950cd0473fd2551d7cd274fd5a6cc45641881bbcc6ee73417',
	},
	{
		fullName: 'WARWICK-FIGHT-WIN-BET',
		category: ['Prediction', 'Sport'],
		symbol: 'WARWICK-FIGHT-WIN-BET',
		baseAssetSymbol: 'WARWICK-FIGHT-WIN',
		marketIndex: 46,
		oracle: new PublicKey('Dz5Nvxo1hv7Zfyu11hy8e97twLMRKk6heTWCDGXytj7N'),
		launchTs: 1727965864000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'DeBridge',
		category: ['Bridge'],
		symbol: 'DBR-PERP',
		baseAssetSymbol: 'DBR',
		marketIndex: 47,
		oracle: new PublicKey('53j4mz7cQV7mAZekKbV3n2L4bY7jY6eXdgaTkWDLYxq4'),
		launchTs: 1728574493000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xf788488fe2df341b10a498e0a789f03209c0938d9ed04bc521f8224748d6d236',
	},
	{
		fullName: 'WLF-5B-1W',
		category: ['Prediction'],
		symbol: 'WLF-5B-1W-BET',
		baseAssetSymbol: 'WLF-5B-1W',
		marketIndex: 48,
		oracle: new PublicKey('7LpRfPaWR7cQqN7CMkCmZjEQpWyqso5LGuKCvDXH5ZAr'),
		launchTs: 1728574493000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'VRSTPN-WIN-F1-24-DRVRS-CHMP',
		category: ['Prediction', 'Sport'],
		symbol: 'VRSTPN-WIN-F1-24-DRVRS-CHMP-BET',
		baseAssetSymbol: 'VRSTPN-WIN-F1-24-DRVRS-CHMP',
		marketIndex: 49,
		oracle: new PublicKey('E36rvXEwysWeiToXCpWfHVADd8bzzyR4w83ZSSwxAxqG'),
		launchTs: 1729209600000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'LNDO-WIN-F1-24-US-GP',
		category: ['Prediction', 'Sport'],
		symbol: 'LNDO-WIN-F1-24-US-GP-BET',
		baseAssetSymbol: 'LNDO-WIN-F1-24-US-GP',
		marketIndex: 50,
		oracle: new PublicKey('6AVy1y9SnJECnosQaiK2uY1kcT4ZEBf1F4DMvhxgvhUo'),
		launchTs: 1729209600000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: '1KMEW',
		category: ['Meme'],
		symbol: '1KMEW-PERP',
		baseAssetSymbol: '1KMEW',
		marketIndex: 51,
		oracle: new PublicKey('DKGwCUcwngwmgifGxnme7zVR695LCBGk2pnuksRnbhfD'),
		launchTs: 1729702915000,
		oracleSource: OracleSource.PYTH_1K_PULL,
		pythFeedId:
			'0x514aed52ca5294177f20187ae883cec4a018619772ddce41efcc36a6448f5d5d',
	},
	{
		fullName: 'MICHI',
		category: ['Meme'],
		symbol: 'MICHI-PERP',
		baseAssetSymbol: 'MICHI',
		marketIndex: 52,
		oracle: new PublicKey('GHzvsMDMSiuyZoWhEAuM27MKFdN2Y4fA4wSDuSd6dLMA'),
		launchTs: 1730402722000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x63a45218d6b13ffd28ca04748615511bf70eff80a3411c97d96b8ed74a6decab',
	},
	{
		fullName: 'GOAT',
		category: ['Meme'],
		symbol: 'GOAT-PERP',
		baseAssetSymbol: 'GOAT',
		marketIndex: 53,
		oracle: new PublicKey('5RgXW13Kq1RgCLEsJhhchWt3W4R2XLJnd6KqgZk6dSY7'),
		launchTs: 1731443152000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0xf7731dc812590214d3eb4343bfb13d1b4cfa9b1d4e020644b5d5d8e07d60c66c',
	},
	{
		fullName: 'FWOG',
		category: ['Meme'],
		symbol: 'FWOG-PERP',
		baseAssetSymbol: 'FWOG',
		marketIndex: 54,
		oracle: new PublicKey('5Z7uvkAsHNN6qqkQkwcKcEPYZqiMbFE9E24p7SpvfSrv'),
		launchTs: 1731443152000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x656cc2a39dd795bdecb59de810d4f4d1e74c25fe4c42d0bf1c65a38d74df48e9',
	},
	{
		fullName: 'PNUT',
		category: ['Meme'],
		symbol: 'PNUT-PERP',
		baseAssetSymbol: 'PNUT',
		marketIndex: 55,
		oracle: new PublicKey('Fbd2hz8Uz26gLm2Jrj7WSrhxusrh9VuSEWVpLBPJgMYX'),
		launchTs: 1731443152000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x116da895807f81f6b5c5f01b109376e7f6834dc8b51365ab7cdfa66634340e54',
		pythLazerId: 77,
	},
	{
		fullName: 'RAY',
		category: ['DEX'],
		symbol: 'RAY-PERP',
		baseAssetSymbol: 'RAY',
		marketIndex: 56,
		oracle: new PublicKey('6VXU2P9BJkuPkfA7FJVonBtAo1c2pGnHoV9rxsdZKZyb'),
		launchTs: 1732721897000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a',
		pythLazerId: 54,
	},
	{
		fullName: 'SUPERBOWL-LIX-LIONS',
		category: ['Prediction', 'Sport'],
		symbol: 'SUPERBOWL-LIX-LIONS-BET',
		baseAssetSymbol: 'SUPERBOWL-LIX-LIONS',
		marketIndex: 57,
		oracle: new PublicKey('GfTeKKnBxeLSB1Hm24ArjduQM4yqaAgoGgiC99gq5E2P'),
		launchTs: 1732721897000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'SUPERBOWL-LIX-CHIEFS',
		category: ['Prediction', 'Sport'],
		symbol: 'SUPERBOWL-LIX-CHIEFS-BET',
		baseAssetSymbol: 'SUPERBOWL-LIX-CHIEFS',
		marketIndex: 58,
		oracle: new PublicKey('EdB17Nyu4bnEBiSEfFrwvp4VCUvtq9eDJHc6Ujys3Jwd'),
		launchTs: 1732721897000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'Hyperliquid',
		category: ['DEX'],
		symbol: 'HYPE-PERP',
		baseAssetSymbol: 'HYPE',
		marketIndex: 59,
		oracle: new PublicKey('Hn9JHQHKSvtnZ2xTWCgRGVNmav2TPffH7T72T6WoJ1cw'),
		launchTs: 1733374800000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b',
	},
	{
		fullName: 'LiteCoin',
		category: ['Payment'],
		symbol: 'LTC-PERP',
		baseAssetSymbol: 'LTC',
		marketIndex: 60,
		oracle: new PublicKey('AmjHowvVkVJApCPUiwV9CdHVFn29LiBYZQqtZQ3xMqdg'),
		launchTs: 1733374800000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x6e3f3fa8253588df9326580180233eb791e03b443a3ba7a1d892e73874e19a54',
	},
	{
		fullName: 'Magic Eden',
		category: ['DEX'],
		symbol: 'ME-PERP',
		baseAssetSymbol: 'ME',
		marketIndex: 61,
		oracle: new PublicKey('BboTg1yT114FQkqT6MM3P3G3CcCktuM2RePgU8Gr3K4A'),
		launchTs: 1733839936000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0x91519e3e48571e1232a85a938e714da19fe5ce05107f3eebb8a870b2e8020169',
		pythLazerId: 93,
	},
	{
		fullName: 'PENGU',
		category: ['Meme'],
		symbol: 'PENGU-PERP',
		baseAssetSymbol: 'PENGU',
		marketIndex: 62,
		oracle: new PublicKey('4A3KroGPjZxPAeBNF287V3NyRwV2q8iBi1vX7kHxTCh7'),
		launchTs: 1734444000000,
		oracleSource: OracleSource.PYTH_LAZER,
		pythFeedId:
			'0xbed3097008b9b5e3c93bec20be79cb43986b85a996475589351a21e67bae9b61',
		pythLazerId: 97,
	},
	{
		fullName: 'AI16Z',
		category: ['AI'],
		symbol: 'AI16Z-PERP',
		baseAssetSymbol: 'AI16Z',
		marketIndex: 63,
		oracle: new PublicKey('3gdGkrmBdYR7B1MRRdRVysqhZCvYvLGHonr9b7o9WVki'),
		launchTs: 1736384970000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x2551eca7784671173def2c41e6f3e51e11cd87494863f1d208fdd8c64a1f85ae',
	},
	{
		fullName: 'TRUMP',
		category: ['Meme'],
		symbol: 'TRUMP-PERP',
		baseAssetSymbol: 'TRUMP',
		marketIndex: 64,
		oracle: new PublicKey('AmSLxftd19EPDR9NnZDxvdStqtRW7k9zWto7FfGaz24K'),
		launchTs: 1737219250000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x879551021853eec7a7dc827578e8e69da7e4fa8148339aa0d3d5296405be4b1a',
	},
	{
		fullName: 'MELANIA',
		category: ['Meme'],
		symbol: 'MELANIA-PERP',
		baseAssetSymbol: 'MELANIA',
		marketIndex: 65,
		oracle: new PublicKey('28Zk42cxbg4MxiTewSwoedvW6MUgjoVHSTvTW7zQ7ESi'),
		launchTs: 1737360280000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x8fef7d52c7f4e3a6258d663f9d27e64a1b6fd95ab5f7d545dbf9a515353d0064',
	},
	{
		fullName: 'BERA',
		category: ['L1', 'EVM'],
		symbol: 'BERA-PERP',
		baseAssetSymbol: 'BERA',
		marketIndex: 66,
		oracle: new PublicKey('53Ae7ArP9yCnjqL2CqxJ1zdv3ba64NoVTqRcwjrCg181'),
		launchTs: 1738850177000,
		oracleSource: OracleSource.PYTH_PULL,
		pythFeedId:
			'0x962088abcfdbdb6e30db2e340c8cf887d9efb311b1f2f17b155a63dbb6d40265',
	},
	{
		fullName: 'NBAFINALS25-OKC',
		category: ['Prediction', 'Sport'],
		symbol: 'NBAFINALS25-OKC-BET',
		baseAssetSymbol: 'NBAFINALS25-OKC',
		marketIndex: 67,
		oracle: new PublicKey('HieNNSAy9tjtU2mLEcGtgCMViCeZ1881fX7tfezL7wdV'),
		launchTs: 1739463226000,
		oracleSource: OracleSource.Prelaunch,
	},
	{
		fullName: 'NBAFINALS25-BOS',
		category: ['Prediction', 'Sport'],
		symbol: 'NBAFINALS25-BOS-BET',
		baseAssetSymbol: 'NBAFINALS25-BOS',
		marketIndex: 68,
		oracle: new PublicKey('HorrnsG8RBMv7dhzbgPX4wqcWbUTV5NwV8r59UwTu4CJ'),
		launchTs: 1739463226000,
		oracleSource: OracleSource.Prelaunch,
	},
];

export const PerpMarkets: { [key in DriftEnv]: PerpMarketConfig[] } = {
	devnet: DevnetPerpMarkets,
	'mainnet-beta': MainnetPerpMarkets,
};
