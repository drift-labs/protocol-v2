import * as anchor from '@coral-xyz/anchor';
import { expect } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';
import { unpack } from '@solana/spl-token-metadata';
import {
	TOKEN_2022_PROGRAM_ID,
	unpackMint,
	ExtensionType,
	getExtensionData,
} from '@solana/spl-token';

import {
	BN,
	TestClient,
	QUOTE_PRECISION,
	getLpPoolPublicKey,
	getAmmConstituentMappingPublicKey,
	encodeName,
} from '../sdk/src';

import { initializeQuoteSpotMarket, mockUSDCMint } from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
dotenv.config();

describe('LP Pool', () => {
	const program = anchor.workspace.Drift as Program;
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;

	let adminClient: TestClient;
	let usdcMint;

	const lpPoolName = 'test pool 1';
	const tokenName = 'test pool token';
	const tokenSymbol = 'DLP-1';
	const tokenUri = 'https://token.token.token.gov';
	const tokenDecimals = 6;
	const lpPoolKey = getLpPoolPublicKey(
		program.programId,
		encodeName(lpPoolName)
	);

	before(async () => {
		const context = await startAnchor(
			'',
			[
				{
					name: 'token_2022',
					programId: new PublicKey(
						'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
					),
				},
			],
			[]
		);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		adminClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: program.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			oracleInfos: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await adminClient.initialize(usdcMint.publicKey, true);
		await adminClient.subscribe();
		await initializeQuoteSpotMarket(adminClient, usdcMint.publicKey);

		await adminClient.initializeLpPool(
			lpPoolName,
			tokenName,
			tokenSymbol,
			tokenUri,
			tokenDecimals,
			new BN(100_000_000).mul(QUOTE_PRECISION),
			Keypair.generate()
		);
	});

	after(async () => {
		await adminClient.unsubscribe();
	});

	it('can create a new LP Pool', async () => {
		// check LpPool created
		const lpPool = await adminClient.program.account.lpPool.fetch(lpPoolKey);

		// Check amm constituent map exists and has length 0
		const ammConstituentMapPublicKey = getAmmConstituentMappingPublicKey(
			program.programId,
			lpPoolKey
		);
		const ammConstituentMap =
			await adminClient.program.account.ammConstituentMapping.fetch(
				ammConstituentMapPublicKey
			);
		expect(ammConstituentMap).to.not.be.null;

		const mintAccountInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				lpPool.mint as PublicKey
			);
		const mintData = unpackMint(
			lpPool.mint,
			mintAccountInfo,
			TOKEN_2022_PROGRAM_ID
		);
		const data = getExtensionData(
			ExtensionType.TokenMetadata,
			mintData.tlvData
		);
		const tokenMetadata = unpack(data);
		expect(tokenMetadata.name).to.equal(tokenName);
		expect(tokenMetadata.symbol).to.equal(tokenSymbol);
		expect(tokenMetadata.uri).to.equal(tokenUri);
	});
});
