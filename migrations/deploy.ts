import * as anchor from '@project-serum/anchor';
import {Program, Provider, Wallet} from '@project-serum/anchor';
import {Keypair, PublicKey} from '@solana/web3.js';
import BN from 'bn.js';
import { ClearingHouse, PythClient } from '../sdk/';
import { AMM_MANTISSA, MockUSDCFaucet, PEG_SCALAR } from '../sdk/src';

import dotenv = require('dotenv');
dotenv.config();

const fs = require('fs');

async function deploy(provider: Provider) {
	const connection = provider.connection;
	const chProgram = anchor.workspace.ClearingHouse as Program;
	const clearingHouse = new ClearingHouse(
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

	function normAssetAmount(assetAmount: BN, pegMultiplier: BN) : BN{
		// assetAmount is scaled to offer comparable slippage
		return assetAmount.mul(AMM_MANTISSA).div(pegMultiplier);
	}
	const devnetOracles = {
		"SOL": "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix",
		"BTC": "HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J",
		"ETH": "EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw",
		"COPE": "BAXDJUXtz6P5ARhHH1aPwgv4WENzHwzyhmLYK4daFwiM",
	};
	const marketOracleKeys = Object.keys(devnetOracles);

	for(let i=0; i<marketOracleKeys.length; i++){
		const keyName = marketOracleKeys[i];
		const oraclePriceKey = devnetOracles[keyName];
		const astPrice = (await pythClient.getPriceData(new PublicKey(oraclePriceKey))).price;
		console.log(keyName + ' Price:', astPrice);
	
		const marketIndex = new BN(i);
		const periodicity = new BN(3600);
		const ammQuoteAssetAmount = new anchor.BN(2 * 10 ** 13);
		const ammBaseAssetAmount = new anchor.BN(2 * 10 ** 13);
		const pegMultiplierAst = new anchor.BN(astPrice * PEG_SCALAR.toNumber());
	
		console.log('Initializing Market for ', keyName,'/USD: ');
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

	const clearingHouseForBot = new ClearingHouse(
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

	await updateEnvFiles(
		clearingHouse.program.programId,
		mockUsdcFaucet.program.programId,
		mockUsdcFaucetState.mint,
		associatedTokenPublicKey
	);
}

async function replace(filePath: string, search: RegExp, replacement: string) {
	fs.readFile(filePath, 'utf8', function (err,data) {
		if (err) {
			return console.error(err);
		}
		const result = data.replace(search, replacement);

		fs.writeFile(filePath, result, 'utf8', function (err) {
			if (err) return console.error(err);
		});
	});
}

async function updateEnvFiles(
	clearingHouseProgramId: PublicKey,
	mockUSDCFaucetProgramId: PublicKey,
	USDCMintProgramId: PublicKey,
	offChainBotTokenAccount: PublicKey,
) {
	const uiEnvPath = `${__dirname}/../../ui/.env`;
	await replace(
		uiEnvPath,
		/NEXT_PUBLIC_CLEARING_HOUSE_PROGRAM_ID=([\d\w]*)/g,
		`NEXT_PUBLIC_CLEARING_HOUSE_PROGRAM_ID=${clearingHouseProgramId.toString()}`
	);
	await replace(
		uiEnvPath,
		/NEXT_PUBLIC_USDC_MINT_ADDRESS=([\d\w]*)/g,
		`NEXT_PUBLIC_USDC_MINT_ADDRESS=${USDCMintProgramId.toString()}`
	);
	await replace(
		uiEnvPath,
		/NEXT_PUBLIC_MOCK_USDC_FAUCET_ADDRESS=([\d\w]*)/g,
		`NEXT_PUBLIC_MOCK_USDC_FAUCET_ADDRESS=${mockUSDCFaucetProgramId.toString()}`
	);

	const offChainBotEnvPath = `${__dirname}/../../off-chain-bot/.env`;
	await replace(
		offChainBotEnvPath,
		/LIQUIDATION_USER_TOKEN_PUBLIC_KEY=([\d\w]*)/g,
		`LIQUIDATION_USER_TOKEN_PUBLIC_KEY=${offChainBotTokenAccount.toString()}`
	);
	await replace(
		offChainBotEnvPath,
		/NEXT_PUBLIC_USDC_MINT_ADDRESS=([\d\w]*)/g,
		`CLEARING_HOUSE_PROGRAM_ID=${clearingHouseProgramId.toString()}`
	);

	const exchangeHistoryEnvPath = `${__dirname}/../../exchange-history/.env`;
	await replace(
		exchangeHistoryEnvPath,
		/CLEARING_HOUSE_PROGRAM_ID=([\d\w]*)/g,
		`CLEARING_HOUSE_PROGRAM_ID=${clearingHouseProgramId.toString()}`
	);
}

try {
	if (!process.env.ANCHOR_WALLET) {
		throw new Error("ANCHOR_WALLET must be set.");
	}
	deploy(anchor.Provider.local("https://psytrbhymqlkfrhudd.dev.genesysgo.net:8899/"));
} catch (e) {
	console.error(e);
}
