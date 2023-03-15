import * as anchor from '@project-serum/anchor';
import {BulkAccountLoader, OracleSource, PRICE_PRECISION, TestClient} from "../sdk";
import {initializeQuoteSpotMarket, mockOracle, mockUSDCMint, mockUserUSDCAccount} from "./testHelpers";
import {BN} from "../sdk/src";

describe('print trades', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as anchor.Program;

	let driftClient: TestClient;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let creatorUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 11).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 11).mul(
		mantissaSqrtScale
	);

	const marketIndex = 0;
	const marketIndexBTC = 1;
	const marketIndexEth = 2;

	let solUsd;
	let btcUsd;
	let ethUsd;

	const usdcAmount = new BN(10 * 10 ** 6);
	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		creatorUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);
		//counterpartyUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider, counterpartyOwner.publicKey);

		solUsd = await mockOracle(1);
		btcUsd = await mockOracle(60000);
		ethUsd = await mockOracle(1);

		const marketIndexes = [marketIndex, marketIndexBTC, marketIndexEth];
		const bankIndexes = [0];
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH },
			{ publicKey: btcUsd, source: OracleSource.PYTH },
			{ publicKey: ethUsd, source: OracleSource.PYTH },
		];

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: bankIndexes,
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);
	});

	after(async () => { });

	it('initializes a print trade', async () => {
		const [, creatorAccountPublicKey] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				creatorUSDCAccount.publicKey
			);
		// @ts-ignore
		const payer: anchor.web3.Keypair = provider.wallet.payer;
		const [print_trade, ] = anchor.web3.PublicKey.findProgramAddressSync(
			[
				Buffer.from("print_trade"),
				creatorAccountPublicKey.toBuffer(),
				creatorAccountPublicKey.toBuffer(),
			],
			chProgram.programId,
		);


		const remainingAccounts = driftClient.getRemainingAccounts({
			userAccounts: [driftClient.getUserAccount()],
			useMarketLastSlotCache: true,
			readablePerpMarketIndex: 0,
		});

		const tx = await chProgram.methods.initializePrintTrade().accounts(
			{
				state: await driftClient.getStatePublicKey(),
				printTrade: print_trade,
				creator: creatorAccountPublicKey,
				creator_owner: payer.publicKey,
				counterparty: creatorAccountPublicKey,
				counterparty_owner: payer.publicKey,
				systemProgram: anchor.web3.SystemProgram.programId,
			}
		).remainingAccounts(
			remainingAccounts
		).signers(
			[payer]
		).rpc();

		console.log("print trade creation tx: ", tx);
	});
});
