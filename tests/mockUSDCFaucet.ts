import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { Program } from '@project-serum/anchor';
import {
	ClearingHouse,
	MockUSDCFaucet,
	Network,
	UserAccount,
} from '../sdk/src';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('mock_usdc_faucet', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const program = anchor.workspace.MockUsdcFaucet as Program;

	const mockUSDCFaucet = new MockUSDCFaucet(
		connection,
		Network.LOCAL,
		provider.wallet,
		program.programId
	);

	const chProgram = anchor.workspace.ClearingHouse as Program;
	let clearingHouse: ClearingHouse;
	let userAccount: UserAccount;

	const mintAmount = new BN(10);

	before(() => {
		clearingHouse = new ClearingHouse(
			connection,
			Network.LOCAL,
			provider.wallet,
			chProgram.programId
		);

		userAccount = new UserAccount(clearingHouse, provider.wallet.publicKey);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
	});

	it('Initialize State', async () => {
		await mockUSDCFaucet.initialize();
		const state: any = await mockUSDCFaucet.fetchState();

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const [mintAuthority, mintAuthorityNonce] =
			await PublicKey.findProgramAddress(
				[state.mint.toBuffer()],
				mockUSDCFaucet.program.programId
			);

		assert.ok(state.mintAuthority.equals(mintAuthority));
		assert.ok(mintAuthorityNonce === state.mintAuthorityNonce);
	});

	it('mint to user', async () => {
		const state: any = await mockUSDCFaucet.fetchState();
		const token = new Token(
			connection,
			state.mint,
			TOKEN_PROGRAM_ID,
			// @ts-ignore
			provider.wallet.payer
		);

		const keyPair = new Keypair();
		let userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		await mockUSDCFaucet.mintToUser(userTokenAccountInfo.address, mintAmount);
		userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		assert.ok(userTokenAccountInfo.amount.eq(mintAmount));
	});

	it('initialize user for dev net', async () => {
		const state: any = await mockUSDCFaucet.fetchState();

		await clearingHouse.initialize(state.mint, false);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountForDevnet(
			mockUSDCFaucet,
			mintAmount
		);

		await userAccount.subscribe();
		assert(userAccount.userAccountData.collateral.eq(mintAmount));
	});
});
