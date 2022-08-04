import { BN, OracleSource } from '../';
import { DriftEnv } from '../';
import { PublicKey } from '@solana/web3.js';
import { WRAPPED_SOL_MINT } from '@project-serum/serum/lib/token-instructions';

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
	{
		symbol: 'SOL',
		bankIndex: new BN(1),
		oracle: new PublicKey('J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix'),
		oracleSource: OracleSource.PYTH,
		mint: WRAPPED_SOL_MINT,
	},
	{
		symbol: 'BTC',
		bankIndex: new BN(2),
		oracle: new PublicKey('HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J'),
		oracleSource: OracleSource.PYTH,
		mint: new PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'),
	},
];

export const MainnetBanks: BankConfig[] = [
	{
		symbol: 'USDC',
		bankIndex: new BN(0),
		oracle: PublicKey.default,
		oracleSource: OracleSource.QUOTE_ASSET,
		mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
	},
];

export const Banks: { [key in DriftEnv]: BankConfig[] } = {
	devnet: DevnetBanks,
	'mainnet-beta': MainnetBanks,
};
