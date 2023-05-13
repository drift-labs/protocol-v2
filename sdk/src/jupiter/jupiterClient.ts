import {
	AddressLookupTableAccount,
	Connection,
	PublicKey,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import fetch from 'node-fetch';
import { BN } from '@coral-xyz/anchor';

export type SwapMode = 'ExactIn' | 'ExactOut';

export interface MarketInfo {
	id: string;
	inAmount: number;
	inputMint: string;
	label: string;
	lpFee: Fee;
	notEnoughLiquidity: boolean;
	outAmount: number;
	outputMint: string;
	platformFee: Fee;
	priceImpactPct: number;
}

export interface Fee {
	amount: number;
	mint: string;
	pct: number;
}

export interface Route {
	amount: number;
	inAmount: number;
	marketInfos: MarketInfo[];
	otherAmountThreshold: number;
	outAmount: number;
	priceImpactPct: number;
	slippageBps: number;
	swapMode: SwapMode;
}

export class JupiterClient {
	url = 'https://quote-api.jup.ag/v4';
	connection: Connection;
	lookupTableCahce = new Map<string, AddressLookupTableAccount>();

	constructor({ connection }: { connection: Connection }) {
		this.connection = connection;
	}

	/**
	 * Get routes for a swap
	 * @param inputMint the mint of the input token
	 * @param outputMint the mint of the output token
	 * @param amount the amount of the input token
	 * @param slippageBps the slippage tolerance in basis points
	 * @param swapMode the swap mode (ExactIn or ExactOut)
	 */
	public async getRoutes({
		inputMint,
		outputMint,
		amount,
		slippageBps = 50,
		swapMode = 'ExactIn',
	}: {
		inputMint: PublicKey;
		outputMint: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: SwapMode;
	}): Promise<Route[]> {
		const params = new URLSearchParams({
			inputMint: inputMint.toString(),
			outputMint: outputMint.toString(),
			amount: amount.toString(),
			slippageBps: slippageBps.toString(),
			swapMode,
		}).toString();

		const { data: routes } = await (
			await fetch(`https://quote-api.jup.ag/v4/quote?${params}`)
		).json();

		return routes;
	}

	/**
	 * Get a swap transaction for a route
	 * @param route the route to perform swap
	 * @param userPublicKey the user's wallet public key
	 * @param slippageBps the slippage tolerance in basis points
	 */
	public async fetchSwapTransaction({
		route,
		userPublicKey,
		slippageBps = 50,
	}: {
		route: Route;
		userPublicKey: PublicKey;
		slippageBps?: number;
	}): Promise<VersionedTransaction> {
		const resp = await (
			await fetch(`${this.url}/swap`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					route,
					userPublicKey,
					slippageBps,
				}),
			})
		).json();

		const { swapTransaction } = resp;

		const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
		return VersionedTransaction.deserialize(swapTransactionBuf);
	}

	/**
	 * Get the transaction message and lookup tables for a transaction
	 * @param transaction
	 */
	public async getTransactionMessageAndLookupTables({
		transaction,
	}: {
		transaction: VersionedTransaction;
		inputMint: PublicKey;
		outputMint: PublicKey;
	}): Promise<{
		transactionMessage: TransactionMessage;
		lookupTables: AddressLookupTableAccount[];
	}> {
		const message = transaction.message;

		const lookupTables = (
			await Promise.all(
				message.addressTableLookups.map(async (lookup) => {
					return await this.getLookupTable(lookup.accountKey);
				})
			)
		).filter((lookup) => lookup);

		const transactionMessage = TransactionMessage.decompile(message);
		return {
			transactionMessage,
			lookupTables,
		};
	}

	async getLookupTable(
		accountKey: PublicKey
	): Promise<AddressLookupTableAccount> {
		if (this.lookupTableCahce.has(accountKey.toString())) {
			return this.lookupTableCahce.get(accountKey.toString());
		}

		return (await this.connection.getAddressLookupTable(accountKey)).value;
	}

	/**
	 * Get the jupiter instructions from transaction by filtering out instructions to compute budget and associated token programs
	 * @param transactionMessage the transaction message
	 * @param inputMint the input mint
	 * @param outputMint the output mint
	 */
	public getJupiterInstructions({
		transactionMessage,
		inputMint,
		outputMint,
	}: {
		transactionMessage: TransactionMessage;
		inputMint: PublicKey;
		outputMint: PublicKey;
	}): TransactionInstruction[] {
		return transactionMessage.instructions.filter((instruction) => {
			if (
				instruction.programId.toString() ===
				'ComputeBudget111111111111111111111111111111'
			) {
				return false;
			}

			if (
				instruction.programId.toString() ===
				'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
			) {
				return false;
			}

			if (
				instruction.programId.toString() ===
				'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
			) {
				const mint = instruction.keys[3].pubkey;
				if (mint.equals(inputMint) || mint.equals(outputMint)) {
					return false;
				}
			}

			return true;
		});
	}
}
