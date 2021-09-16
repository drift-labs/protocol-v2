import * as anchor from '@project-serum/anchor';
import { Program, Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { ClearingHouse, Network, PythClient } from '../sdk/';
import { AMM_MANTISSA, MockUSDCFaucet, Markets } from '../sdk/src';



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
		const astPrice = (await pythClient.getPriceData(oraclePriceKey)).price;
		console.log(keyName + ' Price:', astPrice);
	
		const marketIndex = new BN(i);
		const periodicity = new BN(3600);
		const ammQuoteAssetAmount = new anchor.BN(2 * 10 ** 13);
		const ammBaseAssetAmount = new anchor.BN(2 * 10 ** 13);
		const pegMultiplierAst = new anchor.BN(astPrice * AMM_MANTISSA.toNumber());
	
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

	await clearingHouse.unsubscribe();
};
