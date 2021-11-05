import * as anchor from '@project-serum/anchor';
import { Program, Provider, Wallet } from '@project-serum/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { Admin, ClearingHouse, PythClient } from '../sdk/';
import {
	MARK_PRICE_PRECISION,
	MockUSDCFaucet,
	PEG_PRECISION,
} from '../sdk/src';

import dotenv = require('dotenv');
dotenv.config();

async function deployDevnet(provider: Provider) {
	const connection = provider.connection;
	const chProgram = anchor.workspace.ClearingHouse as Program;
	const clearingHouse = Admin.from(
		connection,
		provider.wallet,
		chProgram.programId
	);

	console.log('Deploying wallet:', provider.wallet.publicKey.toString());
	console.log('ClearingHouse ProgramID:', chProgram.programId.toString());

	console.log('Mocking USDC Mint');
	const mockUsdcFaucetProgram = anchor.workspace.MockUsdcFaucet as Program;
	const mockUsdcFaucet = new MockUSDCFaucet(
		connection,
		provider.wallet,
		mockUsdcFaucetProgram.programId
	);

	console.log(
		'MockUSDCFaucet ProgramID:',
		mockUsdcFaucetProgram.programId.toString()
	);

	await mockUsdcFaucet.initialize();
	const mockUsdcFaucetState: any = await mockUsdcFaucet.fetchState();
	console.log('USDC Mint:', mockUsdcFaucetState.mint.toString()); // TODO: put into Next config
	console.log('Initializing ClearingHouse');
	await clearingHouse.initialize(mockUsdcFaucetState.mint, true);
	console.log('Initialized ClearingHouse');

	const pythClient = new PythClient(clearingHouse.connection);

	function normAssetAmount(assetAmount: BN, pegMultiplier: BN): BN {
		// assetAmount is scaled to offer comparable slippage
		return assetAmount.mul(MARK_PRICE_PRECISION).div(pegMultiplier);
	}
	const devnetOracles = {
		SOL: 'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix',
		BTC: 'HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J',
		ETH: 'EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw',
		COPE: 'BAXDJUXtz6P5ARhHH1aPwgv4WENzHwzyhmLYK4daFwiM',
	};
	// const mainnetOracles = {
	// 	SOL: 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG',
	// 	BTC: 'GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU',
	// 	ETH: 'JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB',
	// 	COPE: '9xYBiDWYsh2fHzpsz3aaCnNHCKWBNtfEDLtU6kS4aFD9',
	// };
	const marketOracleKeys = Object.keys(devnetOracles);

	for (let i = 0; i < marketOracleKeys.length; i++) {
		const keyName = marketOracleKeys[i];
		const oraclePriceKey = devnetOracles[keyName];
		const oraclePriceData = await pythClient.getPriceData(
			new PublicKey(oraclePriceKey)
		);
		const astPrice =
			(oraclePriceData.price +
				oraclePriceData.previousPrice +
				oraclePriceData.twap.value) /
			3;
		console.log(keyName + ' Recent Average Price:', astPrice);

		const marketIndex = new BN(i);
		const periodicity = new BN(3600);
		const ammQuoteAssetAmount = new anchor.BN(2 * 10 ** 13);
		const ammBaseAssetAmount = new anchor.BN(2 * 10 ** 13);
		const pegMultiplierAst = new anchor.BN(astPrice * PEG_PRECISION.toNumber());

		console.log('Initializing Market for ', keyName, '/USD: ');
		await clearingHouse.subscribe();
		await clearingHouse.initializeMarket(
			marketIndex,
			oraclePriceKey,
			normAssetAmount(ammBaseAssetAmount, pegMultiplierAst),
			normAssetAmount(ammQuoteAssetAmount, pegMultiplierAst),
			periodicity,
			pegMultiplierAst
		);
		console.log(keyName, `Market Index: ${marketIndex.toString()}`);
	}

	const botWallet = new Wallet(
		Keypair.fromSecretKey(
			Uint8Array.from(
				process.env.OFF_CHAIN_BOT_PRIVATE_KEY.split(',').map((val) =>
					Number(val)
				)
			)
		)
	);
	console.log(`Bot Public Key: ${botWallet.publicKey.toString()}`);

	const associatedTokenPublicKey =
		await mockUsdcFaucet.getAssosciatedMockUSDMintAddress({
			userPubKey: botWallet.publicKey,
		});

	console.log("Bot's associated key:", associatedTokenPublicKey.toString());

	const clearingHouseForBot = ClearingHouse.from(
		connection,
		botWallet,
		chProgram.programId
	);
	await clearingHouseForBot.subscribe();

	console.log('Initializing Bot for devnet');
	await clearingHouseForBot.initializeUserAccountForDevnet(
		mockUsdcFaucet,
		new BN(10 ** 13) // $10M
	);
	console.log('Initialized Bot for devnet');
	await clearingHouse.unsubscribe();
	await clearingHouseForBot.unsubscribe();
}

try {
	if (!process.env.ANCHOR_WALLET) {
		throw new Error('ANCHOR_WALLET must be set.');
	}
	deployDevnet(
		anchor.Provider.local('https://psytrbhymqlkfrhudd.dev.genesysgo.net:8899/')
	);
} catch (e) {
	console.error(e);
}
