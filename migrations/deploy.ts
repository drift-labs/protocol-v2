import { ClearingHouse, PythClient } from '../sdk/';
import { Network } from '../sdk/';
import * as anchor from '@project-serum/anchor';
import { Program, Provider } from '@project-serum/anchor';
import BN from 'bn.js';
import { MockUSDCFaucet, AMM_MANTISSA } from '../sdk/src';
import { createPriceFeed } from '../utils/mockPythUtils';
import { PublicKey } from '@solana/web3.js';

module.exports = async function (provider: Provider) {
	const connection = provider.connection;
	const chProgram = anchor.workspace.ClearingHouse as Program;
	const clearingHouse = new ClearingHouse(
		connection,
		Network.LOCAL,
		provider.wallet,
		chProgram.programId
	);

	console.log('Deploying wallet:', provider.wallet.publicKey.toString());
	console.log('ClearingHouse ProgramID:', chProgram.programId.toString());

	console.log('Mocking USDC Mint');
	const mockUsdcFaucetProgram = anchor.workspace.MockUsdcFaucet as Program;
	const mockUsdcFaucet = new MockUSDCFaucet(
		connection,
		Network.LOCAL,
		provider.wallet,
		mockUsdcFaucetProgram.programId
	);

	console.log(
		'MockUSDCFaucet ProgramID:',
		mockUsdcFaucetProgram.programId.toString()
	);

	await mockUsdcFaucet.initialize();
	const mockUsdcFaucetState: any = await mockUsdcFaucet.program.state.fetch();
	console.log('USDC Mint:', mockUsdcFaucetState.mint.toString()); // TODO: put into Next config
	console.log('Initializing ClearingHouse');
	await clearingHouse.initialize(mockUsdcFaucetState.mint, false);
	console.log('Initialized ClearingHouse');

	const pythClient = new PythClient(clearingHouse.connection);

	// let oracleProgram = anchor.workspace.Pyth as Program;
	// // Dirty workaround `anchor.workspace.Pyth` was only using localhost
	// oracleProgram = await Program.at(oracleProgram.programId, provider);
	// const mockSolOraclePriceKey = await createPriceFeed({
	// 	oracleProgram,
	// 	initPrice: 50,
	// });
	// console.log('Mock SOL oracle:', mockSolOraclePriceKey.toString());
	const solOraclePriceKey = new PublicKey(
		'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix'
	);
	const solPrice = (await pythClient.getPriceData(solOraclePriceKey)).price;
	console.log('SOL Price:', solPrice);

	const marketIndex = new BN(0);
	const periodicity = new BN(3600);
	const ammQuoteAssetAmount = new anchor.BN(1 * 10 ** 10);
	const ammBaseAssetAmount = new anchor.BN(1 * 10 ** 10);
	const pegMultiplierSOL = new anchor.BN(solPrice).mul(AMM_MANTISSA);

	console.log('Initializing Market for SOL/USD: ');
	await clearingHouse.subscribe();
	await clearingHouse.initializeMarket(
		marketIndex,
		solOraclePriceKey,
		ammBaseAssetAmount,
		ammQuoteAssetAmount,
		periodicity,
		pegMultiplierSOL
	);
	console.log(`SOL/USD Market Index: ${marketIndex.toString()}`);

	// const mockBtcOraclePriceKey = await createPriceFeed({
	// 	oracleProgram,
	// 	initPrice: 50,
	// });
	const btcOraclePriceKey = new PublicKey(
		'HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J'
	);
	const btcPrice = (await pythClient.getPriceData(btcOraclePriceKey)).price;
	const pegMultiplierBTC = new anchor.BN(btcPrice).mul(AMM_MANTISSA);
	console.log('BTC Price:', btcPrice);

	await clearingHouse.initializeMarket(
		new BN(1),
		btcOraclePriceKey,
		ammBaseAssetAmount,
		ammQuoteAssetAmount,
		periodicity,
		pegMultiplierBTC
	);

	const spyOraclePriceKey = new PublicKey(
		'Epqu3qYZXJtnsH6r61wUj6LGJ2pp11VtpE3SbdqmHffD'
	);
	const spyPrice = (await pythClient.getPriceData(btcOraclePriceKey)).price;
	const pegMultiplierSPY = new anchor.BN(spyPrice).mul(AMM_MANTISSA);
	console.log('SPY Price:', spyPrice);

	await clearingHouse.initializeMarket(
		new BN(2),
		spyOraclePriceKey,
		ammBaseAssetAmount,
		ammQuoteAssetAmount,
		periodicity,
		pegMultiplierSPY
	);

	await clearingHouse.unsubscribe();
};
