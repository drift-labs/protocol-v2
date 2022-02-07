import { BN, Provider } from '@project-serum/anchor';
import { Wallet } from '..';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	calculateMarkPrice,
	ClearingHouse,
	ClearingHouseUser,
	initialize,
	Markets,
	PositionDirection,
	convertToNumber,
	calculateTradeSlippage,
	MARK_PRICE_PRECISION,
	QUOTE_PRECISION,
} from '..';

export const getTokenAddress = (
	mintAddress: string,
	userPubKey: string
): Promise<PublicKey> => {
	return Token.getAssociatedTokenAddress(
		new PublicKey(`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`),
		TOKEN_PROGRAM_ID,
		new PublicKey(mintAddress),
		new PublicKey(userPubKey)
	);
};

const main = async () => {
	// Initialize Drift SDK
	const sdkConfig = initialize({ env: 'devnet' });

	// Set up the Wallet and Provider
	const privateKey = process.env.BOT_PRIVATE_KEY; // stored as an array string
	const keypair = Keypair.fromSecretKey(
		Uint8Array.from(JSON.parse(privateKey))
	);
	const wallet = new Wallet(keypair);

	// Set up the Connection
	const rpcAddress = process.env.RPC_ADDRESS; // can use: https://api.devnet.solana.com for devnet; https://api.mainnet-beta.solana.com for mainnet;
	const connection = new Connection(rpcAddress);

	// Set up the Provider
	const provider = new Provider(connection, wallet, Provider.defaultOptions());

	// Check SOL Balance
	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	console.log('SOL balance:', lamportsBalance / 10 ** 9);

	// Misc. other things to set up
	const usdcTokenAddress = await getTokenAddress(
		sdkConfig.USDC_MINT_ADDRESS,
		wallet.publicKey.toString()
	);

	// Set up the Drift Clearing House
	const clearingHousePublicKey = new PublicKey(
		sdkConfig.CLEARING_HOUSE_PROGRAM_ID
	);
	const clearingHouse = ClearingHouse.from(
		connection,
		provider.wallet,
		clearingHousePublicKey
	);
	await clearingHouse.subscribe();

	// Set up Clearing House user client
	const user = ClearingHouseUser.from(clearingHouse, wallet.publicKey);

	//// Check if clearing house account exists for the current wallet
	const userAccountExists = await user.exists();

	if (!userAccountExists) {
		//// Create a Clearing House account by Depositing some USDC ($10,000 in this case)
		const depositAmount = new BN(10000).mul(QUOTE_PRECISION);
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			depositAmount,
			await getTokenAddress(
				usdcTokenAddress.toString(),
				wallet.publicKey.toString()
			)
		);
	}

	await user.subscribe();

	// Get current price
	const solMarketInfo = Markets.find(
		(market) => market.baseAssetSymbol === 'SOL'
	);

	const currentMarketPrice = calculateMarkPrice(
		clearingHouse.getMarket(solMarketInfo.marketIndex)
	);

	const formattedPrice = convertToNumber(
		currentMarketPrice,
		MARK_PRICE_PRECISION
	);

	console.log(`Current Market Price is $${formattedPrice}`);

	// Estimate the slippage for a $5000 LONG trade
	const solMarketAccount = clearingHouse.getMarket(solMarketInfo.marketIndex);

	const longAmount = new BN(5000).mul(QUOTE_PRECISION);
	const slippage = convertToNumber(
		calculateTradeSlippage(
			PositionDirection.LONG,
			longAmount,
			solMarketAccount
		)[0],
		MARK_PRICE_PRECISION
	);

	console.log(
		`Slippage for a $5000 LONG on the SOL market would be $${slippage}`
	);

	// Make a $5000 LONG trade
	await clearingHouse.openPosition(
		PositionDirection.LONG,
		longAmount,
		solMarketInfo.marketIndex
	);
	console.log(`LONGED $5000 SOL`);

	// Reduce the position by $2000
	const reduceAmount = new BN(2000).mul(QUOTE_PRECISION);
	await clearingHouse.openPosition(
		PositionDirection.SHORT,
		reduceAmount,
		solMarketInfo.marketIndex
	);

	// Close the rest of the position
	await clearingHouse.closePosition(solMarketInfo.marketIndex);
};

main();
