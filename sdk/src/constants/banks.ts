import { BN, OracleSource } from '../';
import { DriftEnv } from '../';
import { PublicKey } from '@solana/web3.js';

export type BankConfig = {
	symbol: string;
	bankIndex: BN;
	oracle: PublicKey;
	mint: PublicKey;
	oracleSource: OracleSource;
};

export const DevnetBanks: BankConfig[] = [
	{
		symbol: 'USDC',
		bankIndex: new BN(0),
		oracle: PublicKey.default,
		oracleSource: OracleSource.QUOTE_ASSET,
		mint: new PublicKey('8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2'),
	},
];

export const MainnetBanks: BankConfig[] = [];

export const Banks: { [key in DriftEnv]: BankConfig[] } = {
	devnet: DevnetBanks,
	'mainnet-beta': MainnetBanks,
};
