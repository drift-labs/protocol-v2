import { AnchorProvider, BN } from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	calculateBidAskPrice,
	getMarketOrderParams,
	Wallet,
} from '..';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	DriftClient,
	User,
	initialize,
	PositionDirection,
	convertToNumber,
	calculateTradeSlippage,
	BulkAccountLoader,
	getMarketsAndOraclesForSubscription,
	PRICE_PRECISION,
	QUOTE_PRECISION,
} from '..';
import { SpotMarkets } from '../constants/spotMarkets';

export const getTokenAddress = (
	mintAddress: string,
	userPubKey: string
): Promise<PublicKey> => {
	return getAssociatedTokenAddress(
		new PublicKey(mintAddress),
		new PublicKey(userPubKey)
	);
};

const env = 'devnet';

const main = async () => {
	// Initialize Drift SDK
	const sdkConfig = initialize({ env });

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
	const provider = new AnchorProvider(
		connection,
		// @ts-ignore
		wallet,
		AnchorProvider.defaultOptions()
	);

	// Check SOL Balance
	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	console.log('SOL balance:', lamportsBalance / 10 ** 9);

	// Misc. other things to set up
	const usdcTokenAddress = await getTokenAddress(
		sdkConfig.USDC_MINT_ADDRESS,
		wallet.publicKey.toString()
	);

	// Set up the Drift Clearing House
	const driftPublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);
	const bulkAccountLoader = new BulkAccountLoader(
		connection,
		'confirmed',
		1000
	);
	const driftClient = new DriftClient({
		connection,
		wallet: provider.wallet,
		programID: driftPublicKey,
		...getMarketsAndOraclesForSubscription(env),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await driftClient.subscribe();

	// Set up user client
	const user = new User({
		driftClient: driftClient,
		userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});

	//// Check if user account exists for the current wallet
	const userAccountExists = await user.exists();

	if (!userAccountExists) {
		//// Create a Clearing House account by Depositing some USDC ($10,000 in this case)
		const depositAmount = new BN(10000).mul(QUOTE_PRECISION);
		await driftClient.initializeUserAccountAndDepositCollateral(
			depositAmount,
			await getTokenAddress(
				usdcTokenAddress.toString(),
				wallet.publicKey.toString()
			),
			SpotMarkets['devnet'][0].marketIndex
		);
	}

	await user.subscribe();

	// Get current price
	const solMarketInfo = sdkConfig.PERP_MARKETS.find(
		(market) => market.baseAssetSymbol === 'SOL'
	);

	const marketIndex = solMarketInfo.marketIndex;
	const [bid, ask] = calculateBidAskPrice(
		driftClient.getPerpMarketAccount(marketIndex).amm,
		driftClient.getOracleDataForPerpMarket(marketIndex)
	);

	const formattedBidPrice = convertToNumber(bid, PRICE_PRECISION);
	const formattedAskPrice = convertToNumber(ask, PRICE_PRECISION);

	console.log(
		`Current amm bid and ask price are $${formattedBidPrice} and $${formattedAskPrice}`
	);

	// Estimate the slippage for a $5000 LONG trade
	const solMarketAccount = driftClient.getPerpMarketAccount(
		solMarketInfo.marketIndex
	);

	const slippage = convertToNumber(
		calculateTradeSlippage(
			PositionDirection.LONG,
			new BN(1).mul(BASE_PRECISION),
			solMarketAccount,
			'base',
			driftClient.getOracleDataForPerpMarket(solMarketInfo.marketIndex)
		)[0],
		PRICE_PRECISION
	);

	console.log(`Slippage for a 1 SOL-PERP would be $${slippage}`);

	await driftClient.placePerpOrder(
		getMarketOrderParams({
			baseAssetAmount: new BN(1).mul(BASE_PRECISION),
			direction: PositionDirection.LONG,
			marketIndex: solMarketAccount.marketIndex,
		})
	);
	console.log(`Placed a 1 SOL-PERP LONG order`);
};

main();
