import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { Program } from '@project-serum/anchor';
import { Admin, TokenFaucet } from '../sdk/src';
import { BN } from '../sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import { initializeQuoteAssetBank, mockUSDCMint } from './testHelpers';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('token faucet', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const program = anchor.workspace.TokenFaucet as Program;

	let tokenFaucet: TokenFaucet;

	let usdcMint: Keypair;

	let token: Token;

	const chProgram = anchor.workspace.ClearingHouse as Program;
	let clearingHouse: Admin;

	const amount = new BN(10 * 10 ** 6);
	const maxAmountMint: BN = new BN(10 * 10 ** 6);
	const maxAmountPerUser: BN = new BN(15 * 10 ** 6);

	before(async () => {
		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
		});

		usdcMint = await mockUSDCMint(provider);

		tokenFaucet = new TokenFaucet(
			connection,
			provider.wallet,
			program.programId,
			usdcMint.publicKey
		);

		token = new Token(
			connection,
			tokenFaucet.mint,
			TOKEN_PROGRAM_ID,
			// @ts-ignore
			provider.wallet.payer
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Initialize State', async () => {
		await tokenFaucet.initialize(maxAmountMint, maxAmountPerUser);
		const state: any = await tokenFaucet.fetchState();

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const [mintAuthority, mintAuthorityNonce] =
			await PublicKey.findProgramAddress(
				[
					Buffer.from(anchor.utils.bytes.utf8.encode('mint_authority')),
					state.mint.toBuffer(),
				],
				tokenFaucet.program.programId
			);

		assert.ok(state.mintAuthority.equals(mintAuthority));
		assert.ok(mintAuthorityNonce === state.mintAuthorityNonce);
		assert.ok(state.maxAmountMint.eq(maxAmountMint));
		assert.ok(state.maxAmountPerUser.eq(maxAmountPerUser));

		const mintInfo = await token.getMintInfo();
		assert.ok(state.mintAuthority.equals(mintInfo.mintAuthority));
	});

	it('mint to user', async () => {
		const keyPair = new Keypair();
		let userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		try {
			await tokenFaucet.mintToUser(userTokenAccountInfo.address, amount);
		} catch (e) {
			console.error(e);
		}
		userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		assert.ok(userTokenAccountInfo.amount.eq(amount));
	});

	it('mints above maxAmountMint to user', async () => {
		const keyPair = new Keypair()
		let userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		try {
			await tokenFaucet.mintToUser(userTokenAccountInfo.address, amount.add(new BN(1)));
		} catch (e) {}
		userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		assert.ok(userTokenAccountInfo.amount.eq(new BN(0)))
	})

	it('mints more than maxAmountPerUser to user', async () => {
		const keyPair = new Keypair();
		let userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		try {
			await tokenFaucet.mintToUser(userTokenAccountInfo.address, amount);
		} catch (e) {
			console.error(e);
		}
		try {
			await tokenFaucet.mintToUser(userTokenAccountInfo.address, amount);
		} catch(e) {}
		userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		assert.ok(userTokenAccountInfo.amount.eq(amount));
	})

	it('initialize user for dev net', async () => {
		const state: any = await tokenFaucet.fetchState();

		await clearingHouse.initialize(state.mint, false);
		await clearingHouse.subscribe();
		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.initializeUserAccountForDevnet(
			0,
			'crisp',
			new BN(0),
			tokenFaucet,
			amount
		);

		assert(clearingHouse.getQuoteAssetTokenAmount().eq(amount));
	});

	it('transfer mint authority back', async () => {
		await tokenFaucet.transferMintAuthority();
		const mintInfo = await token.getMintInfo();
		assert.ok(provider.wallet.publicKey.equals(mintInfo.mintAuthority));
	});
});
