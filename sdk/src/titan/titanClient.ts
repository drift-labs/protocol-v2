import {
	Connection,
	PublicKey,
	TransactionMessage,
	AddressLookupTableAccount,
	TransactionInstruction,
} from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { decode } from '@msgpack/msgpack';

export enum SwapMode {
	ExactIn = 'ExactIn',
	ExactOut = 'ExactOut',
}

interface RoutePlanStep {
	ammKey: Uint8Array;
	label: string;
	inputMint: Uint8Array;
	outputMint: Uint8Array;
	inAmount: number;
	outAmount: number;
	allocPpb: number;
	feeMint?: Uint8Array;
	feeAmount?: number;
	contextSlot?: number;
}

interface PlatformFee {
	amount: number;
	fee_bps: number;
}

type Pubkey = Uint8Array;

interface AccountMeta {
	p: Pubkey;
	s: boolean;
	w: boolean;
}

interface Instruction {
	p: Pubkey;
	a: AccountMeta[];
	d: Uint8Array;
}

interface SwapRoute {
	inAmount: number;
	outAmount: number;
	slippageBps: number;
	platformFee?: PlatformFee;
	steps: RoutePlanStep[];
	instructions: Instruction[];
	addressLookupTables: Pubkey[];
	contextSlot?: number;
	timeTaken?: number;
	expiresAtMs?: number;
	expiresAfterSlot?: number;
	computeUnits?: number;
	computeUnitsSafe?: number;
	transaction?: Uint8Array;
	referenceId?: string;
}

interface SwapQuotes {
	id: string;
	inputMint: Uint8Array;
	outputMint: Uint8Array;
	swapMode: SwapMode;
	amount: number;
	quotes: { [key: string]: SwapRoute };
}

export interface QuoteResponse {
	inputMint: string;
	inAmount: string;
	outputMint: string;
	outAmount: string;
	swapMode: SwapMode;
	slippageBps: number;
	platformFee?: { amount?: string; feeBps?: number };
	routePlan: Array<{ swapInfo: any; percent: number }>;
	contextSlot?: number;
	timeTaken?: number;
	error?: string;
	errorCode?: string;
}

const TITAN_API_URL = 'https://api.titan.exchange';

export class TitanClient {
	authToken: string;
	url: string;
	connection: Connection;
	proxyUrl?: string;
	private lastQuoteData?: SwapQuotes;
	private lastQuoteParams?: string;

	constructor({
		connection,
		authToken,
		url,
		proxyUrl,
	}: {
		connection: Connection;
		authToken: string;
		url?: string;
		proxyUrl?: string;
	}) {
		this.connection = connection;
		this.authToken = authToken;
		this.url = url ?? TITAN_API_URL;
		this.proxyUrl = proxyUrl;
	}

	private buildParams({
		inputMint,
		outputMint,
		amount,
		userPublicKey,
		maxAccounts,
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		excludeDexes,
		sizeConstraint,
		accountsLimitWritable,
	}: {
		inputMint: PublicKey;
		outputMint: PublicKey;
		amount: BN;
		userPublicKey: PublicKey;
		maxAccounts?: number;
		slippageBps?: number;
		swapMode?: string | SwapMode;
		onlyDirectRoutes?: boolean;
		excludeDexes?: string[];
		sizeConstraint?: number;
		accountsLimitWritable?: number;
	}): URLSearchParams {
		// Normalize swapMode to enum value
		const normalizedSwapMode =
			swapMode === 'ExactOut' || swapMode === SwapMode.ExactOut
				? SwapMode.ExactOut
				: SwapMode.ExactIn;

		return new URLSearchParams({
			inputMint: inputMint.toString(),
			outputMint: outputMint.toString(),
			amount: amount.toString(),
			userPublicKey: userPublicKey.toString(),
			...(slippageBps && { slippageBps: slippageBps.toString() }),
			...(swapMode && { swapMode: normalizedSwapMode.toString() }),
			...(maxAccounts && { accountsLimitTotal: maxAccounts.toString() }),
			...(excludeDexes && { excludeDexes: excludeDexes.join(',') }),
			...(onlyDirectRoutes && {
				onlyDirectRoutes: onlyDirectRoutes.toString(),
			}),
			...(sizeConstraint && { sizeConstraint: sizeConstraint.toString() }),
			...(accountsLimitWritable && {
				accountsLimitWritable: accountsLimitWritable.toString(),
			}),
		});
	}

	/**
	 * Get routes for a swap
	 */
	public async getQuote({
		inputMint,
		outputMint,
		amount,
		userPublicKey,
		maxAccounts = 50, // 50 is an estimated amount with buffer
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		excludeDexes,
		sizeConstraint,
		accountsLimitWritable,
	}: {
		inputMint: PublicKey;
		outputMint: PublicKey;
		amount: BN;
		userPublicKey: PublicKey;
		maxAccounts?: number;
		slippageBps?: number;
		swapMode?: string;
		onlyDirectRoutes?: boolean;
		excludeDexes?: string[];
		sizeConstraint?: number;
		accountsLimitWritable?: number;
	}): Promise<QuoteResponse> {
		const params = this.buildParams({
			inputMint,
			outputMint,
			amount,
			userPublicKey,
			maxAccounts,
			slippageBps,
			swapMode,
			onlyDirectRoutes,
			excludeDexes,
			sizeConstraint,
			accountsLimitWritable,
		});

		let response: Response;

		if (this.proxyUrl) {
			// Use proxy route - send parameters in request body
			response = await fetch(this.proxyUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(Object.fromEntries(params.entries())),
			});
		} else {
			// Direct request to Titan API
			response = await fetch(
				`${this.url}/api/v1/quote/swap?${params.toString()}`,
				{
					headers: {
						Accept: 'application/vnd.msgpack',
						'Accept-Encoding': 'gzip, deflate, br',
						Authorization: `Bearer ${this.authToken}`,
					},
				}
			);
		}

		if (!response.ok) {
			throw new Error(
				`Titan API error: ${response.status} ${response.statusText}`
			);
		}

		const buffer = await response.arrayBuffer();
		const data = decode(buffer) as SwapQuotes;

		// Cache the quote data and parameters for later use in getSwap
		this.lastQuoteData = data;
		this.lastQuoteParams = params.toString();

		// We are only querying for the best avaiable route so use that
		const route = data.quotes[Object.keys(data.quotes)[0]];

		if (!route) {
			throw new Error('No routes available');
		}

		return {
			inputMint: inputMint.toString(),
			inAmount: amount.toString(),
			outputMint: outputMint.toString(),
			outAmount: route.outAmount.toString(),
			swapMode: data.swapMode,
			slippageBps: route.slippageBps,
			platformFee: route.platformFee
				? {
						amount: route.platformFee.amount.toString(),
						feeBps: route.platformFee.fee_bps,
				  }
				: undefined,
			routePlan:
				route.steps?.map((step: any) => ({
					swapInfo: {
						ammKey: new PublicKey(step.ammKey).toString(),
						label: step.label,
						inputMint: new PublicKey(step.inputMint).toString(),
						outputMint: new PublicKey(step.outputMint).toString(),
						inAmount: step.inAmount.toString(),
						outAmount: step.outAmount.toString(),
						feeAmount: step.feeAmount?.toString() || '0',
						feeMint: step.feeMint ? new PublicKey(step.feeMint).toString() : '',
					},
					percent: 100,
				})) || [],
			contextSlot: route.contextSlot,
			timeTaken: route.timeTaken,
		};
	}

	/**
	 * Get a swap transaction for quote
	 */
	public async getSwap({
		inputMint,
		outputMint,
		amount,
		userPublicKey,
		maxAccounts = 50, // 50 is an estimated amount with buffer
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		excludeDexes,
		sizeConstraint,
		accountsLimitWritable,
	}: {
		inputMint: PublicKey;
		outputMint: PublicKey;
		amount: BN;
		userPublicKey: PublicKey;
		maxAccounts?: number;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
		excludeDexes?: string[];
		sizeConstraint?: number;
		accountsLimitWritable?: number;
	}): Promise<{
		transactionMessage: TransactionMessage;
		lookupTables: AddressLookupTableAccount[];
	}> {
		const params = this.buildParams({
			inputMint,
			outputMint,
			amount,
			userPublicKey,
			maxAccounts,
			slippageBps,
			swapMode,
			onlyDirectRoutes,
			excludeDexes,
			sizeConstraint,
			accountsLimitWritable,
		});

		// Check if we have cached quote data that matches the current parameters
		if (!this.lastQuoteData || this.lastQuoteParams !== params.toString()) {
			throw new Error(
				'No matching quote data found. Please get a fresh quote before attempting to swap.'
			);
		}

		// Reuse the cached quote data
		const data = this.lastQuoteData;

		// We are only querying for the best avaiable route so use that
		const route = data.quotes[Object.keys(data.quotes)[0]];

		if (!route) {
			throw new Error('No routes available');
		}

		if (route.instructions && route.instructions.length > 0) {
			try {
				const { transactionMessage, lookupTables } =
					await this.getTransactionMessageAndLookupTables(route, userPublicKey);
				return { transactionMessage, lookupTables };
			} catch (err) {
				throw new Error(
					'Something went wrong with creating the Titan swap transaction. Please try again.'
				);
			} finally {
				// Clear cached quote data after use
				this.lastQuoteData = undefined;
				this.lastQuoteParams = undefined;
			}
		}
		throw new Error('No instructions provided in the route');
	}

	/**
	 * Get the titan instructions from transaction by filtering out instructions to compute budget and associated token programs
	 * @param transactionMessage the transaction message
	 * @param inputMint the input mint
	 * @param outputMint the output mint
	 */
	public getTitanInstructions({
		transactionMessage,
		inputMint,
		outputMint,
	}: {
		transactionMessage: TransactionMessage;
		inputMint: PublicKey;
		outputMint: PublicKey;
	}): TransactionInstruction[] {
		// Filter out common system instructions that can be handled by DriftClient
		const filteredInstructions = transactionMessage.instructions.filter(
			(instruction) => {
				const programId = instruction.programId.toString();

				// Filter out system programs
				if (programId === 'ComputeBudget111111111111111111111111111111') {
					return false;
				}

				if (programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
					return false;
				}

				if (programId === '11111111111111111111111111111111') {
					return false;
				}

				// Filter out Associated Token Account creation for input/output mints
				if (programId === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') {
					if (instruction.keys.length > 3) {
						const mint = instruction.keys[3].pubkey;
						if (mint.equals(inputMint) || mint.equals(outputMint)) {
							return false;
						}
					}
				}

				return true;
			}
		);
		return filteredInstructions;
	}

	private async getTransactionMessageAndLookupTables(
		route: SwapRoute,
		userPublicKey: PublicKey
	): Promise<{
		transactionMessage: TransactionMessage;
		lookupTables: AddressLookupTableAccount[];
	}> {
		const solanaInstructions: TransactionInstruction[] = route.instructions.map(
			(instruction) => ({
				programId: new PublicKey(instruction.p),
				keys: instruction.a.map((meta) => ({
					pubkey: new PublicKey(meta.p),
					isSigner: meta.s,
					isWritable: meta.w,
				})),
				data: Buffer.from(instruction.d),
			})
		);

		// Get recent blockhash
		const { blockhash } = await this.connection.getLatestBlockhash();

		// Build address lookup tables if provided
		const addressLookupTables: AddressLookupTableAccount[] = [];
		if (route.addressLookupTables && route.addressLookupTables.length > 0) {
			for (const altPubkey of route.addressLookupTables) {
				try {
					const altAccount = await this.connection.getAddressLookupTable(
						new PublicKey(altPubkey)
					);
					if (altAccount.value) {
						addressLookupTables.push(altAccount.value);
					}
				} catch (err) {
					console.warn(`Failed to fetch address lookup table:`, err);
				}
			}
		}

		const transactionMessage = new TransactionMessage({
			payerKey: userPublicKey,
			recentBlockhash: blockhash,
			instructions: solanaInstructions,
		});

		return { transactionMessage, lookupTables: addressLookupTables };
	}
}
