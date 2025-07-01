import * as anchor from '@coral-xyz/anchor';
import { expect } from 'chai';
import { Program } from '@coral-xyz/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
	BN,
	TestClient,
	QUOTE_PRECISION,
	OracleSource,
	calculateBidAskPrice,
	convertToNumber,
	OrderType,
	BASE_PRECISION,
	PositionDirection,
	DriftClient,
	isVariant,
} from '../sdk/src';
import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
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

// 1MPEPE-PERP
const marketPubkey = new PublicKey(
	'GsMte91Y1eY9XYtY1nt1Ax77V5hzsj3rr1a7a29mxHZw'
);
const marketIndex = 10;
const oraclePubkey = new PublicKey(
	'Eo8x9Y1289GvsuYVwRS2R8HfiWRXxYofL1KYvHK2ZM2o'
);
const oracleSource = OracleSource.PYTH_LAZER_1M;
const marketSnapshotBytes =
	'0adf0c2c6bf537f7ebc5f713a1eebbe52ad08af6f417aed85122d533728331aaacae7c1cf1fc1cceccf9a3244f7965a75c10c05f359aadbb808523d3d1b7e8cb2e32c9604bc6da08b8579a00000000000000000000000000000000000000000026689a000000000012699a0000000000f71853680000000035d1a5c61d00000000000000000000002836fc9d00000000000000000000000019c19b0727d500000000000000000000000000000000000018b0ff41782207000000000000000000502481ab6227070000000000000000003c6b1200000000000000000000000000c4fdee3020eb0500000000000000000093469bd9ac9f08000000000000000000b1c7840aed2407000000000000000000aaed99000000000000000000000000001f016f8ff1240700000000000000000000d27f92b00b000000000000000000000014582ebff6fffffffffffffffffffffcb99d43700200000000000000000000042c3a7dffffffffffffffffffffffff0080c6a47e8d03000000000000000000c90d0a3bfeffffffffffffffffffffffb1782f4cddffffffffffffffffffffff6ee036a919000000000000000000000021371fb8dcffffffffffffffffffffffee9f3fc61b0000000000000000000000009eff3786030000000000000000000053e103000000000053e103000000000053e1030000000000faf4040000000000bdfe266c4500000000000000000000005be6e8d73800000000000000000000003e4ca2a10c0000000000000000000000e528578d4b0000000000000000000000000000000000000000000000000000008c4d8aa31400000000000000000000000530837a0100000000000000000000002b32817a01000000000000000000000000000000000000000000000000000000527b02fbd31b070000000000000000007b07d1be112e07000000000000000000cb9d314bb52507000000000000000000c69cc2df242407000000000000000000b8579a0000000000000000000000000006289a0000000000a1fd9a0000000000d3929a000000000023bd9a000000000020feb81400000000a9010000000000003463f3f6ffffffffd50c536800000000100e00000000000000ca9a3b00000000640000000000000000f2052a0100000000000000000000007806d8c20d000000b124804a00000000a03db450000000001e07536800000000120e0000000000006e10000000000000f718536800000000e8030000905f01006c1c0000d00d00001d0000002a000000e803320064640e01000000000400000072571d0900000000c8109b93010000004057f0f6ffffffff00000000000000000000000000000000cad66686df3f000000000000000000000000000000000000314d504550452d5045525020202020202020202020202020202020202020202000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000c0ed000000000000ec46000000000000231f000000000000ee020000ee020000a861000050c30000c4090000e204000000000000102700007b000000510000000a00010003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
const oracleSnapshotBytes =
	'9f07a1f9225179853d8b010000000000802e6ff8dd3706003efeb81400000000f6ffffff000000000c00000000000000';

const usdcMintAmount = new BN(100_000_000).mul(QUOTE_PRECISION);

type placeVammTradeParams = {
	bankrunContextWrapper: BankrunContextWrapper;
	orderClient: TestClient;
	fillerClient: DriftClient;
	marketIndex: number;
	baseAssetAmount: BN;
	auctionStartPrice: BN;
	auctionEndPrice: BN;
	auctionDuration: number;
	direction: PositionDirection;
	maxTs: BN;
};

async function placeVammTrade({
	bankrunContextWrapper,
	orderClient,
	fillerClient,
	marketIndex,
	baseAssetAmount,
	auctionStartPrice,
	auctionEndPrice,
	auctionDuration,
	direction,
	maxTs,
}: placeVammTradeParams) {
	let tx = null;
	try {
		tx = await orderClient.placePerpOrder({
			orderType: OrderType.LIMIT,
			marketIndex,
			baseAssetAmount,
			direction,
			auctionDuration,
			auctionStartPrice,
			auctionEndPrice,
			price: new BN(10196000),
			maxTs,
		});
	} catch (e) {
		console.log('place order failed!');
		console.log(e);
	}
	await printTxLogs(bankrunContextWrapper.connection.toConnection(), tx);
	await printTxLogs(bankrunContextWrapper.connection.toConnection(), tx);
	// let events = parseLogsWithRaw(program, logs);
	// console.log(events.events.map(e => e.data));

	await bankrunContextWrapper.moveTimeForward(30);

	await orderClient.fetchAccounts();
	const pos = orderClient.getUser(0).getPerpPosition(marketIndex);
	console.log('base: ', convertToNumber(pos.baseAssetAmount, BASE_PRECISION));
	console.log('quote:', convertToNumber(pos.quoteAssetAmount, QUOTE_PRECISION));

	const openOrders = orderClient.getUser(0).getOpenOrders();
	const order = openOrders.length > 0 ? openOrders[0] : null;
	if (!order) {
		throw new Error('No open orders found');
	}

	const orderUser = orderClient.getUser(0);
	const orderUserAcc = await orderClient.getUserAccountPublicKey();

	try {
		tx = await fillerClient.fillPerpOrder(
			orderUserAcc,
			orderUser.getUserAccount(),
			order
		);
		await printTxLogs(bankrunContextWrapper.connection.toConnection(), tx);
		// events = parseLogsWithRaw(program, logs);
		// console.log(events.events.map(e => e.data));
	} catch (e) {
		console.log('fill failed!');
		console.error(e);
	}
}

describe('Reference Price Offset E2E', () => {
	const program = anchor.workspace.Drift as Program;
	// @ts-ignore
	program.coder.accounts = new CustomBorshAccountsCoder(program.idl);
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;

	let adminClient: TestClient;
	let fillerDriftClient: DriftClient;
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
			[
				{
					address: marketPubkey,
					info: {
						executable: false,
						owner: program.programId,
						lamports: LAMPORTS_PER_SOL,
						data: Buffer.from(marketSnapshotBytes, 'hex'),
					},
				},
				{
					address: oraclePubkey,
					info: {
						executable: false,
						owner: program.programId,
						lamports: LAMPORTS_PER_SOL,
						data: Buffer.from(oracleSnapshotBytes, 'hex'),
					},
				},
			]
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
		// bankrunContextWrapper.context.setAccount(marketPubkey, {
		// 	executable: false,
		// 	owner: program.programId,
		// 	lamports: LAMPORTS_PER_SOL,
		// 	data: Buffer.from(marketSnapshotBytes, 'hex'),
		// });
		// bankrunContextWrapper.context.setAccount(oraclePubkey, {
		// 	executable: false,
		// 	owner: program.programId,
		// 	lamports: LAMPORTS_PER_SOL,
		// 	data: Buffer.from(oracleSnapshotBytes, 'hex'),
		// });

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
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0, 1, 2],
			oracleInfos: [
				{
					publicKey: oraclePubkey,
					source: oracleSource,
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
			usdcMintAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);

		await adminClient.initializeUserAccountAndDepositCollateral(
			usdcMintAmount,
			userUSDCAccount.publicKey
		);

		/// why have to do this manually and bulk acc lodaer not handle
		await adminClient.accountSubscriber.addPerpMarket(0);
		await adminClient.accountSubscriber.addOracle({
			publicKey: oraclePubkey,
			source: OracleSource.PYTH_LAZER,
		});
		await adminClient.accountSubscriber.setPerpOracleMap();

		const keypair2 = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair2, 50 * LAMPORTS_PER_SOL);
		fillerDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(keypair2),
			programID: program.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0, 1],
			// subAccountIds: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: oraclePubkey,
					source: oracleSource,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await fillerDriftClient.subscribe();

		await fillerDriftClient.initializeUserAccount();
	});

	after(async () => {
		await adminClient.unsubscribe();
	});

	it('should overwrite perp accounts', async () => {
		await adminClient.fetchAccounts();

		const oracle = adminClient.getOracleDataForPerpMarket(marketIndex);

		const perpMarket0 = adminClient.getPerpMarketAccount(marketIndex);
		expect(perpMarket0.amm.curveUpdateIntensity).to.equal(100);
		expect(perpMarket0.amm.referencePriceOffset).to.equal(0);

		const [vBid, vAsk] = calculateBidAskPrice(
			perpMarket0.amm,
			oracle,
			true,
			false
		);
		const vBidNum = convertToNumber(vBid);
		const vAskNum = convertToNumber(vAsk);
		const spread = (vAskNum - vBidNum) / ((vAskNum + vBidNum) / 2);
		console.log(
			`Before ref price: vBid: ${vBidNum}, vAsk: ${vAskNum}, spread: ${
				spread * 10000
			}bps`
		);
		console.log(
			`Vamm inventory: ${
				-1 *
				convertToNumber(perpMarket0.amm.baseAssetAmountWithAmm, BASE_PRECISION)
			}`
		);

		// perpMarket0.amm.curveUpdateIntensity = 200;
		// await overWritePerpMarket(
		// 	adminClient,
		// 	bankrunContextWrapper,
		// 	perpMarket0.pubkey,
		// 	perpMarket0
		// );
		await adminClient.fetchAccounts();

		const perpMarket2 = adminClient.getPerpMarketAccount(marketIndex);
		// expect(perpMarket2.amm.curveUpdateIntensity).to.equal(200);
		// await adminClient.updateAMMs([marketIndex]);

		expect(perpMarket2.amm.referencePriceOffset).to.equal(0);

		const [vBid2, vAsk2] = calculateBidAskPrice(
			perpMarket2.amm,
			oracle,
			false,
			false
		);
		const vBidNum2 = convertToNumber(vBid2);
		const vAskNum2 = convertToNumber(vAsk2);
		const spread2 = (vAskNum2 - vBidNum2) / ((vAskNum2 + vBidNum2) / 2);
		console.log(
			`Before fills price: vBid:  ${vBidNum2}, vAsk: ${vAskNum2}, spread: ${
				spread2 * 10000
			}bps`
		);
		console.log(
			`Vamm inventory: ${
				-1 *
				convertToNumber(perpMarket2.amm.baseAssetAmountWithAmm, BASE_PRECISION)
			}`
		);

		// new BN(100000).mul(BASE_PRECISION),
		for (let i = 0; i < 1; i++) {
			const now = bankrunContextWrapper.connection.getTime();
			await adminClient.fetchAccounts();
			const perpMarket = adminClient.getPerpMarketAccount(marketIndex);
			const [_vBid2, vAsk2] = calculateBidAskPrice(
				perpMarket.amm,
				oracle,
				true,
				false
			);
			const vBidNum2 = convertToNumber(vBid2);
			const vAskNum2 = convertToNumber(vAsk2);
			const spread2 = (vAskNum2 - vBidNum2) / ((vAskNum2 + vBidNum2) / 2);
			console.log(
				`Before fill2 price: vBid:  ${vBidNum2}, vAsk: ${vAskNum2}, spread: ${
					spread2 * 10000
				}bps`
			);
			console.log(
				`Vamm inventory: ${
					-1 *
					convertToNumber(
						perpMarket2.amm.baseAssetAmountWithAmm,
						BASE_PRECISION
					)
				}`
			);
			// const direction = i % 2 === 0 ? PositionDirection.LONG : PositionDirection.SHORT;
			const direction = PositionDirection.LONG;
			const auctionStartPrice = isVariant(direction, 'long') ? vBid2 : vAsk2;
			const auctionEndPrice = isVariant(direction, 'long') ? vAsk2 : vBid2;

			await placeVammTrade({
				bankrunContextWrapper,
				orderClient: adminClient,
				fillerClient: fillerDriftClient,
				marketIndex,
				baseAssetAmount: new BN(5).mul(BASE_PRECISION),
				auctionStartPrice,
				auctionEndPrice,
				auctionDuration: 20,
				direction,
				maxTs: new BN(now + 60),
			});
			await bankrunContextWrapper.moveTimeForward(10);
		}

		const perpMarket3 = adminClient.getPerpMarketAccount(marketIndex);

		const [vBid3, vAsk3] = calculateBidAskPrice(
			perpMarket3.amm,
			oracle,
			true,
			false
		);
		const vBidNum3 = convertToNumber(vBid3);
		const vAskNum3 = convertToNumber(vAsk3);
		const spread3 = (vAskNum3 - vBidNum3) / ((vAskNum3 + vBidNum3) / 2);
		console.log(
			`After fills: vBid:  ${vBidNum3}, vAsk: ${vAskNum3}, spread: ${
				spread3 * 10000
			}bps`
		);
		console.log(
			`Vamm inventory: ${
				-1 *
				convertToNumber(perpMarket3.amm.baseAssetAmountWithAmm, BASE_PRECISION)
			}`
		);

		await adminClient.fetchAccounts();
		const pos = adminClient.getUser(0).getPerpPosition(marketIndex);
		const base = convertToNumber(pos.baseAssetAmount, BASE_PRECISION);
		const quote = convertToNumber(pos.quoteAssetAmount, QUOTE_PRECISION);
		const entryPrice = Math.abs(quote / base);
		console.log('base: ', base);
		console.log('quote:', quote);
		console.log('entryPrice:', entryPrice);
	});
});
