import { ExpressionValues } from '@backend/common';
import { DynamoDB } from '@backend/dynamodb';
import { FastifyPluginAsync, FastifyReply } from 'fastify';

// Vault config rows live in ${ns}-dashboard-db, one row per vault:
//   pk = '#VAULTS'
//   sk = <pubkey>
// Per-row layout means each mutation is a primitive DynamoDB op (PutItem
// / UpdateItem / DeleteItem) with native conditional support — no
// array-RMW, no cross-region S3 hops, no manual ETag plumbing. Edits to
// different vaults never conflict; edits to the same vault are serialised
// by DynamoDB last-write-wins (or a condition check, per route).
const VAULT_PK = '#VAULTS';

// IUiVaultConfig (defined in dashboard) — kept opaque on the API side so
// the dashboard owns the schema. Vault identity is `pubkey`.
type VaultConfig = Record<string, unknown> & { pubkey: string };

const vaultBodySchema = {
	type: 'object',
	required: ['pubkey'],
	properties: { pubkey: { type: 'string', minLength: 1 } },
	additionalProperties: true,
} as const;

const flagsBodySchema = {
	type: 'object',
	properties: {
		isHidden: { type: 'boolean' },
		isFeatured: { type: 'boolean' },
		isArchived: { type: 'boolean' },
		isPaused: { type: 'boolean' },
	},
	additionalProperties: true,
	minProperties: 1,
} as const;

const managerBodySchema = {
	type: 'object',
	required: ['manager'],
	properties: { manager: { type: 'object', additionalProperties: true } },
	additionalProperties: false,
} as const;

const stripKeys = (item: Record<string, unknown>): VaultConfig => {
	const { pk: _pk, sk: _sk, ...rest } = item;
	return rest as VaultConfig;
};

const vaultsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const dashboardTable = process.env.DASHBOARD_TABLE;
	const { put, queryAll, update, remove } = DynamoDB({ overrideTableName: dashboardTable });

	const guard = (reply: FastifyReply): boolean => {
		if (!dashboardTable) {
			reply.code(503).send({ success: false, error: 'DASHBOARD_TABLE not configured' });
			return false;
		}
		return true;
	};

	fastify.get(
		'',
		{
			schema: {
				hide: true,
				description: 'Read the full vault config array.',
				tags: ['Admin'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							vaults: {
								type: 'array',
								items: { type: 'object', additionalProperties: true },
							},
						},
					},
				},
			},
		},
		async (_request, reply) => {
			if (!guard(reply)) return;
			const items = await queryAll({ pk: VAULT_PK });
			return reply.send({ success: true, vaults: items.map(stripKeys) });
		}
	);

	fastify.post<{ Body: VaultConfig }>(
		'',
		{
			schema: {
				hide: true,
				description: 'Add a new vault. 409 if `pubkey` already exists.',
				tags: ['Admin'],
				body: vaultBodySchema,
			},
		},
		async (request, reply) => {
			if (!guard(reply)) return;
			const next = request.body;
			try {
				await put({
					record: { pk: VAULT_PK, sk: next.pubkey, ...next },
					conditionExpression: 'attribute_not_exists(pk)',
				});
			} catch (err) {
				if ((err as Error).name === 'ConditionalCheckFailedException') {
					return reply
						.code(409)
						.send({ success: false, error: `Vault ${next.pubkey} already exists` });
				}
				throw err;
			}
			return reply.code(201).send({ success: true, vault: next });
		}
	);

	fastify.patch<{ Params: { pubkey: string }; Body: VaultConfig }>(
		'/:pubkey',
		{
			schema: {
				hide: true,
				description: 'Replace the vault row for `:pubkey`. 404 if not found.',
				tags: ['Admin'],
				params: {
					type: 'object',
					required: ['pubkey'],
					properties: { pubkey: { type: 'string', minLength: 1 } },
				},
				body: vaultBodySchema,
			},
		},
		async (request, reply) => {
			if (!guard(reply)) return;
			const { pubkey } = request.params;
			const next = request.body;
			if (next.pubkey !== pubkey) {
				return reply
					.code(400)
					.send({ success: false, error: 'Body `pubkey` must match URL' });
			}
			try {
				await put({
					record: { pk: VAULT_PK, sk: pubkey, ...next },
					conditionExpression: 'attribute_exists(pk)',
				});
			} catch (err) {
				if ((err as Error).name === 'ConditionalCheckFailedException') {
					return reply
						.code(404)
						.send({ success: false, error: `Vault ${pubkey} not found` });
				}
				throw err;
			}
			return reply.send({ success: true, vault: next });
		}
	);

	fastify.delete<{ Params: { pubkey: string } }>(
		'/:pubkey',
		{
			schema: {
				hide: true,
				description: 'Remove the vault row for `:pubkey`. Idempotent.',
				tags: ['Admin'],
				params: {
					type: 'object',
					required: ['pubkey'],
					properties: { pubkey: { type: 'string', minLength: 1 } },
				},
			},
		},
		async (request, reply) => {
			if (!guard(reply)) return;
			const { pubkey } = request.params;
			await remove({ pk: VAULT_PK, sk: pubkey });
			return reply.send({ success: true });
		}
	);

	fastify.patch<{ Params: { pubkey: string }; Body: Record<string, unknown> }>(
		'/:pubkey/flags',
		{
			schema: {
				hide: true,
				description: 'Merge flag fields onto the vault row. 404 if not found.',
				tags: ['Admin'],
				params: {
					type: 'object',
					required: ['pubkey'],
					properties: { pubkey: { type: 'string', minLength: 1 } },
				},
				body: flagsBodySchema,
			},
		},
		async (request, reply) => {
			if (!guard(reply)) return;
			const { pubkey } = request.params;
			const patch = request.body;

			const setClauses: string[] = [];
			const expressionValues: ExpressionValues = {};
			const expressionNames: Record<string, string> = {};
			Object.entries(patch).forEach(([key, value], i) => {
				const nameAlias = `#f${i}`;
				const valueAlias = `:v${i}`;
				setClauses.push(`${nameAlias} = ${valueAlias}`);
				expressionNames[nameAlias] = key;
				// flagsBodySchema constrains values to boolean / scalar / nested
				// object — all valid DocumentAttributeValue at runtime.
				expressionValues[valueAlias] = value as ExpressionValues[string];
			});

			try {
				const result = await update({
					pk: VAULT_PK,
					sk: pubkey,
					updateExpression: `SET ${setClauses.join(', ')}`,
					conditionExpression: 'attribute_exists(pk)',
					expressionValues,
					expressionNames,
				});
				return reply.send({
					success: true,
					vault: stripKeys(result.Attributes as Record<string, unknown>),
				});
			} catch (err) {
				if ((err as Error).name === 'ConditionalCheckFailedException') {
					return reply
						.code(404)
						.send({ success: false, error: `Vault ${pubkey} not found` });
				}
				throw err;
			}
		}
	);

	fastify.patch<{ Params: { pubkey: string }; Body: { manager: Record<string, unknown> } }>(
		'/:pubkey/manager',
		{
			schema: {
				hide: true,
				description: 'Replace the `manager` field on the vault row. 404 if not found.',
				tags: ['Admin'],
				params: {
					type: 'object',
					required: ['pubkey'],
					properties: { pubkey: { type: 'string', minLength: 1 } },
				},
				body: managerBodySchema,
			},
		},
		async (request, reply) => {
			if (!guard(reply)) return;
			const { pubkey } = request.params;
			const { manager } = request.body;
			try {
				const result = await update({
					pk: VAULT_PK,
					sk: pubkey,
					updateExpression: 'SET manager = :m',
					conditionExpression: 'attribute_exists(pk)',
					// managerBodySchema constrains `manager` to an object with
					// arbitrary fields — valid DocumentAttributeValue at runtime.
					expressionValues: { ':m': manager as ExpressionValues[string] },
				});
				return reply.send({
					success: true,
					vault: stripKeys(result.Attributes as Record<string, unknown>),
				});
			} catch (err) {
				if ((err as Error).name === 'ConditionalCheckFailedException') {
					return reply
						.code(404)
						.send({ success: false, error: `Vault ${pubkey} not found` });
				}
				throw err;
			}
		}
	);
};

export default vaultsRoutes;
