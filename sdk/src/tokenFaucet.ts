import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Idl, Program } from '@coral-xyz/anchor';
import {
	TOKEN_PROGRAM_ID,
	Account,
	createAssociatedTokenAccountInstruction,
	getAssociatedTokenAddress,
	getAccount,
} from '@solana/spl-token';
import {
	ConfirmOptions,
	Connection,
	PublicKey,
	SYSVAR_RENT_PUBKEY,
	Transaction,
	TransactionInstruction,
	TransactionSignature,
} from '@solana/web3.js';
import { BN, DEFAULT_CONFIRMATION_OPTS } from '.';
import tokenFaucet from './idl/token_faucet.json';
import { IWallet } from './types';
import { BankrunContextWrapper } from './bankrun/bankrunConnection';

export class TokenFaucet {
	context?: BankrunContextWrapper;
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: AnchorProvider;
	mint: PublicKey;
	opts?: ConfirmOptions;

	public constructor(
		connection: Connection,
		wallet: IWallet,
		programId: PublicKey,
		mint: PublicKey,
		opts?: ConfirmOptions,
		context?: BankrunContextWrapper
	) {
		this.connection = connection;
		this.context = context;
		this.wallet = wallet;
		this.opts = opts || DEFAULT_CONFIRMATION_OPTS;
		// @ts-ignore
		const provider = new AnchorProvider(
			context ? context.connection.toConnection() : this.connection,
			// @ts-ignore
			wallet,
			this.opts
		);
		this.provider = provider;
		this.program = new Program(tokenFaucet as Idl, programId, provider);
		this.mint = mint;
	}

	public async getFaucetConfigPublicKeyAndNonce(): Promise<
		[PublicKey, number]
	> {
		return anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('faucet_config')),
				this.mint.toBuffer(),
			],
			this.program.programId
		);
	}

	public async getMintAuthority(): Promise<PublicKey> {
		return (
			await anchor.web3.PublicKey.findProgramAddress(
				[
					Buffer.from(anchor.utils.bytes.utf8.encode('mint_authority')),
					this.mint.toBuffer(),
				],
				this.program.programId
			)
		)[0];
	}

	public async getFaucetConfigPublicKey(): Promise<PublicKey> {
		return (await this.getFaucetConfigPublicKeyAndNonce())[0];
	}

	public async initialize(): Promise<TransactionSignature> {
		const [faucetConfigPublicKey] =
			await this.getFaucetConfigPublicKeyAndNonce();
		const ix = this.program.instruction.initialize({
			accounts: {
				faucetConfig: faucetConfigPublicKey,
				admin: this.wallet.publicKey,
				mintAccount: this.mint,
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
		const tx = new Transaction().add(ix);
		const txSig = await this.context.sendTransaction(tx);
		return txSig;
	}

	public async fetchState(): Promise<any> {
		return await this.program.account.faucetConfig.fetch(
			await this.getFaucetConfigPublicKey()
		);
	}

	private async mintToUserIx(userTokenAccount: PublicKey, amount: BN) {
		return this.program.instruction.mintToUser(amount, {
			accounts: {
				faucetConfig: await this.getFaucetConfigPublicKey(),
				mintAccount: this.mint,
				userTokenAccount,
				mintAuthority: await this.getMintAuthority(),
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async mintToUser(
		userTokenAccount: PublicKey,
		amount: BN
	): Promise<TransactionSignature> {
		const mintIx = await this.mintToUserIx(userTokenAccount, amount);

		const tx = new Transaction().add(mintIx);

		if (this.context) {
			return await this.context.sendTransaction(tx);
		} else {
			return await this.program.provider.sendAndConfirm(tx, [], this.opts);
		}
	}

	public async transferMintAuthority(): Promise<TransactionSignature> {
		if (this.context) {
			const ix = this.program.instruction.transferMintAuthority({
				accounts: {
					faucetConfig: await this.getFaucetConfigPublicKey(),
					mintAccount: this.mint,
					mintAuthority: await this.getMintAuthority(),
					tokenProgram: TOKEN_PROGRAM_ID,
					admin: this.wallet.publicKey,
				},
			});
			const tx = new Transaction().add(ix);
			const txSig = await this.context.sendTransaction(tx);
			return txSig;
		}

		return await this.program.rpc.transferMintAuthority({
			accounts: {
				faucetConfig: await this.getFaucetConfigPublicKey(),
				mintAccount: this.mint,
				mintAuthority: await this.getMintAuthority(),
				tokenProgram: TOKEN_PROGRAM_ID,
				admin: this.wallet.publicKey,
			},
		});
	}

	public async createAssociatedTokenAccountAndMintTo(
		userPublicKey: PublicKey,
		amount: BN
	): Promise<[PublicKey, TransactionSignature]> {
		const tx = new Transaction();

		const [associatedTokenPublicKey, createAssociatedAccountIx, mintToTx] =
			await this.createAssociatedTokenAccountAndMintToInstructions(
				userPublicKey,
				amount
			);

		let associatedTokenAccountExists = false;

		try {
			const assosciatedTokenAccount =
				await this.context.connection.getAccountInfo(associatedTokenPublicKey);

			associatedTokenAccountExists = !!assosciatedTokenAccount;
		} catch (e) {
			// token account doesn't exist
			associatedTokenAccountExists = false;
		}

		const skipAccountCreation = associatedTokenAccountExists;

		if (!skipAccountCreation) tx.add(createAssociatedAccountIx);

		tx.add(mintToTx);

		let txSig;
		if (this.context) {
			txSig = await this.context.sendTransaction(tx);
		} else {
			txSig = await this.program.provider.sendAndConfirm(tx, [], this.opts);
		}

		return [associatedTokenPublicKey, txSig];
	}

	public async createAssociatedTokenAccountAndMintToInstructions(
		userPublicKey: PublicKey,
		amount: BN
	): Promise<[PublicKey, TransactionInstruction, TransactionInstruction]> {
		const state: any = await this.fetchState();

		const associateTokenPublicKey = await this.getAssosciatedMockUSDMintAddress(
			{ userPubKey: userPublicKey }
		);

		const createAssociatedAccountIx = createAssociatedTokenAccountInstruction(
			this.wallet.publicKey,
			associateTokenPublicKey,
			userPublicKey,
			state.mint
		);

		const mintToIx = await this.mintToUserIx(associateTokenPublicKey, amount);

		return [associateTokenPublicKey, createAssociatedAccountIx, mintToIx];
	}

	public async getAssosciatedMockUSDMintAddress(props: {
		userPubKey: PublicKey;
	}): Promise<anchor.web3.PublicKey> {
		const state: any = await this.fetchState();

		return getAssociatedTokenAddress(state.mint, props.userPubKey);
	}

	public async getTokenAccountInfo(props: {
		userPubKey: PublicKey;
	}): Promise<Account> {
		const associatedKey = await this.getAssosciatedMockUSDMintAddress(props);
		if (this.context) {
			return await this.context.connection.getTokenAccount(associatedKey);
		}
		return await getAccount(this.connection, associatedKey);
	}

	public async subscribeToTokenAccount(props: {
		userPubKey: PublicKey;
		callback: (accountInfo: Account) => void;
	}): Promise<boolean> {
		try {
			const tokenAccountKey = await this.getAssosciatedMockUSDMintAddress(
				props
			);

			props.callback(await this.getTokenAccountInfo(props));

			// Couldn't find a way to do it using anchor framework subscription, someone on serum discord recommended this way
			this.context.connection.onAccountChange(
				tokenAccountKey,
				async (
					_accountInfo /* accountInfo is a buffer which we don't know how to deserialize */
				) => {
					props.callback(await this.getTokenAccountInfo(props));
				}
			);

			return true;
		} catch (e) {
			return false;
		}
	}
}
