import {
	TransactionConfirmationStatus,
	AccountInfo,
	Keypair,
	PublicKey,
	Transaction,
	RpcResponseAndContext,
	Commitment,
	TransactionSignature,
	SignatureStatusConfig,
	SignatureStatus,
	GetVersionedTransactionConfig,
	GetTransactionConfig,
	VersionedTransaction,
	SimulateTransactionConfig,
	SimulatedTransactionResponse,
	TransactionReturnData,
	TransactionError,
	SignatureResultCallback,
	ClientSubscriptionId,
	Connection as SolanaConnection,
} from '@solana/web3.js';
import {
	ProgramTestContext,
	BanksClient,
	BanksTransactionResultWithMeta,
} from 'solana-bankrun';
import { BankrunProvider } from 'anchor-bankrun';
import bs58 from 'bs58';

export type Connection = SolanaConnection | BankrunConnection;

type BankrunTransactionMetaNormalized = {
	logMessages: string[];
	err: TransactionError;
};

type BankrunTransactionRespose = {
	slot: number;
	meta: BankrunTransactionMetaNormalized;
};

export class BankrunContextWrapper {
	public readonly connection: BankrunConnection;
	public readonly context: ProgramTestContext;
	public readonly provider: BankrunProvider;
	public readonly commitment: Commitment = 'confirmed';

	constructor(context: ProgramTestContext) {
		this.context = context;
		this.provider = new BankrunProvider(context);
		this.connection = new BankrunConnection(this.context.banksClient);
	}

	async sendTransaction(
		tx: Transaction,
		additionalSigners?: Keypair[]
	): Promise<TransactionSignature> {
		tx.recentBlockhash = this.context.lastBlockhash;
		tx.feePayer = this.context.payer.publicKey;
		tx.sign(this.context.payer, ...additionalSigners);
		return this.connection.sendTransaction(tx);
	}
}
export class BankrunConnection {
	private readonly _banksClient: BanksClient;
	private transactionToMeta: Map<
		TransactionSignature,
		BanksTransactionResultWithMeta
	> = new Map();

	constructor(banksClient: BanksClient) {
		this._banksClient = banksClient;
	}

	async getAccountInfoAndContext(
		publicKey: PublicKey,
		_commitment?: Commitment
	): Promise<RpcResponseAndContext<null | AccountInfo<Buffer>>> {
		return await this.getParsedAccountInfo(publicKey);
	}
	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array | Array<number>,
		// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
		_options?: any
	): Promise<TransactionSignature> {
		const tx = Transaction.from(rawTransaction);
		return await this.sendTransaction(tx);
	}

	async sendTransaction(tx: Transaction): Promise<TransactionSignature> {
		const banksTransactionMeta = await this._banksClient.tryProcessTransaction(
			tx
		);
		const signature = bs58.encode(tx.signatures[0].signature);
		this.transactionToMeta.set(signature, banksTransactionMeta);
		return signature;
	}

	async getParsedAccountInfo(
		publicKey: PublicKey
	): Promise<RpcResponseAndContext<AccountInfo<Buffer>>> {
		const accountInfoBytes = await this._banksClient.getAccount(publicKey);
		if (accountInfoBytes === null) {
			return {
				context: { slot: Number(await this._banksClient.getSlot()) },
				value: null,
			};
		}
		accountInfoBytes.data = Buffer.from(accountInfoBytes.data);
		const accountInfoBuffer = accountInfoBytes as AccountInfo<Buffer>;
		return {
			context: { slot: Number(await this._banksClient.getSlot()) },
			value: accountInfoBuffer,
		};
	}

	async getLatestBlockhash(commitment?: Commitment): Promise<
		Readonly<{
			blockhash: string;
			lastValidBlockHeight: number;
		}>
	> {
		const blockhashAndBlockheight = await this._banksClient.getLatestBlockhash(
			commitment
		);
		return {
			blockhash: blockhashAndBlockheight[0],
			lastValidBlockHeight: Number(blockhashAndBlockheight[1]),
		};
	}

	async getSignatureStatus(
		signature: string,
		_config?: SignatureStatusConfig
	): Promise<RpcResponseAndContext<null | SignatureStatus>> {
		const transactionStatus = await this._banksClient.getTransactionStatus(
			signature
		);
		if (transactionStatus === null) {
			return {
				context: { slot: Number(await this._banksClient.getSlot()) },
				value: null,
			};
		}
		return {
			context: { slot: Number(await this._banksClient.getSlot()) },
			value: {
				slot: Number(transactionStatus.slot),
				confirmations: Number(transactionStatus.confirmations),
				err: transactionStatus.err,
				confirmationStatus:
					transactionStatus.confirmationStatus as TransactionConfirmationStatus,
			},
		};
	}

	/**
	 * There's really no direct equivalent to getTransaction exposed by SolanaProgramTest, so we do the best that we can here - it's a little hacky.
	 */
	async getTransaction(
		signature: string,
		_rawConfig?: GetTransactionConfig | GetVersionedTransactionConfig
	): Promise<BankrunTransactionRespose | null> {
		const txMeta = this.transactionToMeta.get(
			signature as TransactionSignature
		);
		if (txMeta === undefined) {
			return null;
		}
		const transactionStatus = await this._banksClient.getTransactionStatus(
			signature
		);
		const meta: BankrunTransactionMetaNormalized = {
			logMessages: txMeta.meta.logMessages,
			err: txMeta.result,
		};
		return {
			slot: Number(transactionStatus.slot),
			meta,
		};
	}

	async simulateTransaction(
		transaction: Transaction | VersionedTransaction,
		_config?: SimulateTransactionConfig
	): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
		const simulationResult = await this._banksClient.simulateTransaction(
			transaction
		);
		const returnDataProgramId =
			simulationResult.meta?.returnData?.programId.toBase58();
		const returnDataNormalized = Buffer.from(
			simulationResult.meta?.returnData?.data
		).toString('base64');
		const returnData: TransactionReturnData = {
			programId: returnDataProgramId,
			data: [returnDataNormalized, 'base64'],
		};
		return {
			context: { slot: Number(await this._banksClient.getSlot()) },
			value: {
				err: simulationResult.result,
				logs: simulationResult.meta.logMessages,
				accounts: undefined,
				unitsConsumed: Number(simulationResult.meta.computeUnitsConsumed),
				returnData,
			},
		};
	}

	onSignature(
		signature: string,
		callback: SignatureResultCallback,
		commitment?: Commitment
	): ClientSubscriptionId {
		const txMeta = this.transactionToMeta.get(
			signature as TransactionSignature
		);
		this._banksClient.getSlot(commitment).then((slot) => {
			if (txMeta) {
				callback({ err: txMeta.result }, { slot: Number(slot) });
			}
		});
		return 0;
	}

	async removeSignatureListener(_clientSubscriptionId: number): Promise<void> {
		// Nothing actually has to happen here! Pretty cool, huh?
		// This function signature only exists to match the web3js interface
	}
}
