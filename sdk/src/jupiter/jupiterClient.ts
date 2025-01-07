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

/**
 *
 * @export
 * @interface RoutePlanStep
 */
export interface RoutePlanStep {
	/**
	 *
	 * @type {SwapInfo}
	 * @memberof RoutePlanStep
	 */
	swapInfo: SwapInfo;
	/**
	 *
	 * @type {number}
	 * @memberof RoutePlanStep
	 */
	percent: number;
}

export interface SwapInfo {
	/**
	 *
	 * @type {string}
	 * @memberof SwapInfo
	 */
	ammKey: string;
	/**
	 *
	 * @type {string}
	 * @memberof SwapInfo
	 */
	label?: string;
	/**
	 *
	 * @type {string}
	 * @memberof SwapInfo
	 */
	inputMint: string;
	/**
	 *
	 * @type {string}
	 * @memberof SwapInfo
	 */
	outputMint: string;
	/**
	 *
	 * @type {string}
	 * @memberof SwapInfo
	 */
	inAmount: string;
	/**
	 *
	 * @type {string}
	 * @memberof SwapInfo
	 */
	outAmount: string;
	/**
	 *
	 * @type {string}
	 * @memberof SwapInfo
	 */
	feeAmount: string;
	/**
	 *
	 * @type {string}
	 * @memberof SwapInfo
	 */
	feeMint: string;
}

/**
 *
 * @export
 * @interface PlatformFee
 */
export interface PlatformFee {
	/**
	 *
	 * @type {string}
	 * @memberof PlatformFee
	 */
	amount?: string;
	/**
	 *
	 * @type {number}
	 * @memberof PlatformFee
	 */
	feeBps?: number;
}

/**
 *
 * @export
 * @interface QuoteResponse
 */
export interface QuoteResponse {
	/**
	 *
	 * @type {string}
	 * @memberof QuoteResponse
	 */
	inputMint: string;
	/**
	 *
	 * @type {string}
	 * @memberof QuoteResponse
	 */
	inAmount: string;
	/**
	 *
	 * @type {string}
	 * @memberof QuoteResponse
	 */
	outputMint: string;
	/**
	 *
	 * @type {string}
	 * @memberof QuoteResponse
	 */
	outAmount: string;
	/**
	 *
	 * @type {string}
	 * @memberof QuoteResponse
	 */
	otherAmountThreshold: string;
	/**
	 *
	 * @type {SwapMode}
	 * @memberof QuoteResponse
	 */
	swapMode: SwapMode;
	/**
	 *
	 * @type {number}
	 * @memberof QuoteResponse
	 */
	slippageBps: number;
	/**
	 *
	 * @type {PlatformFee}
	 * @memberof QuoteResponse
	 */
	platformFee?: PlatformFee;
	/**
	 *
	 * @type {string}
	 * @memberof QuoteResponse
	 */
	priceImpactPct: string;
	/**
	 *
	 * @type {Array<RoutePlanStep>}
	 * @memberof QuoteResponse
	 */
	routePlan: Array<RoutePlanStep>;
	/**
	 *
	 * @type {number}
	 * @memberof QuoteResponse
	 */
	contextSlot?: number;
	/**
	 *
	 * @type {number}
	 * @memberof QuoteResponse
	 */
	timeTaken?: number;
	/**
	 *
	 * @type {string}
	 * @memberof QuoteResponse
	 */
	error?: string;
	/**
	 *
	 * @type {string}
	 * @memberof QuoteResponse
	 */
	errorCode?: string;
}

export class JupiterClient {
	url: string;
	connection: Connection;
	lookupTableCahce = new Map<string, AddressLookupTableAccount>();

	constructor({ connection, url }: { connection: Connection; url?: string }) {
		this.connection = connection;
		this.url = url ?? 'https://quote-api.jup.ag';
	}

	/**
	 * ** @deprecated - use getQuote
	 * Get routes for a swap
	 * @param inputMint the mint of the input token
	 * @param outputMint the mint of the output token
	 * @param amount the amount of the input token
	 * @param slippageBps the slippage tolerance in basis points
	 * @param swapMode the swap mode (ExactIn or ExactOut)
	 * @param onlyDirectRoutes whether to only return direct routes
	 */
	public async getRoutes({
		inputMint,
		outputMint,
		amount,
		slippageBps = 50,
		swapMode = 'ExactIn',
		onlyDirectRoutes = false,
	}: {
		inputMint: PublicKey;
		outputMint: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
	}): Promise<Route[]> {
		const params = new URLSearchParams({
			inputMint: inputMint.toString(),
			outputMint: outputMint.toString(),
			amount: amount.toString(),
			slippageBps: slippageBps.toString(),
			swapMode,
			onlyDirectRoutes: onlyDirectRoutes.toString(),
		}).toString();

		const apiVersionParam =
			this.url === 'https://quote-api.jup.ag' ? '/v4' : '';
		const { data: routes } = await (
			await fetch(`${this.url}${apiVersionParam}/quote?${params}`)
		).json();

		return routes;
	}

	/**
	 * Get routes for a swap
	 * @param inputMint the mint of the input token
	 * @param outputMint the mint of the output token
	 * @param amount the amount of the input token
	 * @param slippageBps the slippage tolerance in basis points
	 * @param swapMode the swap mode (ExactIn or ExactOut)
	 * @param onlyDirectRoutes whether to only return direct routes
	 */
	public async getQuote({
		inputMint,
		outputMint,
		amount,
		maxAccounts = 50, // 50 is an estimated amount with buffer
		slippageBps = 50,
		swapMode = 'ExactIn',
		onlyDirectRoutes = false,
		excludeDexes,
		autoSlippage = false,
		maxAutoSlippageBps,
		usdEstimate,
	}: {
		inputMint: PublicKey;
		outputMint: PublicKey;
		amount: BN;
		maxAccounts?: number;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
		excludeDexes?: string[];
		autoSlippage?: boolean;
		maxAutoSlippageBps?: number;
		usdEstimate?: number;
	}): Promise<QuoteResponse> {
		const params = new URLSearchParams({
			inputMint: inputMint.toString(),
			outputMint: outputMint.toString(),
			amount: amount.toString(),
			slippageBps: autoSlippage ? '0' : slippageBps.toString(),
			swapMode,
			onlyDirectRoutes: onlyDirectRoutes.toString(),
			maxAccounts: maxAccounts.toString(),
			autoSlippage: autoSlippage.toString(),
			maxAutoSlippageBps: autoSlippage ? maxAutoSlippageBps.toString() : '0',
			autoSlippageCollisionUsdValue: autoSlippage
				? usdEstimate.toString()
				: '0',
			...(excludeDexes && { excludeDexes: excludeDexes.join(',') }),
		});
		if (swapMode === 'ExactOut') {
			params.delete('maxAccounts');
		}
		const apiVersionParam =
			this.url === 'https://quote-api.jup.ag' ? '/v6' : '';
		const quote = await (
			await fetch(`${this.url}${apiVersionParam}/quote?${params.toString()}`)
		).json();
		return quote as QuoteResponse;
	}

	/**
	 * Get a swap transaction for quote
	 * @param quoteResponse quote to perform swap
	 * @param userPublicKey the signer's wallet public key
	 * @param slippageBps the slippage tolerance in basis points
	 */
	public async getSwap({
		quote,
		userPublicKey,
		slippageBps = 50,
	}: {
		quote: QuoteResponse;
		userPublicKey: PublicKey;
		slippageBps?: number;
	}): Promise<VersionedTransaction> {
		if (!quote) {
			throw new Error('Jupiter swap quote not provided. Please try again.');
		}

		const apiVersionParam =
			this.url === 'https://quote-api.jup.ag' ? '/v6' : '';
		const resp = await (
			await fetch(`${this.url}${apiVersionParam}/swap`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					quoteResponse: quote,
					userPublicKey,
					slippageBps,
				}),
			})
		).json();
		if (!('swapTransaction' in resp)) {
			throw new Error(
				`swapTransaction not found, error from Jupiter: ${resp.error} ${
					', ' + resp.message ?? ''
				}`
			);
		}
		const { swapTransaction } = resp;

		try {
			const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
			return VersionedTransaction.deserialize(swapTransactionBuf);
		} catch (err) {
			throw new Error(
				'Something went wrong with creating the Jupiter swap transaction. Please try again.'
			);
		}
	}

	/**
	 * ** @deprecated - use getSwap
	 * Get a swap transaction for a route
	 * @param route the route to perform swap
	 * @param userPublicKey the signer's wallet public key
	 * @param slippageBps the slippage tolerance in basis points
	 */
	public async getSwapTransaction({
		route,
		userPublicKey,
		slippageBps = 50,
	}: {
		route: Route;
		userPublicKey: PublicKey;
		slippageBps?: number;
	}): Promise<VersionedTransaction> {
		const apiVersionParam =
			this.url === 'https://quote-api.jup.ag' ? '/v4' : '';
		const resp = await (
			await fetch(`${this.url}${apiVersionParam}/swap`, {
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

		const transactionMessage = TransactionMessage.decompile(message, {
			addressLookupTableAccounts: lookupTables,
		});
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
				instruction.programId.toString() === '11111111111111111111111111111111'
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
