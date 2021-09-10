import * as anchor from '@project-serum/anchor';
import { Program, Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { ClearingHouse, Network, PythClient } from '../sdk/';
import { AMM_MANTISSA, MockUSDCFaucet } from '../sdk/src';



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
	await clearingHouse.initialize(mockUsdcFaucetState.mint, true);
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


	function normAssetAmount(assetAmount: BN, pegMultiplier: BN) : BN{
		// assetAmount is scaled to offer comparable slippage
		return assetAmount.mul(AMM_MANTISSA).div(pegMultiplier);
	}

	const solOraclePriceKey = new PublicKey(
		'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix'
	);
	const solPrice = (await pythClient.getPriceData(solOraclePriceKey)).price;
	console.log('SOL Price:', solPrice);

	const marketIndex = new BN(0);
	const periodicity = new BN(3600);
	const ammQuoteAssetAmount = new anchor.BN(1 * 10 ** 11);
	const ammBaseAssetAmount = new anchor.BN(1 * 10 ** 11);
	const pegMultiplierSOL = new anchor.BN(solPrice * AMM_MANTISSA.toNumber());

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
	const pegMultiplierBTC = new anchor.BN(btcPrice * AMM_MANTISSA.toNumber());
	console.log('BTC Price:', btcPrice);

	await clearingHouse.initializeMarket(
		new BN(1),
		btcOraclePriceKey,
		normAssetAmount(ammBaseAssetAmount, pegMultiplierBTC),
		normAssetAmount(ammQuoteAssetAmount, pegMultiplierBTC),
		periodicity,
		pegMultiplierBTC
	);

	const spyOraclePriceKey = new PublicKey(
		'Epqu3qYZXJtnsH6r61wUj6LGJ2pp11VtpE3SbdqmHffD'
	);
	const spyPrice = (await pythClient.getPriceData(spyOraclePriceKey)).price;
	const pegMultiplierSPY = new anchor.BN(spyPrice * AMM_MANTISSA.toNumber());
	console.log('SPY Price:', spyPrice);

	await clearingHouse.initializeMarket(
		new BN(2),
		spyOraclePriceKey,
		normAssetAmount(ammBaseAssetAmount, pegMultiplierSPY),
		normAssetAmount(ammQuoteAssetAmount, pegMultiplierSPY),
		periodicity,
		pegMultiplierSPY
	);

	await clearingHouse.unsubscribe();
};
