import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
const serumHelper = require('./serumHelper');

import {
	Admin,
	BN,
	ClearingHouse,
	EventSubscriber,
	BANK_RATE_PRECISION,
	BankBalanceType,
	isVariant,
	OracleSource,
	BANK_WEIGHT_PRECISION,
	BANK_CUMULATIVE_INTEREST_PRECISION,
	OracleInfo,
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	createUserWithUSDCAndWSOLAccount,
	getTokenAmountAsBN,
	mintUSDCToUser,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	sleep,
} from './testHelpers';
import {
	getBalance,
	calculateInterestAccumulated,
	getTokenAmount,
} from '../sdk/src/math/bankBalance';
import { NATIVE_MINT } from '@solana/spl-token';
import { QUOTE_PRECISION, ZERO, ONE } from '../sdk';
import { Market } from '@project-serum/serum';

describe('test', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let admin: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserClearingHouse: ClearingHouse;
	let firstUserClearingHouseUSDCAccount: PublicKey;

	let secondUserClearingHouse: ClearingHouse;
	let secondUserClearingHouseWSOLAccount: PublicKey;
	let secondUserClearingHouseUSDCAccount: PublicKey;

	const usdcAmount = new BN(10 * 10 ** 6);
	const solAmount = new BN(1 * 10 ** 9);

	let marketIndexes: BN[];
	let bankIndexes: BN[];
	let oracleInfos: OracleInfo[];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solOracle = await mockOracle(30);
	});

	it('Test', async () => {
		const marketAPublicKey = await serumHelper.listMarket({
			connection,
			wallet: provider.wallet,
			baseMint: NATIVE_MINT,
			quoteMint: usdcMint.publicKey,
			baseLotSize: 1000000,
			quoteLotSize: 10000,
			dexProgramId: serumHelper.DEX_PID,
			feeRateBps: 0,
		});

		const market = await Market.load(
			provider.connection,
			marketAPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);

		console.log(market);
	});
});
