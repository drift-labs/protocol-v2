import * as anchor from '@coral-xyz/anchor';
import { expect } from 'chai';
import { Program } from '@coral-xyz/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
	BN,
	TestClient,
	QUOTE_PRECISION,
	PRICE_PRECISION,
	OracleSource,
	PERCENTAGE_PRECISION,
	calculateBidAskPrice,
} from '../sdk/src';
import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
	overWritePerpMarket,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
import {
	CustomBorshAccountsCoder,
	CustomBorshCoder,
} from '../sdk/src/decode/customCoder';
dotenv.config();

// SOL-PERP
const solPerpMarketBytes =
	'0adf0c2c6bf537f76f007dc417aef206a69441eadcb699b8caaa4af90352ad7090cfbea9f81fa46b290362271e4c3b69c7b52905f73fa23fae1841b086b2148f347889f1fe952fe1a7a7a8080000000000000000000000000000000000000000f16ba30800000000f51aa7080000000059fb52680000000093b02897b8ffffffffffffffffffffff7a0d7ab6f5ffffffffffffffffffffffcc794535c5560f0000000000000000000000000000000000e8240c803cdc48000000000000000000dbdec2414aa4480000000000000000006e520f00000000000000000000000000c1565825a073480000000000000000008e8160a1970d49000000000000000000bdfe28003ec048000000000000000000d852af08000000000000000000000000e1b116d808c04800000000000000000000194f68e2f00100000000000000000080c76a0354f3fdffffffffffffffffffbcfd55a836e4ffffffffffffffffffffc4e263c3ffffffffffffffffffffffff00008d49fd1a07000000000000000000b35245e4240800000000000000000000e34c0f6314b5ffffffffffffffffffff631c3c45354e00000000000000000000680a85f364b5ffffffffffffffffffff74a1b77ec94d000000000000000000002b7212e89533000000000000000000004b7d0600000000004b7d0600000000004b7d060000000000d28801000000000073810318ee0c000000000000000000001c2506a87b030000000000000000000073f2b5228a0900000000000000000000533f70078a0600000000000000000000ad27b0e0b2050000000000000000000090b06954bd03000000000000000000005862208c0b0000000000000000000000dd06d67f0b0000000000000000000000c1b8f90c0100000000000000000000007c3ae02c2edc4800000000000000000072bbf18958a448000000000000000000719a75c2b5dd48000000000000000000df29a328d2a248000000000000000000a7a7a808000000000000000000000000a708a30800000000ed4ea30800000000ca2ba30800000000c802a708000000002ab4b814000000003b05000000000000a56f5b0903000000a1f0526800000000100e0000000000008096980000000000640000000000000080969800000000000000000000000000de17cb40c13c000039eaedc0e1000000f13a814ba20000004cfb526800000000a478050000000000b63b0500000000004cfb5268000000000a00000020030000070000009e000000000000002d000000a861320064640c01c0c852de0300a600fd7f871400000000d2f81cd200000000476293b9e5ffffff00000000000000000000000000000000811377379662220000000000000000000000000000000000534f4c2d50455250202020202020202020202020202020202020202020202020009b32e2ffffffff0065cd1d00000000ff0fa5d4e8000000331f4c38190000004cf552680000000000e1f5050000000000000000000000000000000000000000b94eb200000000006b590000000000005d0d00000000000064000000000000004c1d00004c1d0000f40100002c010000000000001027000017110000440d00000000010001000000b5ff00000000630042000000000000000000000000000000000000000000000000000000000000000000000000000000';
const solPerpOracleBytes =
	'9f07a1f922517985b5b102620300000008158f34dc37060049b4b81400000000f8ffffff0000000051d6110000000000';

const solMarket = new PublicKey('8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W');
const solOracle = new PublicKey('3m6i4RFWEDw2Ft4tFHPJtYgmpPe21k56M3FHeWYrgGBz');

describe('Reference Price Offset E2E', () => {
	const program = anchor.workspace.Drift as Program;
	// @ts-ignore
	program.coder.accounts = new CustomBorshAccountsCoder(program.idl);
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;

	let adminClient: TestClient;
	let usdcMint: Keypair;

	let userUSDCAccount: Keypair;

	before(async () => {
		const context = await startAnchor(
			'',
			[
				{
					name: 'serum_dex',
					programId: new PublicKey(
						'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
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

		// seed SOL-PERP market and oracle accounts
		bankrunContextWrapper.context.setAccount(solMarket, {
			executable: false,
			owner: program.programId,
			lamports: LAMPORTS_PER_SOL,
			data: Buffer.from(solPerpMarketBytes, 'hex'),
		});
		bankrunContextWrapper.context.setAccount(solOracle, {
			executable: false,
			owner: program.programId,
			lamports: LAMPORTS_PER_SOL,
			data: Buffer.from(solPerpOracleBytes, 'hex'),
		});

		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 50 * LAMPORTS_PER_SOL);

		adminClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(keypair),
			programID: program.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes: [0, 1],
			spotMarketIndexes: [0, 1, 2],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
			coder: new CustomBorshCoder(program.idl),
		});

		await adminClient.initialize(usdcMint.publicKey, true);
		await adminClient.subscribe();
		await initializeQuoteSpotMarket(adminClient, usdcMint.publicKey);

		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			new BN(10).mul(QUOTE_PRECISION),
			bankrunContextWrapper,
			keypair.publicKey
		);

		await adminClient.initializeUserAccountAndDepositCollateral(
			new BN(10).mul(QUOTE_PRECISION),
			userUSDCAccount.publicKey
		);

		/// why have to do this manually and bulk acc lodaer not handle
		await adminClient.accountSubscriber.addPerpMarket(0);
		await adminClient.accountSubscriber.addOracle({
			publicKey: solOracle,
			source: OracleSource.PYTH_LAZER,
		});
		await adminClient.accountSubscriber.setPerpOracleMap();
	});

	after(async () => {
		await adminClient.unsubscribe();
	});

	it('should overwrite perp accounts', async () => {
		await adminClient.fetchAccounts();

		const perpMarket0 = adminClient.getPerpMarketAccount(0);
		expect(perpMarket0.amm.curveUpdateIntensity).to.equal(100);
		expect(perpMarket0.amm.referencePriceOffset).to.equal(0);

		const oracle = adminClient.getOracleDataForPerpMarket(0);

		perpMarket0.amm.curveUpdateIntensity = 200;
		perpMarket0.amm.referencePriceOffset =
			PERCENTAGE_PRECISION.toNumber() / 1000; // 10 bps
		await overWritePerpMarket(
			adminClient,
			bankrunContextWrapper,
			perpMarket0.pubkey,
			perpMarket0
		);
		await adminClient.fetchAccounts();
		const [vBid, vAsk] = calculateBidAskPrice(
			perpMarket0.amm,
			oracle,
			true,
			false
		);
		console.log(
			`Before ref price: vBid: ${vBid.toString()}, vAsk: ${vAsk.toString()}`
		);

		const perpMarket2 = adminClient.getPerpMarketAccount(0);
		expect(perpMarket2.amm.curveUpdateIntensity).to.equal(200);
		expect(perpMarket2.amm.referencePriceOffset).to.equal(
			PERCENTAGE_PRECISION.toNumber() / 1000
		);

		const [vBid2, vAsk2] = calculateBidAskPrice(
			perpMarket0.amm,
			oracle,
			true,
			false
		);
		console.log(
			`After ref price: vBid: ${vBid2.toString()}, vAsk: ${vAsk2.toString()}`
		);
	});
});
