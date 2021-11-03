import * as anchor from '@project-serum/anchor';
import { Provider } from '@project-serum/anchor';
import {
	AccountLayout,
	MintLayout,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	Keypair,
	PublicKey,
	sendAndConfirmTransaction,
	SystemProgram,
	Transaction,
} from '@solana/web3.js';
import { assert } from 'chai';
import { createPriceFeed, getFeedData } from './mockPythUtils';

export async function mockOracle(price = 50 * 10e7, expo = -7) {
	// default: create a $50 coin oracle
	const program = anchor.workspace.Pyth;

	anchor.setProvider(anchor.Provider.env());
	const priceFeedAddress = await createPriceFeed({
		oracleProgram: program,
		initPrice: price,
		expo: expo,
	});

	const feedData = await getFeedData(program, priceFeedAddress);
	assert.ok(feedData.price === price);

	return priceFeedAddress;
}

export async function mockUSDCMint(provider: Provider): Promise<Keypair> {
	const fakeUSDCMint = anchor.web3.Keypair.generate();
	const createUSDCMintAccountIx = SystemProgram.createAccount({
		fromPubkey: provider.wallet.publicKey,
		newAccountPubkey: fakeUSDCMint.publicKey,
		lamports: await Token.getMinBalanceRentForExemptMint(provider.connection),
		space: MintLayout.span,
		programId: TOKEN_PROGRAM_ID,
	});
	const initCollateralMintIx = Token.createInitMintInstruction(
		TOKEN_PROGRAM_ID,
		fakeUSDCMint.publicKey,
		6,
		provider.wallet.publicKey,
		null
	);

	const fakeUSDCTx = new Transaction();
	fakeUSDCTx.add(createUSDCMintAccountIx);
	fakeUSDCTx.add(initCollateralMintIx);

	const _fakeUSDCTxResult = await sendAndConfirmTransaction(
		provider.connection,
		fakeUSDCTx,
		// @ts-ignore
		[provider.wallet.payer, fakeUSDCMint],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
	return fakeUSDCMint;
}

export async function mockUserUSDCAccount(
	fakeUSDCMint,
	usdcMintAmount,
	provider,
	owner?: PublicKey
): Promise<Keypair> {
	const userUSDCAccount = anchor.web3.Keypair.generate();
	const fakeUSDCTx = new Transaction();

	if (owner === undefined) {
		owner = provider.wallet.publicKey;
	}

	const createUSDCTokenAccountIx = SystemProgram.createAccount({
		fromPubkey: provider.wallet.publicKey,
		newAccountPubkey: userUSDCAccount.publicKey,
		lamports: await Token.getMinBalanceRentForExemptAccount(
			provider.connection
		),
		space: AccountLayout.span,
		programId: TOKEN_PROGRAM_ID,
	});
	fakeUSDCTx.add(createUSDCTokenAccountIx);

	const initUSDCTokenAccountIx = Token.createInitAccountInstruction(
		TOKEN_PROGRAM_ID,
		fakeUSDCMint.publicKey,
		userUSDCAccount.publicKey,
		owner
	);
	fakeUSDCTx.add(initUSDCTokenAccountIx);

	const mintToUserAccountTx = await Token.createMintToInstruction(
		TOKEN_PROGRAM_ID,
		fakeUSDCMint.publicKey,
		userUSDCAccount.publicKey,
		provider.wallet.publicKey,
		[],
		usdcMintAmount.toNumber()
	);
	fakeUSDCTx.add(mintToUserAccountTx);

	const _fakeUSDCTxResult = await sendAndConfirmTransaction(
		provider.connection,
		fakeUSDCTx,
		[provider.wallet.payer, userUSDCAccount],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
	return userUSDCAccount;
}

export async function mintToInsuranceFund(
	chInsuranceAccount,
	fakeUSDCMint,
	amount,
	provider
) {
	const mintToUserAccountTx = await Token.createMintToInstruction(
		TOKEN_PROGRAM_ID,
		fakeUSDCMint.publicKey,
		chInsuranceAccount.publicKey,
		provider.wallet.publicKey,
		[],
		amount.toNumber()
	);

	const fakeUSDCTx = new Transaction();
	fakeUSDCTx.add(mintToUserAccountTx);

	const _fakeUSDCTxResult = await sendAndConfirmTransaction(
		provider.connection,
		fakeUSDCTx,
		[provider.wallet.payer],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
}
