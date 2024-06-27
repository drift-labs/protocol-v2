import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	BN,
	MarketStatus,
	OracleSource,
	TestClient,
} from '../sdk/src';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import { AccountInfo, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {DEFAULT_RECEIVER_PROGRAM_ID, DEFAULT_WORMHOLE_PROGRAM_ID} from '@pythnetwork/pyth-solana-receiver';
import {
	PYTH_ORACLE_ONE_DATA,
	PYTH_ORACLE_TWO_DATA, WORMHOLE_DATA,
} from './pythPullOracleData';
import { initializeQuoteSpotMarket, mockUSDCMint } from './testHelpers';

// set up account infos to load into banks client
const GUARDIAN_SET_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: DEFAULT_WORMHOLE_PROGRAM_ID,
	rentEpoch: 0,
	data: Buffer.from(WORMHOLE_DATA, 'base64'),
};

const GUARDIAN_SET_KEY = new PublicKey("5gxPdahvSzcKySxXxPuRXZZ9s6h8hZ88XDVKavWpaQGn");

// const PYTH_ORACLE_TWO: AccountInfo<Buffer> = {
// 	executable: false,
// 	lamports: LAMPORTS_PER_SOL,
// 	owner: DEFAULT_RECEIVER_PROGRAM_ID,
// 	rentEpoch: 0,
// 	data: Buffer.from(PYTH_ORACLE_TWO_DATA, 'base64'),
// };

describe('pyth pull oracles', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint;

	const feedId = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

	before(async () => {
		// use bankrun builtin function to start solana program test
		const context = await startAnchor(
			'',
			[
				{
					name: 'pyth_solana_receiver',
					programId: new PublicKey(
						'G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha'
					),
				},
			],
			[
				// load account infos into banks client like this
				{
					address: GUARDIAN_SET_KEY,
					info: GUARDIAN_SET_ACCOUNT_INFO,
				},
			]
		);

		// wrap the context to use it with the test helpers
		bankrunContextWrapper = new BankrunContextWrapper(context);

		// don't use regular bulk account loader, use test
		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		driftClient = new TestClient({
			// call toConnection to avoid annoying type error
			connection: bankrunContextWrapper.connection.toConnection(),
			// make sure to avoid regular `provider.X`, they don't show as errors
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			subAccountIds: [], // make sure to add [] for subaccounts or client will gpa
			oracleInfos: [],
			// BANKRUN DOES NOT WORK WITH WEBSOCKET
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('init feed', async () => {
		const txsig = await driftClient.initializePythPullOracle(feedId);

		console.log(txsig);
	});


	it('post atomic', async () => {
		const vaa = "UE5BVQEAAAADuAEAAAAEDQHtSV9qUiGA0667/a8yaVhJgFJAbgXat0dffZzMrziwXFWsv0bIyuabmIDu6Lz5sucPfb5FVz3g/GieoOuoEi0CAQIxhffzXsCxksZqK7W4rqeetfV5WR6ycitojPYKF5FFcQzcBmC/QbUx6dvnSjCD1kVgpNP89WJD43cu88pq5IDJAANiocdw/C2DV+9BvOTNy2y1DMdYQWyd93FAO6CalGvdOF4dW5xPXvCq4rkmba/mkifiNhy6ZHrPe0C4Oh3mMI3zAQYIriW8Hkw9FmZ0XociAX3nKcJjvldx3ZwAhzD/CN+N6RuOzFqv5c9ClCGkj30P9OBrXXBNY+W02gJBOuVQlpawAQiGEJBui+1uqD6hKIlV75K5lQiIToHQzPs45qN+jwtIgyNp/8Hairu5HeRPJYw1EfFENbSw61+TOcymMrel5NWjAQmmvp4C21quaPzGjgVN1sOrKVowA+HRL+Sr8AYMFH3HOExI/BYah2+7PRzSDvHvtzdKXr/cQDx+/VamAB5qYSjGAQrnmpyA2sEI9EyELjUi52xlq/toCSLal5je6XOPDEojBniVe2k9aO4qqChGljyzA6xkBSE31NCV05B2eC9PTzQsAQtPom+dHqkIPOrbhTo0rC374id9UMN5honjp6EmZS2R5QrAlf1YOTcu4IIWBJAOOZIbaXF6mGqf3sZCCdUi5v7mAQwlrDajCXVIsrL2WwN6N9Y068MFaNy5SjRuHWEtKevLblTpGUJMiM8SBzy5l1U0XT2ZC1O0nQN0SMbCGjM6Z4DeAA1bzwhpCjosflUFHsQKtD09NrbFGVWr1GbGGSFqhcdqqQKRNIkasBWL6g+qp+hbWNXRr/qv+9n5Z34owHvgXFWIAQ7cQKeYakG/4m/jsM8hNHZn365ltJP4ztUzkVYELQmq8xBUPQQcxtGfmBv6n2udCkDTPiYT7EqR+8JCSUVPabF7AQ8hMWVKllzBuchlBApmtDajU5IVzBISyf++Wpcxpxgm9xauwQ+PvjrWvtvx+9N2Yz+RYaHADxuPVaPMLEEnMppZABIkj9D+/a4PrxxZr4esAzgVkSK+cuDfvNQoZoFegVZoaCNk8Uqqi9l5B1SfIyMmr6sVPl2jurXvkiu9+YwLCNC1AGZ9sbAAAAAAABrhAfrtrFhR4yubI7X5QRqMK6xKrj7U3XuBHdGnLqSqcQAAAAAD6ZL2AUFVV1YAAAAAAAj0BocAACcQHNRwd10gWTV1FL3k32AsTNWGzDcBAFUA7w2Lb9os66QdoV1AldHaOSoNL47Qxse8D0z6yMKAtW0AAAADeWdFoQAAAAAA711x////+AAAAABmfbGwAAAAAGZ9sa8AAAADcw3KXAAAAAAA9OK8Ch4X9U0GnbZwLpKjKNOs1iJG5YohNxlISRULzOMZHYrl35DKqiSZ1CIrRlFrOPKYubaeHlY2PtWm7J9Xw7IB2ZpB2PyhEc+diLa/gpzxMW19m6O2zCK5ONcdQTKRJO9iAPb+J9oLIhRfJnH3rMHprU2ZSsQzchIfVGATjhgkCpBRpiw3hTID3V02VG5pLooDIbj3R3IGY6pLZ+gL+Wyn9UAy/d+jrKHl7mKRk5XihiC4SsY88oPW6HG4llj1nkijxFS8LlkePZm3";
		const txsig = await driftClient.postPythPullOracleUpdateAtomic(vaa, feedId);
		console.log(txsig);
	});
});
