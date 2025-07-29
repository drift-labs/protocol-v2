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
	createUpdateTransferHookInstruction,
} from '@solana/spl-token';

import {
	TestClient,
	BN,
	OracleSource,
	OracleInfo,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	QUOTE_PRECISION,
	getTokenAmount,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
} from './testHelpers';
import {
	getMint,
	TOKEN_2022_PROGRAM_ID,
	createInitializeMintInstruction,
	createInitializeTransferHookInstruction,
	ExtensionType,
	getMintLen,
	getTransferHook,
	getExtraAccountMetas,
	getExtraAccountMetaAddress,
	resolveExtraAccountMeta,
} from '@solana/spl-token';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/bulkAccountLoader/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { initializeExtraAccountMetaList } from './splTransferHookClient';

const transferHookProgramId = new PublicKey(
	'4qXcCexy21qw66VgPqZjVyL9PTHsB6CdbSCZsDTac6Qq'
);

describe('spot deposit and withdraw 22', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let firstUserKeypair: Keypair;
	let firstUserDriftClient: TestClient;
	let firstUserTokenAccount: PublicKey;

	let admin: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;
	let usdcMint;

	const usdcAmount = new BN(10 * 10 ** 6);
	const largeUsdcAmount = new BN(10_000 * 10 ** 6);

	const _solAmount = new BN(1 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	let mintAuthority: Keypair;
	let mintKeypair: Keypair;
	let mint: PublicKey;
	let extraAccountPda: PublicKey;
	let mintOracle: PublicKey;

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

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

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

		await initializeQuoteSpotMarket(admin, usdcMint.publicKey);

		let _firstUserDriftClientUSDCAccount: PublicKey;
		[firstUserDriftClient, _firstUserDriftClientUSDCAccount, firstUserKeypair] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		// create token with transfer hook
		mintAuthority = Keypair.generate();
		mintKeypair = Keypair.generate();
		mint = mintKeypair.publicKey;

		mintOracle = await mockOracleNoProgram(bankrunContextWrapper, 0.05); // a future we all need to believe in

		const extensions = [ExtensionType.TransferHook];
		const mintLen = getMintLen(extensions);
		const decimals = 6;

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
		await firstUserDriftClient.unsubscribe();
	});

	it('Initialize TransferHookToken', async () => {
		const mintAcc = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			mint,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const hookAcc = getTransferHook(mintAcc);
		assert.isNotNull(hookAcc);
		assert.isTrue(hookAcc!.programId.equals(transferHookProgramId));

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
		const user2 = Keypair.generate();

		// Create token accounts for both users
		// Create token accounts for both users
		const user1TokenAccountKeypair = Keypair.generate();
		const user2TokenAccountKeypair = Keypair.generate();
		firstUserTokenAccount = user1TokenAccountKeypair.publicKey;

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
				firstUserKeypair.publicKey,
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

		// const user1TokenAccount = user1TokenAccountKeypair.publicKey;
		// const user2TokenAccount = user2TokenAccountKeypair.publicKey;

		// Amount to mint and transfer (1000 tokens with 9 decimals)
		const mintAmount = BigInt(1000 * 10 ** 9);
		const transferAmount = BigInt(300 * 10 ** 9);

		// Mint tokens to user1's account
		const mintTransaction = new Transaction().add(
			createMintToInstruction(
				mint,
				user1TokenAccountKeypair.publicKey,
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
			user1TokenAccountKeypair.publicKey,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const user2BalanceBefore = await getAccount(
			bankrunContextWrapper.connection.toConnection(),
			user2TokenAccountKeypair.publicKey,
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
			user1TokenAccountKeypair.publicKey,
			mint,
			user2TokenAccountKeypair.publicKey,
			firstUserKeypair.publicKey,
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
			user1TokenAccountKeypair.publicKey,
			mint,
			user2TokenAccountKeypair.publicKey,
			firstUserKeypair.publicKey,
			transferAmount
		);

		const transferTransaction = new Transaction().add(transferInstruction);

		await bankrunContextWrapper.sendTransaction(transferTransaction, [
			bankrunContextWrapper.provider.wallet.payer,
			firstUserKeypair,
		]);

		// Check final balances
		const user1BalanceAfter = await getAccount(
			bankrunContextWrapper.connection.toConnection(),
			user1TokenAccountKeypair.publicKey,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const user2BalanceAfter = await getAccount(
			bankrunContextWrapper.connection.toConnection(),
			user2TokenAccountKeypair.publicKey,
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

	it('Initialize TransferHookToken SpotMarket', async () => {
		await admin.initializeSpotMarket(
			mint,
			SPOT_MARKET_RATE_PRECISION.divn(2).toNumber(),
			SPOT_MARKET_RATE_PRECISION.mul(new BN(20)).toNumber(),
			SPOT_MARKET_RATE_PRECISION.mul(new BN(50)).toNumber(),
			mintOracle,
			OracleSource.PYTH,
			SPOT_MARKET_WEIGHT_PRECISION.toNumber(),
			SPOT_MARKET_WEIGHT_PRECISION.toNumber(),
			SPOT_MARKET_WEIGHT_PRECISION.toNumber(),
			SPOT_MARKET_WEIGHT_PRECISION.toNumber(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		);
		await admin.updateWithdrawGuardThreshold(
			1,
			new BN(10 ** 10).mul(QUOTE_PRECISION)
		);
		await admin.fetchAccounts();
		const spotMarket = admin.getSpotMarketAccount(1);
		assert(spotMarket.marketIndex === 1);
		assert(admin.getStateAccount().numberOfSpotMarkets === 2);

		assert(
			spotMarket.tokenProgramFlag === 3,
			'Token program flag should be 3 for token with transfer hook'
		);
	});

	async function doDepositWithdrawTest() {
		const userTokenBalanceBefore = await getAccount(
			bankrunContextWrapper.connection.toConnection(),
			firstUserTokenAccount,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const depositAmount = new BN(userTokenBalanceBefore.amount.toString()).divn(
			2
		);

		await firstUserDriftClient.fetchAccounts();
		await firstUserDriftClient.deposit(depositAmount, 1, firstUserTokenAccount);

		await firstUserDriftClient.fetchAccounts();
		let spotMarket = firstUserDriftClient.getSpotMarketAccount(1)!;
		let spotPos = firstUserDriftClient.getSpotPosition(1)!;
		let spotBal = getTokenAmount(
			spotPos.scaledBalance,
			spotMarket,
			spotPos.balanceType
		);
		assert.equal(spotBal.toString(), depositAmount.toString());

		await firstUserDriftClient.fetchAccounts();
		await firstUserDriftClient.withdraw(
			depositAmount,
			1,
			firstUserTokenAccount
		);

		await firstUserDriftClient.fetchAccounts();
		spotMarket = firstUserDriftClient.getSpotMarketAccount(1)!;
		spotPos = firstUserDriftClient.getSpotPosition(1)!;
		spotBal = getTokenAmount(
			spotPos.scaledBalance,
			spotMarket,
			spotPos.balanceType
		);
		assert.equal(spotBal.toString(), '0');
	}

	it('Deposit and withdraw TransferHookToken SpotMarket', async () => {
		await doDepositWithdrawTest();
	});

	it('Test can still deposit/withdraw undefined transfer hook program', async () => {
		const payer = bankrunContextWrapper.provider.wallet.publicKey;
		const updateTransferHookInstruction = new Transaction().add(
			createUpdateTransferHookInstruction(mint, payer, PublicKey.default)
		);
		await bankrunContextWrapper.sendTransaction(updateTransferHookInstruction, [
			bankrunContextWrapper.provider.wallet.payer,
			mintKeypair,
		]);

		await bankrunContextWrapper.moveTimeForward(100);

		const mintAcc = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			mint,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const hookAcc = getTransferHook(mintAcc);
		assert.isNotNull(hookAcc);
		console.log('hookAcc', hookAcc);
		assert.isTrue(hookAcc!.programId.equals(PublicKey.default));

		await doDepositWithdrawTest();
	});
});
