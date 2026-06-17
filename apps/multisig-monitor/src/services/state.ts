/**
 * DynamoDB-backed state store for cross-batch + cross-restart deduplication.
 *
 * Two namespaces share the table:
 *  - `SIG#<signature>`  — alerts already dispatched for that tx signature (TTL ~24h)
 *  - `NONCE#<account>`  — nonce accounts already alerted on, or seen in the
 *                         Yellowstone snapshot at startup (no TTL — once known,
 *                         always known, otherwise restarts re-alert)
 *
 * Test-and-set is implemented via a conditional `put` with
 * `attribute_not_exists(pk)`. The first writer succeeds and `markSeen` returns
 * false (caller proceeds with alert). Subsequent writers hit a
 * ConditionalCheckFailedException, which we catch and treat as "already seen"
 * (caller skips alert).
 */
import { DynamoDB } from '@backend/dynamodb';
import { logger } from '@backend/common';

export interface StateStore {
	/**
	 * Atomically marks `signature` as seen.
	 * @returns true if it was already in the store (caller should skip alert).
	 */
	markSignatureSeen(signature: string): Promise<boolean>;

	/**
	 * Atomically marks `nonceAccount` as seen.
	 * @returns true if it was already in the store (caller should skip alert).
	 */
	markNonceAccountSeen(nonceAccount: string): Promise<boolean>;
}

export interface StateStoreConfig {
	tableName: string;
	signatureTtlSeconds: number;
}

export function createStateStore(config: StateStoreConfig): StateStore {
	const ddb = DynamoDB({ overrideTableName: config.tableName });

	return {
		async markSignatureSeen(signature: string): Promise<boolean> {
			const ttl = Math.floor(Date.now() / 1000) + config.signatureTtlSeconds;
			return testAndSet(
				{ pk: `SIG#${signature}`, sk: 'META', ttl, signature },
				ddb,
				`signature ${signature.slice(0, 8)}...`
			);
		},

		async markNonceAccountSeen(nonceAccount: string): Promise<boolean> {
			return testAndSet(
				{ pk: `NONCE#${nonceAccount}`, sk: 'META', nonceAccount },
				ddb,
				`nonce account ${nonceAccount.slice(0, 8)}...`
			);
		},
	};
}

async function testAndSet(
	record: Record<string, unknown>,
	ddb: ReturnType<typeof DynamoDB>,
	descriptionForLogs: string
): Promise<boolean> {
	try {
		await ddb.put({
			record,
			conditionExpression: 'attribute_not_exists(pk)',
		});
		return false;
	} catch (err) {
		const name = (err as { name?: string }).name;
		if (name === 'ConditionalCheckFailedException') return true;
		// Treat unknown DDB errors as "not seen" so we err on the side of alerting.
		// Logging surfaces the underlying issue without dropping the signal.
		await logger.error(
			`state store error for ${descriptionForLogs}: ${(err as Error).message}`
		);
		return false;
	}
}
