import { getTimestamp, RecordTypes, WhitelistRecord } from '@backend/common';
import { v7 as uuidv7 } from 'uuid';
import { DynamoDB } from '../client';
import { getBaseRecordFields, getRecordKeys, getTTLTimestampForDelete } from '../utils';

export const WhitelistRepository = () => {
	const { put, query, update } = DynamoDB();

	const createWhitelist = async (
		whitelistRecord: Omit<WhitelistRecord, 'whitelistId'>
	): Promise<WhitelistRecord> => {
		const recordWithId = {
			...whitelistRecord,
			whitelistId: uuidv7(),
			active: true,
			updatedAt: getTimestamp(),
		};

		const record = {
			...getRecordKeys(recordWithId, RecordTypes.WhitelistRecord),
			...recordWithId,
			...getBaseRecordFields(recordWithId),
		};

		await put({ record });

		return record as WhitelistRecord;
	};

	const getWhitelist = async ({
		authorityId,
	}: {
		authorityId: string;
	}): Promise<WhitelistRecord[]> => {
		const result = await query({
			pk: `AUTHORITY#${authorityId}`,
			sk: 'WHITELIST#',
			expression: 'pk = :pk and begins_with(sk, :sk)',
			filterExpression: 'active = :active',
			expressionValues: {
				':pk': `AUTHORITY#${authorityId}`,
				':sk': 'WHITELIST#',
				':active': true,
			},
			limit: 100,
		});

		return result.Items as WhitelistRecord[];
	};

	const updateWhitelist = async ({
		authorityId,
		whitelistId,
		address,
		label,
		token,
		chainId,
	}: {
		authorityId: string;
		whitelistId: string;
		address: string;
		label: string;
		token: string;
		chainId: string;
	}): Promise<WhitelistRecord> => {
		const result = await update({
			...getRecordKeys(
				{ authorityId, whitelistId } as WhitelistRecord,
				RecordTypes.WhitelistRecord
			),
			updateExpression:
				'SET authorityId = :authorityId, whitelistId = :whitelistId, #address = :address, label = :label, #token = :token, chainId = :chainId, updatedAt = :updatedAt, active = :active, createdAt = if_not_exists(createdAt, :createdAt)',
			expressionNames: {
				'#token': 'token',
				'#address': 'address',
			},
			expressionValues: {
				':authorityId': authorityId,
				':whitelistId': whitelistId,
				':address': address,
				':label': label,
				':token': token,
				':chainId': chainId,
				':active': true,
				':updatedAt': getTimestamp(),
				':createdAt': getTimestamp(),
			},
		});

		return result.Attributes as WhitelistRecord;
	};

	const removeWhitelist = async ({
		authorityId,
		whitelistId,
	}: Pick<WhitelistRecord, 'authorityId' | 'whitelistId'>): Promise<void> => {
		await update({
			...getRecordKeys(
				{ authorityId, whitelistId } as WhitelistRecord,
				RecordTypes.WhitelistRecord
			),
			updateExpression: 'SET updatedAt = :updatedAt, active = :active, #ttl = :ttl',
			expressionNames: {
				'#ttl': 'ttl',
			},
			expressionValues: {
				':active': false,
				':updatedAt': getTimestamp(),
				':ttl': getTTLTimestampForDelete(),
			},
		});
	};

	return {
		createWhitelist,
		getWhitelist,
		updateWhitelist,
		removeWhitelist,
	};
};
