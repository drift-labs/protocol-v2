import {
	BaseDynamoRecord,
	EntityTypes,
	getTimestamp,
	logger,
	RecordTypes,
	VaultDepositorCumulativeRecord,
	VaultDepositorRecord,
} from '@backend/common';
import { QUOTE_PRECISION_EXP } from '@velocity-exchange/sdk';
import Bottleneck from 'bottleneck';
import Decimal from 'decimal.js';
import {
	AUTHORITY_PK,
	cumulativeVaultDepositKeys,
	DynamoDB,
	getRecordKeys,
	VAULT_DEPOSIT_RECORD_ID,
} from '..';

const limiter = new Bottleneck({
	maxConcurrent: 20,
});

export const VaultRepository = () => {
	const { batchWrite, get, update, queryAll } = DynamoDB();

	const createVaultDepositRecords = async (depositRecords: VaultDepositorRecord[]) => {
		const records = depositRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.VaultDepositorRecord),
			...record,
			createdAt: getTimestamp(),
		}));

		const processRecord = async (record: VaultDepositorRecord) => {
			const {
				txSig,
				txSigIndex,
				depositorAuthority,
				action,
				vault,
				amount,
				depositOraclePrice,
			} = record;

			const quoteValue = new Decimal(amount)
				.mul(new Decimal(depositOraclePrice))
				.toDecimalPlaces(QUOTE_PRECISION_EXP.toNumber())
				.toNumber();

			const isDeposit = action.toLowerCase() === 'deposit';
			const isWithdrawal = action.toLowerCase() === 'withdraw';

			if (!isDeposit && !isWithdrawal) return;

			const depositIncrement = isDeposit ? quoteValue : 0;
			const withdrawalIncrement = isWithdrawal ? quoteValue : 0;

			const keys = [
				cumulativeVaultDepositKeys(depositorAuthority, vault),
				cumulativeVaultDepositKeys(depositorAuthority),
			];

			await Promise.all(
				keys.map(async (key) => {
					try {
						await limiter.schedule(async () => {
							await update({
								...key,
								updateExpression: `
									ADD cumulativeDepositQuoteValue :depositIncrement, cumulativeWithdrawalQuoteValue :withdrawalIncrement
									SET processedTransactions = list_append(if_not_exists(processedTransactions, :emptyList), :tx)
								`,
								conditionExpression: `NOT contains(processedTransactions, :txId)`,
								expressionValues: {
									':depositIncrement': depositIncrement,
									':withdrawalIncrement': withdrawalIncrement,
									':emptyList': [],
									':tx': [`${txSig}-${txSigIndex}`],
									':txId': `${txSig}-${txSigIndex}`,
								},
							});
						});
					} catch (error) {
						const { message, name } = error as Error;
						const isConditionalFailure = name === 'ConditionalCheckFailedException';
						if (!isConditionalFailure) {
							logger.error(
								`Failed to update cumulative record for authority ${depositorAuthority}: ${message}, ${JSON.stringify(
									record
								)}`
							);
						} else {
							logger.info(
								`Skipped duplicate transaction for authority ${depositorAuthority}: ${txSig}-${txSigIndex}`
							);
						}
					}
				})
			);
		};

		await Promise.all(records.map(processRecord));

		return batchWrite({ records });
	};

	const getVaultDepositRecordsBetweenTimestamps = async ({
		authority,
		id,
		startTs,
		endTs,
	}: {
		authority: string;
		id: string;
		startTs: number;
		endTs: number;
		entity?: EntityTypes;
	}): Promise<(VaultDepositorRecord & BaseDynamoRecord)[]> => {
		const records = (await queryAll({
			pk: `${AUTHORITY_PK}#${authority}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${AUTHORITY_PK}#${authority}`,
				':startSk': `${VAULT_DEPOSIT_RECORD_ID}#VAULT#${id}#TS#${startTs}`,
				':endSk': `${VAULT_DEPOSIT_RECORD_ID}#VAULT#${id}#TS#${endTs}`,
			},
		})) as (VaultDepositorRecord & BaseDynamoRecord)[];

		return records;
	};

	const getVaultCumulativeRecord = async ({
		authority,
		vault = '',
	}: {
		authority: string;
		vault?: string;
	}): Promise<Pick<
		VaultDepositorCumulativeRecord,
		'cumulativeDepositQuoteValue' | 'cumulativeWithdrawalQuoteValue'
	> | null> => {
		const { Item } = await get(cumulativeVaultDepositKeys(authority, vault));

		if (!Item) return null;

		const { cumulativeDepositQuoteValue, cumulativeWithdrawalQuoteValue } =
			Item as VaultDepositorCumulativeRecord;

		return {
			cumulativeDepositQuoteValue,
			cumulativeWithdrawalQuoteValue,
		};
	};

	return {
		createVaultDepositRecords,
		getVaultCumulativeRecord,
		getVaultDepositRecordsBetweenTimestamps,
	};
};
