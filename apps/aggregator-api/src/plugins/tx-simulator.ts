import { Idl } from '@coral-xyz/anchor';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { VelocityClient } from '@velocity-exchange/sdk';
import { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
	interface FastifyInstance {
		simulateTransaction: (
			tx: VersionedTransaction | Transaction,
			options?: { skipSimulation?: boolean }
		) => Promise<SimulationResult>;
		handleVelocityError: (error: any, reply: FastifyReply) => Promise<void>;
	}
}

export interface ParsedVelocityError {
	error: string;
	name: string;
	code?: number;
}

export interface SimulationResult {
	success: boolean;
	error?: string;
	code?: number;
	name?: string;
}

const txSimulationPlugin: FastifyPluginAsync = async (fastify): Promise<void> => {
	let errorParserInitialized = false;
	let errorMap: Map<string, { code: number; name: string; msg: string }> | null = null;

	const genericErrorMap: Record<string, { name: string; code: number; msg: string }> = {
		'insufficient funds': {
			name: 'TokenProgramInsufficientFunds',
			code: 1,
			msg: 'Insufficient Funds',
		},
	};

	const initializeFromIDL = (velocityClient: VelocityClient): void => {
		const idl = velocityClient.program.idl as unknown as Idl;

		errorMap = new Map();

		if (idl.errors) {
			for (const error of idl.errors) {
				const hexCode = '0x' + error.code.toString(16);
				errorMap.set(hexCode, {
					code: error.code,
					name: error.name,
					msg: error.msg || 'No description available',
				});
			}
		}
	};

	const getErrorDetails = (
		hexCode: string
	): { code: number; name: string; msg: string } | null => {
		if (!errorMap) {
			console.warn('Error map not initialized. Call initializeFromIDL() first.');
			return null;
		}

		return errorMap.get(hexCode.toLowerCase()) || null;
	};

	const parseSimulationError = (errorString: string): ParsedVelocityError | null => {
		try {
			const errorCodeMatch = errorString.match(/custom program error: (0x[0-9a-fA-F]+)/);
			const errorCode = errorCodeMatch?.[1];

			const logsMatch = errorString.match(/Logs:\s*\n\[(.*)]/s);
			const logsString = logsMatch?.[1] ?? '';

			const logs = logsString
				.split(/\r?\n/)
				.map((line) =>
					line
						.trim()
						.replace(/^[-*]\s*/, '')
						.replace(/^"|"$/g, '')
						.replace(/",?$/g, '')
				)
				.filter((line) => line.length > 0 && line !== '[' && line !== ']');

			const anchorErrorMatch = logs.find((log) => log.includes('AnchorError'));
			let errorDetails = null;

			if (anchorErrorMatch) {
				const errorCodeFromLog = anchorErrorMatch.match(/Error Code: (\w+)/)?.[1];
				const errorNumberFromLog = anchorErrorMatch.match(/Error Number: (\d+)/)?.[1];
				const errorMessageFromLog = anchorErrorMatch.match(/Error Message: ([^.]+)/)?.[1];

				if (errorCodeFromLog && errorNumberFromLog && errorMessageFromLog) {
					errorDetails = {
						code: parseInt(errorNumberFromLog),
						name: errorCodeFromLog,
						msg: errorMessageFromLog,
					};
				}
			}

			if (!errorDetails && errorCode) {
				errorDetails = getErrorDetails(errorCode);
			}

			if (!errorDetails) {
				const genericError = logs
					.map((l) => l.match(/Program log: Error: (.+)/)?.[1])
					.find(Boolean);

				if (genericError) {
					const mapped = genericErrorMap[genericError.toLowerCase()];
					if (mapped) {
						return {
							code: mapped.code,
							name: mapped.name,
							error: mapped.msg,
						};
					}

					return {
						name: 'ProgramError',
						error: genericError,
					};
				}
			}

			if (!errorDetails) return null;

			return {
				code: errorDetails.code,
				name: errorDetails.name,
				error: errorDetails.msg,
			};
		} catch (error) {
			console.error('Failed to parse Velocity error:', error);
			return null;
		}
	};

	const getSuggestion = (errorName: string): string => {
		const suggestions: Record<string, string> = {
			InsufficientCollateral: 'Add more collateral or reduce position size.',
			InsufficientDeposit: 'Increase your deposit amount.',
			MaxNumberOfPositions: 'Close some existing positions before opening new ones.',
			MarketDelisted: 'This market is no longer available for trading.',
			UserHasNoPositionInMarket: 'You need to open a position in this market first.',
			InvalidSpotMarketAuthority:
				'The spot market authority is invalid. Please contact support.',
			MarketPaused: 'This market is temporarily paused. Try again later.',
			UserBankrupt: 'Your account is bankrupt and requires liquidation.',
			OrderDoesNotExist: 'The order you are trying to modify does not exist.',
			OrderNotTriggerable: 'This order cannot be triggered at the current price.',
			OrderAmountTooSmall: 'Increase your order size to meet the minimum requirements.',
			PriceBandsBreached:
				'The price has moved beyond acceptable bands. Try again with updated prices.',
			TokenProgramInsufficientFunds:
				'Your token account has insufficient funds for this transfer. Check your token balance.',
		};

		return suggestions[errorName] || 'Please review the error message and try again.';
	};

	const getErrorResponse = (
		error: any
	): {
		success: false;
		error: string;
		code?: number;
		name?: string;
		details?: string;
	} => {
		ensureErrorParserInitialized();
		const errorString = error instanceof Error ? error.message : String(error);
		const parsed = parseSimulationError(errorString);

		if (parsed) {
			return {
				success: false,
				...parsed,
				details: getSuggestion(parsed.name),
			};
		}

		return {
			success: false,
			error: errorString,
		};
	};

	const ensureErrorParserInitialized = () => {
		if (errorParserInitialized) {
			return;
		}
		try {
			initializeFromIDL(fastify.velocityClient);
			errorParserInitialized = true;
		} catch (error) {
			console.error('Failed to initialize Velocity error parser:', error);
			throw error;
		}
	};

	fastify.decorate(
		'simulateTransaction',
		async function (
			tx: VersionedTransaction | Transaction,
			options?: { skipSimulation?: boolean }
		): Promise<SimulationResult> {
			if (options?.skipSimulation) {
				return { success: true };
			}

			try {
				let simulation;

				if (tx instanceof VersionedTransaction) {
					simulation = await fastify.connection.simulateTransaction(tx, {
						commitment: 'processed',
						sigVerify: false,
						replaceRecentBlockhash: true,
					});
				} else {
					simulation = await fastify.connection.simulateTransaction(tx);
				}

				if (simulation.value.err) {
					const logs = simulation.value.logs || [];

					const errorMessage =
						typeof simulation.value.err === 'string'
							? simulation.value.err
							: JSON.stringify(simulation.value.err);

					const fullError = `Simulation failed. \nMessage: Transaction simulation failed: ${errorMessage}. \nLogs: \n[\n${logs
						.map((log) => `  "${log}"`)
						.join(',\n')}\n]`;

					const error = getErrorResponse(fullError);

					return error;
				}

				return { success: true };
			} catch (error) {
				const errorResponse = getErrorResponse(error);
				return errorResponse;
			}
		}
	);

	fastify.decorate(
		'handleVelocityError',
		async function (error: any, reply: FastifyReply): Promise<void> {
			const errorResponse = getErrorResponse(error);
			await reply.status(400).send(errorResponse);
		}
	);
};

export default fp(txSimulationPlugin);
