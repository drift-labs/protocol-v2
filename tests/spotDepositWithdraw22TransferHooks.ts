import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { Program } from '@coral-xyz/anchor';

import {
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	Transaction,
} from '@solana/web3.js';

import {
	createMintToInstruction,
	createTransferCheckedInstruction,
	getAccount,
	addExtraAccountMetasForExecute,
	createInitializeAccountInstruction,
	getAccountLenForMint,
} from '@solana/spl-token';

import {
	TestClient,
	BN,
	EventSubscriber,
	SPOT_MARKET_RATE_PRECISION as _SPOT_MARKET_RATE_PRECISION,
	SpotBalanceType as _SpotBalanceType,
	isVariant as _isVariant,
	OracleSource,
	SPOT_MARKET_WEIGHT_PRECISION as _SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION as _SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	OracleInfo,
} from '../sdk/src';

import {
	createUserWithUSDCAccount as _createUserWithUSDCAccount,
	createUserWithUSDCAndWSOLAccount as _createUserWithUSDCAndWSOLAccount,
	mintUSDCToUser as _mintUSDCToUser,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs as _printTxLogs,
	sleep as _sleep,
} from './testHelpers';
import {
	getBalance as _getBalance,
	calculateInterestAccumulated as _calculateInterestAccumulated,
	getTokenAmount as _getTokenAmount,
} from '../sdk/src/math/spotBalance';
import {
	getMint,
	NATIVE_MINT as _NATIVE_MINT,
	TOKEN_2022_PROGRAM_ID,
	createInitializeMintInstruction,
	createInitializeTransferHookInstruction,
	ExtensionType,
	getMintLen,
	getTransferHook,
	ExtraAccountMeta as _ExtraAccountMeta,
	getExtraAccountMetas,
	getExtraAccountMetaAddress,
	resolveExtraAccountMeta,
} from '@solana/spl-token';
import {
	QUOTE_PRECISION as _QUOTE_PRECISION,
	ZERO as _ZERO,
	ONE as _ONE,
	SPOT_MARKET_BALANCE_PRECISION as _SPOT_MARKET_BALANCE_PRECISION,
	PRICE_PRECISION as _PRICE_PRECISION,
} from '../sdk/lib/node';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import {
	BankrunConnection as _BankrunConnection,
	BankrunContextWrapper,
} from '../sdk/src/bankrun/bankrunConnection';
import {
	initializeExtraAccountMetaList,
	CustomExtraAccountMeta as _CustomExtraAccountMeta,
} from './splTransferHookClient';

const transferHookProgramId = new PublicKey(
	'4qXcCexy21qw66VgPqZjVyL9PTHsB6CdbSCZsDTac6Qq'
);

describe('spot deposit and withdraw 22', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let admin: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;

	const _usdcAmount = new BN(10 * 10 ** 6);
	const largeUsdcAmount = new BN(10_000 * 10 ** 6);

	const _solAmount = new BN(1 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	let mintAuthority: Keypair;
	let mintKeypair: Keypair;
	let mint: PublicKey;
	let extraAccountPda: PublicKey;

	before(async () => {
		const context = await startAnchor(
			'',
			[
				{
					name: 'spl_transfer_hook_example',
					programId: transferHookProgramId,
				},
			],
			[]
		);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper, TOKEN_2022_PROGRAM_ID);
		await mockUserUSDCAccount(usdcMint, largeUsdcAmount, bankrunContextWrapper);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 30);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		admin = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await admin.initialize(usdcMint.publicKey, true);
		await admin.subscribe();

		// create token with transfer hook
		mintAuthority = Keypair.generate();
		mintKeypair = Keypair.generate();
		mint = mintKeypair.publicKey;

		const extensions = [ExtensionType.TransferHook];
		const mintLen = getMintLen(extensions);
		const decimals = 9;

		const payer = bankrunContextWrapper.provider.wallet.publicKey;
		const mintTransaction = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: payer,
				newAccountPubkey: mint,
				space: mintLen,
				lamports: LAMPORTS_PER_SOL,
				programId: TOKEN_2022_PROGRAM_ID,
			}),
			createInitializeTransferHookInstruction(
				mint,
				payer,
				transferHookProgramId,
				TOKEN_2022_PROGRAM_ID
			),
			createInitializeMintInstruction(
				mint,
				decimals,
				mintAuthority.publicKey,
				null,
				TOKEN_2022_PROGRAM_ID
			)
		);
		await bankrunContextWrapper.sendTransaction(mintTransaction, [
			bankrunContextWrapper.provider.wallet.payer,
			mintKeypair,
		]);

		// some random account that the token hook needs at transfer time
		extraAccountPda = PublicKey.findProgramAddressSync(
			[Buffer.from('custom-acc'), mint.toBuffer()],
			transferHookProgramId
		)[0];

		await initializeExtraAccountMetaList(
			bankrunContextWrapper.connection.toConnection(),
			transferHookProgramId,
			mint,
			mintAuthority,
			bankrunContextWrapper.provider.wallet.payer,
			[
				{
					addressConfig: extraAccountPda,
					isSigner: false,
					isWritable: true,
				},
			]
		);

		await bankrunContextWrapper.moveTimeForward(100);
	});

	after(async () => {
		await admin.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize TransferHookToken Market', async () => {
		const mintAcc = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			mint,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const hookAcc = getTransferHook(mintAcc);
		assert.isNotNull(hookAcc);

		const metasAddress = getExtraAccountMetaAddress(mint, hookAcc!.programId);
		const metasAcc = await bankrunContextWrapper.connection.getAccountInfo(
			metasAddress
		);
		assert.isNotNull(metasAcc);

		const extraAccountMetas = getExtraAccountMetas(metasAcc!);
		assert.isNotNull(extraAccountMetas);

		assert.equal(extraAccountMetas.length, 1);
		for (const meta of extraAccountMetas) {
			const r = await resolveExtraAccountMeta(
				bankrunContextWrapper.connection.toConnection(),
				meta,
				[],
				Buffer.from([]),
				hookAcc!.programId
			);
			const extraAcc = await bankrunContextWrapper.connection.getAccountInfo(
				r.pubkey
			);
			assert.isNotNull(extraAcc);
		}
	});

	it('Can mint tokens and transfer between accounts', async () => {
		// Create two user keypairs
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();

		// Create token accounts for both users
		// Create token accounts for both users
		const user1TokenAccountKeypair = Keypair.generate();
		const user2TokenAccountKeypair = Keypair.generate();

		const mintState = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			mint,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const space = getAccountLenForMint(mintState);
		const lamports =
			await bankrunContextWrapper.connection.getMinimumBalanceForRentExemption(
				space
			);

		// Create user1's token account
		const createUser1AccountTx = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.provider.wallet.payer.publicKey,
				newAccountPubkey: user1TokenAccountKeypair.publicKey,
				space,
				lamports,
				programId: TOKEN_2022_PROGRAM_ID,
			}),
			createInitializeAccountInstruction(
				user1TokenAccountKeypair.publicKey,
				mint,
				user1.publicKey,
				TOKEN_2022_PROGRAM_ID
			)
		);

		await bankrunContextWrapper.sendTransaction(createUser1AccountTx, [
			bankrunContextWrapper.provider.wallet.payer,
			user1TokenAccountKeypair,
		]);

		// Create user2's token account
		const createUser2AccountTx = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.provider.wallet.payer.publicKey,
				newAccountPubkey: user2TokenAccountKeypair.publicKey,
				space,
				lamports,
				programId: TOKEN_2022_PROGRAM_ID,
			}),
			createInitializeAccountInstruction(
				user2TokenAccountKeypair.publicKey,
				mint,
				user2.publicKey,
				TOKEN_2022_PROGRAM_ID
			)
		);

		await bankrunContextWrapper.sendTransaction(createUser2AccountTx, [
			bankrunContextWrapper.provider.wallet.payer,
			user2TokenAccountKeypair,
		]);

		const user1TokenAccount = user1TokenAccountKeypair.publicKey;
		const user2TokenAccount = user2TokenAccountKeypair.publicKey;

		// Amount to mint and transfer (1000 tokens with 9 decimals)
		const mintAmount = BigInt(1000 * 10 ** 9);
		const transferAmount = BigInt(300 * 10 ** 9);

		// Mint tokens to user1's account
		const mintTransaction = new Transaction().add(
			createMintToInstruction(
				mint,
				user1TokenAccount,
				mintAuthority.publicKey,
				mintAmount,
				[],
				TOKEN_2022_PROGRAM_ID
			)
		);

		await bankrunContextWrapper.sendTransaction(mintTransaction, [
			bankrunContextWrapper.provider.wallet.payer,
			mintAuthority,
		]);

		// Check initial balances
		const user1BalanceBefore = await getAccount(
			bankrunContextWrapper.connection.toConnection(),
			user1TokenAccount,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const user2BalanceBefore = await getAccount(
			bankrunContextWrapper.connection.toConnection(),
			user2TokenAccount,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);

		console.log(
			'User1 balance before transfer:',
			user1BalanceBefore.amount.toString()
		);
		console.log(
			'User2 balance before transfer:',
			user2BalanceBefore.amount.toString()
		);

		assert.equal(
			user1BalanceBefore.amount,
			mintAmount,
			'User1 should have minted amount'
		);
		assert.equal(
			user2BalanceBefore.amount,
			BigInt(0),
			'User2 should start with 0 balance'
		);

		// Get mint info for decimals
		const mintInfo = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			mint,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);

		// Create transfer instruction with transfer hook support
		const transferInstruction = createTransferCheckedInstruction(
			user1TokenAccount,
			mint,
			user2TokenAccount,
			user1.publicKey,
			transferAmount,
			mintInfo.decimals,
			[],
			TOKEN_2022_PROGRAM_ID
		);

		// Add extra account metas for the transfer hook
		await addExtraAccountMetasForExecute(
			bankrunContextWrapper.connection.toConnection(),
			transferInstruction,
			transferHookProgramId,
			user1TokenAccount,
			mint,
			user2TokenAccount,
			user1.publicKey,
			transferAmount
		);

		const transferTransaction = new Transaction().add(transferInstruction);

		await bankrunContextWrapper.sendTransaction(transferTransaction, [
			bankrunContextWrapper.provider.wallet.payer,
			user1,
		]);

		// Check final balances
		const user1BalanceAfter = await getAccount(
			bankrunContextWrapper.connection.toConnection(),
			user1TokenAccount,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const user2BalanceAfter = await getAccount(
			bankrunContextWrapper.connection.toConnection(),
			user2TokenAccount,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);

		console.log(
			'User1 balance after transfer:',
			user1BalanceAfter.amount.toString()
		);
		console.log(
			'User2 balance after transfer:',
			user2BalanceAfter.amount.toString()
		);

		// Verify the transfer worked correctly
		const expectedUser1Balance = mintAmount - transferAmount;
		assert.equal(
			user1BalanceAfter.amount,
			expectedUser1Balance,
			'User1 should have reduced balance'
		);
		assert.equal(
			user2BalanceAfter.amount,
			transferAmount,
			'User2 should have received transfer amount'
		);

		// Verify total supply is conserved
		const totalBalance = user1BalanceAfter.amount + user2BalanceAfter.amount;
		assert.equal(
			totalBalance,
			mintAmount,
			'Total balance should equal minted amount'
		);
	});
});
