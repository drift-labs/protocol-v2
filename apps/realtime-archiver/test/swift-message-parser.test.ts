import { S3Event } from 'aws-lambda';
import { decodeMessage, handler } from '../src/swift-message-parser';

const mockGet = jest.fn();
const mockPut = jest.fn();
jest.mock('@backend/s3', () => ({
	S3: jest.fn().mockImplementation(() => ({
		getObject: mockGet,
		putObject: mockPut,
	})),
}));

describe.skip('Swift decode', () => {
	it('decodes OrderMetadataMessage', () => {
		const authorityMsg =
			'AAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQAAFc1bBwAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAIAAAAAAAAAAABCNkduR1BnTwAAAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAUI2R25HUGdPA9kAAAAAAAA==';
		const expected = {
			takerAuthority: '1111111ogCyDbaRMvkdsHB3qfdyFYaG1WtRUAfdh',
			signingAuthority: '1111111QLbz7JHiBTspS962RLKV8GndWFwiEaqKM',
			orderMessage: {
				signedMsgOrderParams: {
					orderType: 'limit',
					marketType: 'perp',
					direction: 'long',
					userOrderId: 0,
					baseAssetAmount: '123456789',
					price: '0',
					bitFlags: 0,
					marketIndex: 24,
					reduceOnly: false,
					postOnly: 'none',
					immediateOrCancel: false,
					maxTs: null,
					triggerPrice: null,
					triggerCondition: 'above',
					oraclePriceOffset: null,
					auctionDuration: null,
					auctionStartPrice: null,
					auctionEndPrice: null,
				},
				subAccountId: 2,
				slot: '0',
				uuid: [66, 54, 71, 110, 71, 80, 103, 79],
				takeProfitOrderParams: null,
				stopLossOrderParams: null,
			},
			orderSignature: [
				1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
				1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
				1, 1, 1, 1, 1, 1, 1, 1,
			],
			uuid: [66, 54, 71, 110, 71, 80, 103, 79],
			ts: '55555',
			hash: 'fIl14eYKXIM38o7fjDPDsYA2C3J5ZEqbwa88UeYiC/U=',
		};
		try {
			const actual = decodeMessage(authorityMsg);
			expect(expected).toMatchObject(actual);
		} catch (err) {
			console.error(err);
			expect(false).toBe(true);
		}
	});

	it('decodes OrderMetadataMessage delegated', () => {
		const delegatedMsg =
			'6XdS744oATmLaAmWmyaffcIrPjitW8iCeY8MwX+gOy45UxHVHBuH/VbDtYctEEERHlHzmbEtKR2YGg6jg0BylQEAAQEAgIQeAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAEyAbtgUH0AAAAAARfAEnwAAAAAOVMR1Rwbh/1Ww7WHLRBBER5R85mxLSkdmBoOo4NAcpUnIQgWAAAAAHM4bHVKTFplAAD0byW7AV94BzbkfBcKBpSOsq/rIkdwwUOrhni49eqibmaHBnrdhTmDunTsrF78ApK3kD/048OHec39z0geOQIMczhsdUpMWmUD2QAAAAAAAA==';
		const expected = {
			takerAuthority: 'GiMXQkJXLVjScmQDkoLJShBJpTh9SDPvT2AZQq8NyEBf',
			signingAuthority: '4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE',
			orderMessage: {
				signedMsgOrderParams: {
					orderType: 'market',
					marketType: 'perp',
					direction: 'short',
					userOrderId: 0,
					baseAssetAmount: '2000000',
					price: '0',
					marketIndex: 2,
					reduceOnly: false,
					postOnly: 'none',
					immediateOrCancel: false,
					bitFlags: 0,
					maxTs: null,
					triggerPrice: null,
					triggerCondition: 'above',
					oraclePriceOffset: null,
					auctionDuration: 50,
					auctionStartPrice: '2102419643',
					auctionEndPrice: '2081603607',
				},
				takerPubkey: '4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE',
				slot: '369631527',
				uuid: [115, 56, 108, 117, 74, 76, 90, 101],
				takeProfitOrderParams: null,
				stopLossOrderParams: null,
			},
			orderSignature: [
				244, 111, 37, 187, 1, 95, 120, 7, 54, 228, 124, 23, 10, 6, 148, 142, 178, 175, 235,
				34, 71, 112, 193, 67, 171, 134, 120, 184, 245, 234, 162, 110, 102, 135, 6, 122, 221,
				133, 57, 131, 186, 116, 236, 172, 94, 252, 2, 146, 183, 144, 63, 244, 227, 195, 135,
				121, 205, 253, 207, 72, 30, 57, 2, 12,
			],
			uuid: [115, 56, 108, 117, 74, 76, 90, 101],
			ts: '55555',
			hash: 'd5ePvlb+0e4Sktfi6R/OA11J8vsPllXu3wjMpjrrs6Q=',
		};
		try {
			const actual = decodeMessage(delegatedMsg);
			expect(expected).toMatchObject(actual);
		} catch (err) {
			console.error(err);
			expect(false).toBe(true);
		}
	});
});

describe.skip('Swift Transformer', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		process.env.DESTINATION_BUCKET = 'test-destination-bucket';
	});

	const createS3Event = (key: string) =>
		({
			Records: [
				{
					eventVersion: '2.1',
					eventSource: 'aws:s3',
					awsRegion: 'us-east-1',
					eventTime: '2023-01-01T00:00:00.000Z',
					eventName: 'ObjectCreated:Put',
					s3: {
						s3SchemaVersion: '1.0',
						configurationId: 'test-config',
						bucket: {
							name: 'test-bucket',
							arn: 'arn:aws:s3:::test-bucket',
							ownerIdentity: { principalId: 'test' },
						},
						object: {
							key,
							size: 1024,
							eTag: 'test-etag',
							sequencer: 'test',
						},
					},
				},
			],
		} as S3Event);
	const sourceKey =
		'topics/swift_orders_perp_24/year=2025/month=01/day=24/hour=06/swift_orders_perp_24+0+0002052942.bin';
	const encodedContent =
		'6XdS744oATmLaAmWmyaffcIrPjitW8iCeY8MwX+gOy45UxHVHBuH/VbDtYctEEERHlHzmbEtKR2YGg6jg0BylQEAAQEAgIQeAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAEyAbtgUH0AAAAAARfAEnwAAAAAOVMR1Rwbh/1Ww7WHLRBBER5R85mxLSkdmBoOo4NAcpUnIQgWAAAAAHM4bHVKTFplAAD0byW7AV94BzbkfBcKBpSOsq/rIkdwwUOrhni49eqibmaHBnrdhTmDunTsrF78ApK3kD/048OHec39z0geOQIMczhsdUpMWmUD2QAAAAAAAA==';
	const decodedContent =
		'{"takerAuthority":"GiMXQkJXLVjScmQDkoLJShBJpTh9SDPvT2AZQq8NyEBf","signingAuthority":"4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE","orderMessage":{"signedMsgOrderParams":{"orderType":"market","marketType":"perp","direction":"short","userOrderId":0,"baseAssetAmount":"2000000","price":"0","marketIndex":2,"reduceOnly":false,"postOnly":"none","bitFlags":0,"maxTs":null,"triggerPrice":null,"triggerCondition":"above","oraclePriceOffset":null,"auctionDuration":50,"auctionStartPrice":"2102419643","auctionEndPrice":"2081603607"},"takerPubkey":"4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE","slot":"369631527","uuid":[115,56,108,117,74,76,90,101],"takeProfitOrderParams":null,"stopLossOrderParams":null},"orderSignature":[244,111,37,187,1,95,120,7,54,228,124,23,10,6,148,142,178,175,235,34,71,112,193,67,171,134,120,184,245,234,162,110,102,135,6,122,221,133,57,131,186,116,236,172,94,252,2,146,183,144,63,244,227,195,135,121,205,253,207,72,30,57,2,12],"uuid":[115,56,108,117,74,76,90,101],"ts":"55555","hash":"d5ePvlb+0e4Sktfi6R/OA11J8vsPllXu3wjMpjrrs6Q="}';

	it('should successfully process file with valid base64 content', async () => {
		mockGet.mockResolvedValue(`${encodedContent}\n${encodedContent}`);
		mockPut.mockResolvedValue(undefined);
		await handler(createS3Event(sourceKey));
		expect(mockGet).toHaveBeenCalledWith(sourceKey);
		expect(mockPut).toHaveBeenCalledWith(
			`parsed/${sourceKey}.gz`,
			`${decodedContent}\n${decodedContent}`
		);
	});

	it('should handle invalid base64 content gracefully', async () => {
		const invalidLine = 'invalid-base64!@#';
		mockGet.mockResolvedValue(`${encodedContent}\n${invalidLine}`);
		mockPut.mockResolvedValue(undefined);
		await handler(createS3Event(sourceKey));
		expect(mockGet).toHaveBeenCalledWith(sourceKey);
		expect(mockPut).toHaveBeenCalledWith(
			`parsed/${sourceKey}.gz`,
			`${decodedContent}\n${invalidLine}`
		);
	});

	it('should process multiple records in event', async () => {
		const event: S3Event = {
			Records: [createS3Event(sourceKey).Records[0], createS3Event(sourceKey).Records[0]],
		};
		mockGet.mockResolvedValue(encodedContent);
		mockPut.mockResolvedValue(undefined);
		const result = await handler(event);
		expect(mockGet).toHaveBeenCalledTimes(2);
		expect(mockPut).toHaveBeenCalledTimes(2);
	});
});
