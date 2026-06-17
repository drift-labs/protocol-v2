import { unmarshall } from '@aws-sdk/util-dynamodb';
import { logger } from '@backend/common';
import { DynamoDBStreamEvent } from 'aws-lambda';
import { handler } from '../src/async-slot-queue';

jest.mock('@aws-sdk/util-dynamodb');
jest.mock('@backend/common');
jest.mock('@backend/sqs');

const mockPutMesssages = jest.fn().mockResolvedValue({});
jest.mock('@backend/sqs', () => {
	return {
		SQS: () => {
			return {
				putMessages: mockPutMesssages,
			};
		},
	};
});

describe('AsyncSlotQueue', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('should process valid INSERT records', async () => {
		const mockEvent: DynamoDBStreamEvent = {
			Records: [
				{
					eventID: '1',
					eventName: 'INSERT',
					dynamodb: {
						NewImage: {
							pk: { S: 'MISSED' },
							status: { S: 'missed' },
							someOtherField: { S: 'value' },
						},
					},
				},
			],
		};

		(unmarshall as jest.Mock).mockReturnValue({
			pk: 'MISSED',
			status: 'missed',
			someOtherField: 'value',
		});

		await handler(mockEvent);

		expect(mockPutMesssages).toHaveBeenCalledWith({
			records: [
				{
					Id: '1',
					MessageBody: JSON.stringify({
						pk: 'MISSED',
						status: 'missed',
						someOtherField: 'value',
					}),
				},
			],
		});
	});

	it('should process valid MODIFY records', async () => {
		const mockEvent: DynamoDBStreamEvent = {
			Records: [
				{
					eventID: '2',
					eventName: 'MODIFY',
					dynamodb: {
						NewImage: {
							pk: { S: 'MISSED' },
							status: { S: 'missed' },
							someOtherField: { S: 'newValue' },
						},
					},
				},
			],
		};

		(unmarshall as jest.Mock).mockReturnValue({
			pk: 'MISSED',
			status: 'missed',
			someOtherField: 'newValue',
		});

		await handler(mockEvent);

		expect(mockPutMesssages).toHaveBeenCalledWith({
			records: [
				{
					Id: '2',
					MessageBody: JSON.stringify({
						pk: 'MISSED',
						status: 'missed',
						someOtherField: 'newValue',
					}),
				},
			],
		});
	});

	it('should skip records with eventName other than INSERT or MODIFY', async () => {
		const mockEvent: DynamoDBStreamEvent = {
			Records: [
				{
					eventID: '3',
					eventName: 'REMOVE',
					dynamodb: {
						NewImage: {
							pk: { S: 'MISSED' },
							status: { S: 'missed' },
						},
					},
				},
			],
		};

		await handler(mockEvent);

		expect(mockPutMesssages).not.toHaveBeenCalled();
	});

	it('should log and skip records with undefined dynamodb or NewImage', async () => {
		const mockEvent: DynamoDBStreamEvent = {
			Records: [
				{
					eventID: '4',
					eventName: 'INSERT',
					dynamodb: undefined,
				},
			],
		};

		await handler(mockEvent);

		expect(logger.info).toHaveBeenCalledWith(
			'Skipping record 4: dynamodb or NewImage is undefined'
		);
		expect(mockPutMesssages).not.toHaveBeenCalled();
	});

	it('should not process records with non-matching pk or status', async () => {
		const mockEvent: DynamoDBStreamEvent = {
			Records: [
				{
					eventID: '5',
					eventName: 'INSERT',
					dynamodb: {
						NewImage: {
							pk: { S: 'NOT_MISSED' },
							status: { S: 'active' },
						},
					},
				},
			],
		};

		(unmarshall as jest.Mock).mockReturnValue({
			pk: 'NOT_MISSED',
			status: 'active',
		});

		await handler(mockEvent);

		expect(mockPutMesssages).not.toHaveBeenCalled();
	});

	it('should process multiple valid records', async () => {
		const mockEvent: DynamoDBStreamEvent = {
			Records: [
				{
					eventID: '6',
					eventName: 'INSERT',
					dynamodb: {
						NewImage: {
							pk: { S: 'MISSED' },
							status: { S: 'missed' },
							field1: { S: 'value1' },
						},
					},
				},
				{
					eventID: '7',
					eventName: 'MODIFY',
					dynamodb: {
						NewImage: {
							pk: { S: 'MISSED' },
							status: { S: 'missed' },
							field2: { S: 'value2' },
						},
					},
				},
			],
		};

		(unmarshall as jest.Mock)
			.mockReturnValueOnce({
				pk: 'MISSED',
				status: 'missed',
				field1: 'value1',
			})
			.mockReturnValueOnce({
				pk: 'MISSED',
				status: 'missed',
				field2: 'value2',
			});

		await handler(mockEvent);

		expect(mockPutMesssages).toHaveBeenCalledWith({
			records: [
				{
					Id: '6',
					MessageBody: JSON.stringify({
						pk: 'MISSED',
						status: 'missed',
						field1: 'value1',
					}),
				},
				{
					Id: '7',
					MessageBody: JSON.stringify({
						pk: 'MISSED',
						status: 'missed',
						field2: 'value2',
					}),
				},
			],
		});
	});
});
