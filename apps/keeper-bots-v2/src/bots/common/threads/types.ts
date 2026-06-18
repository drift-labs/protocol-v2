import {
	AddressLookupTableAccount,
	PublicKey,
	TransactionInstruction,
	VersionedTransaction,
} from '@solana/web3.js';

export type WrappedIpcMessage = {
	type: IpcMessageTypes;
	data: IpcMessage;
};

export enum IpcMessageTypes {
	COMMAND = 'command',
	NOTIFICATION = 'notification',
	NEW_SIGNER = 'new_signer',
	NEW_ADDRESS_LOOKUP_TABLE = 'new_address_lookup_table',
	TRANSACTION = 'transaction',
	CONFIRM_TRANSACTION = 'confirm_transaction',
	SET_TRANSACTIONS_ENABLED = 'set_transactions_enabled',
	METRICS = 'metrics',
}

export type Serializable =
	| string
	| number
	| boolean
	| null
	| Serializable[]
	| { [key: string]: Serializable };

export type IpcMessageMap = {
	[IpcMessageTypes.COMMAND]: {
		command: string;
	};
	[IpcMessageTypes.NOTIFICATION]: {
		message: string;
	};
	[IpcMessageTypes.NEW_SIGNER]: {
		signerKey: string;
		signerInfo: string;
	};
	[IpcMessageTypes.NEW_ADDRESS_LOOKUP_TABLE]: {
		address: string;
	};
	[IpcMessageTypes.TRANSACTION]: {
		ixsSerialized: object[];
		/// deserialized instructions
		ixs: TransactionInstruction[];
		/// true to simulate the tx before retrying.
		simOnRetry: boolean;
		/// true to simulate the tx with CUs
		simulateCUs: boolean;
		/// instructs the TxThread to retry this tx with a new blockhash until it goes through
		retryUntilConfirmed: boolean;
		/// ID of signer(s) for the tx. Needs to be added via IpcMessageTypes.NEW_SIGNER before, otherwise will throw.
		signerKeys: string[];
		/// Pubkey of address lookup tables for the tx. Needs to be added via IpcMessageTypes.NEW_ADDRESS_LOOKUP_TABLE before, otherwise will throw.
		addressLookupTables: string[];
		/// New signers for the tx, use this instead of sending a IpcMessageTypes.NEW_SIGNER
		newSigners: { key: string; info: string }[];
	};
	[IpcMessageTypes.CONFIRM_TRANSACTION]: {
		/// transaction signature to confirm, signer for the tx must be previously registered with IpcMessageTypes.NEW_SIGNER, or passed in newSigners
		confirmTxSig: string;
		/// New signers for the tx, use this instead of sending a IpcMessageTypes.NEW_SIGNER
		newSigners: { key: string; info: string }[];
	};
	[IpcMessageTypes.SET_TRANSACTIONS_ENABLED]: {
		txEnabled: boolean;
	};
	[IpcMessageTypes.METRICS]: TxSenderMetrics;
};

export type IpcMessage = IpcMessageMap[keyof IpcMessageMap];

export type TxSenderMetrics = {
	txLanded: number;
	txAttempted: number;
	txDroppedTimeout: number;
	txDroppedBlockhashExpired: number;
	txFailedSimulation: number;
	txRetried: number;
	lruEvictedTxs: number;
	pendingQueueSize: number;
	confirmQueueSize: number;
	txConfirmRateLimited: number;
	txEnabled: number;
	txConfirmedFromWs: number;
};

/// States for transactions going through the txThread
export enum TxState {
	/// the tx is queued and has not been sent yet
	QUEUED = 'queued',
	/// the tx has been sent at least once
	RETRYING = 'retrying',
	/// the tx has failed (blockhash expired)
	FAILED = 'failed',
	/// the tx has landed (confirmed)
	LANDED = 'landed',
}

export type TransactionPayload = {
	instruction: IpcMessageMap[IpcMessageTypes.TRANSACTION];
	retries?: number;
	blockhashUsed?: string;
	blockhashExpiryHeight?: number;
	lastSentTxSig?: string;
	lastSentTx?: VersionedTransaction;
	lastSentRawTx?: Buffer | Uint8Array;
	lastSendTs?: number;
	addressLookupTables?: AddressLookupTableAccount[];
};

export function deserializedIx(ix: any): TransactionInstruction {
	let keys = ix['keys'] as any[];
	if (keys.length > 0) {
		keys = keys.map((k: any) => {
			return {
				pubkey: new PublicKey(k['pubkey'] as string),
				isSigner: k['isSigner'] as boolean,
				isWritable: k['isWritable'] as boolean,
			};
		});
	}
	return {
		keys,
		programId: new PublicKey(ix['programId']),
		data: Buffer.from(ix['data']),
	};
}
