import * as anchor from '@project-serum/anchor';
import { Idl, Program, Provider } from '@project-serum/anchor';
import {
	AccountInfo,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	MintLayout,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	ConfirmOptions,
	Connection,
	PublicKey,
	SystemProgram,
	SYSVAR_RENT_PUBKEY,
	Transaction,
	TransactionInstruction,
	TransactionSignature,
} from '@solana/web3.js';
import BN from 'bn.js';
import mockUSDCFaucetIDL from './idl/mock_usdc_faucet.json';
import { Network } from './network';
import { IWallet } from './types';

export class MockUSDCFaucet {
	connection: Connection;
	network: Network;
	wallet: IWallet;
	public program: Program;
	provider: Provider;
	opts?: ConfirmOptions;

	public constructor(
		connection: Connection,
		network: Network,
		wallet: IWallet,
		programId: PublicKey,
		opts?: ConfirmOptions
	) {
		this.connection = connection;
		this.network = network;
		this.wallet = wallet;
		this.opts = opts || Provider.defaultOptions();
		const provider = new Provider(connection, wallet, this.opts);
		this.provider = provider;
		switch (network) {
			case Network.LOCAL:
				this.program = new Program(
					mockUSDCFaucetIDL as Idl,
					programId,
					provider
				);
				break;
			default:
				throw new Error('Not supported');
		}
	}

	public async initialize(): Promise<TransactionSignature> {
		const stateAddress = this.program.state.address();
		const stateAccountRPCResponse = await this.connection.getParsedAccountInfo(
			stateAddress
		);
		if (stateAccountRPCResponse.value !== null) {
			throw new Error('Faucet already initialized');
		}

		const fakeUSDCMint = anchor.web3.Keypair.generate();
		const createUSDCMintAccountIx = SystemProgram.createAccount({
			fromPubkey: this.wallet.publicKey,
			newAccountPubkey: fakeUSDCMint.publicKey,
			lamports: await Token.getMinBalanceRentForExemptMint(this.connection),
			space: MintLayout.span,
			programId: TOKEN_PROGRAM_ID,
		});

		const [mintAuthority, _mintAuthorityNonce] =
			await PublicKey.findProgramAddress(
				[fakeUSDCMint.publicKey.toBuffer()],
				this.program.programId
			);

		const initUSDCMintIx = Token.createInitMintInstruction(
			TOKEN_PROGRAM_ID,
			fakeUSDCMint.publicKey,
			6,
			mintAuthority,
			null
		);

		return await this.program.state.rpc.new({
			accounts: {
				admin: this.wallet.publicKey,
				mintAccount: fakeUSDCMint.publicKey,
				rent: SYSVAR_RENT_PUBKEY,
			},
			instructions: [createUSDCMintAccountIx, initUSDCMintIx],
			signers: [fakeUSDCMint],
		});
	}

	public async mintToUser(
		userTokenAccount: PublicKey,
		amount: BN
	): Promise<TransactionSignature> {
		const state: any = await this.program.state.fetch();
		return await this.program.state.rpc.mintToUser(amount, {
			accounts: {
				mintAccount: state.mint,
				userTokenAccount,
				mintAuthority: state.mintAuthority,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async createAssociatedTokenAccountAndMintTo(
		userPublicKey: PublicKey,
		amount: BN
	): Promise<[PublicKey, TransactionSignature]> {
		const [associatedTokenPublicKey, createAssociatedAccountIx, mintToTx] =
			await this.createAssociatedTokenAccountAndMintToInstructions(
				userPublicKey,
				amount
			);
		const tx = new Transaction().add(createAssociatedAccountIx).add(mintToTx);
		const txSig = await this.program.provider.send(tx, [], this.opts);
		return [associatedTokenPublicKey, txSig];
	}

	public async createAssociatedTokenAccountAndMintToInstructions(
		userPublicKey: PublicKey,
		amount: BN
	): Promise<[PublicKey, TransactionInstruction, TransactionInstruction]> {
		const state: any = await this.program.state.fetch();

		const associateTokenPublicKey = await this.getAssosciatedMockUSDMintAddress(
			{ userPubKey: userPublicKey }
		);

		const createAssociatedAccountIx =
			Token.createAssociatedTokenAccountInstruction(
				ASSOCIATED_TOKEN_PROGRAM_ID,
				TOKEN_PROGRAM_ID,
				state.mint,
				associateTokenPublicKey,
				userPublicKey,
				this.wallet.publicKey
			);

		const mintToIx = await this.program.state.instruction.mintToUser(amount, {
			accounts: {
				mintAccount: state.mint,
				userTokenAccount: associateTokenPublicKey,
				mintAuthority: state.mintAuthority,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});

		return [associateTokenPublicKey, createAssociatedAccountIx, mintToIx];
	}

	public async getAssosciatedMockUSDMintAddress(props: {
		userPubKey: PublicKey;
	}): Promise<anchor.web3.PublicKey> {
		const state: any = await this.program.state.fetch();

		return Token.getAssociatedTokenAddress(
			ASSOCIATED_TOKEN_PROGRAM_ID,
			TOKEN_PROGRAM_ID,
			state.mint,
			props.userPubKey
		);
	}

	public async getTokenAccountInfo(props: {
		userPubKey: PublicKey;
	}): Promise<AccountInfo> {
		const assosciatedKey = await this.getAssosciatedMockUSDMintAddress(props);

		const state: any = await this.program.state.fetch();

		const token = new Token(
			this.connection,
			state.mint,
			TOKEN_PROGRAM_ID,
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore
			this.provider.payer
		);

		return await token.getAccountInfo(assosciatedKey);
	}

	public async subscribeToTokenAccount(props: {
		userPubKey: PublicKey;
		callback: (accountInfo: AccountInfo) => void;
	}): Promise<boolean> {
		try {
			const tokenAccountKey = await this.getAssosciatedMockUSDMintAddress(
				props
			);

			props.callback(await this.getTokenAccountInfo(props));

			// Couldn't find a way to do it using anchor framework subscription, someone on serum discord recommended this way
			this.connection.onAccountChange(
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
