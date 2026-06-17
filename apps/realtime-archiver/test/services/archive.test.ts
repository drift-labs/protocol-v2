import { DBRecord, EntityTypes, IngestionSource, RecordTypes } from '@backend/common';
import { Archiver } from '../../src/services/archive';

const mockList = jest.fn();
const mockGet = jest.fn();
const mockPut = jest.fn();
jest.mock('@backend/s3', () => ({
	S3: jest.fn().mockImplementation(() => ({
		listObjects: mockList,
		getObject: mockGet,
		putObject: mockPut,
	})),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	isFeatureEnabled: jest.fn().mockReturnValue(true),
}));

describe('Archive Service', () => {
	const {
		processType,
		getUniqueRecords,
		sortRecords,
		getRecords,
		destructureKey,
		getRecordFileName,
		getRecordPathName,
		transformRecord,
	} = Archiver();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('processType', () => {
		it('should process and upload new records when file does not exist', async () => {
			mockList.mockResolvedValue([]);
			await processType({
				key: 'users/user=123/eventType=TradeRecord/year=2024/month=10',
				records: [{ txSig: 'sig1', txSigIndex: 1 } as DBRecord],
			});

			expect(mockList).toHaveBeenCalledWith(
				'users/user=123/eventType=TradeRecord/year=2024/month=10'
			);

			expect(mockPut).toHaveBeenCalledWith(
				'users/user=123/eventType=TradeRecord/year=2024/month=10/1.json.gz',
				JSON.stringify({
					meta: {
						records: 1,
						currentPage: 1,
						nextPage: null,
						totalRecords: 1,
						totalPages: 1,
					},
					records: [{ txSig: 'sig1', txSigIndex: 1 }],
				})
			);
		});

		it('should paginate records', async () => {
			mockList.mockResolvedValueOnce([{ Key: 'key1/1.json.gz' }, { Key: 'key1/2.json.gz' }]);

			mockGet
				.mockResolvedValueOnce(
					JSON.stringify({
						meta: { totalPages: 2, totalRecords: 3, currentPage: 1 },
						records: [
							{ txSig: 'sig1', txSigIndex: 1, ts: 1 },
							{ txSig: 'sig2', txSigIndex: 2, ts: 2 },
						],
					})
				)
				.mockResolvedValueOnce(
					JSON.stringify({
						meta: { totalPages: 2, totalRecords: 3, currentPage: 2 },
						records: [{ txSig: 'sig3', txSigIndex: 3, ts: 3 }],
					})
				);

			const PAGE_SIZE = 2;

			await processType({
				key: 'key1',
				records: [
					{ txSig: 'sig2', txSigIndex: 2, ts: 4 },
					{ txSig: 'sig4', txSigIndex: 4, ts: 5 },
					{ txSig: 'sig5', txSigIndex: 5, ts: 6 },
				] as DBRecord[],
				pageSize: PAGE_SIZE,
			});

			expect(mockPut).toHaveBeenCalledTimes(3);

			expect(mockPut).toHaveBeenNthCalledWith(
				1,
				'key1/1.json.gz',
				JSON.stringify({
					meta: {
						records: 2,
						currentPage: 1,
						nextPage: 2,
						totalRecords: 5,
						totalPages: 3,
					},
					records: [
						{ txSig: 'sig5', txSigIndex: 5, ts: 6 },
						{ txSig: 'sig4', txSigIndex: 4, ts: 5 },
					],
				})
			);

			expect(mockPut).toHaveBeenNthCalledWith(
				2,
				'key1/2.json.gz',
				JSON.stringify({
					meta: {
						records: 2,
						currentPage: 2,
						nextPage: 3,
						totalRecords: 5,
						totalPages: 3,
					},
					records: [
						{ txSig: 'sig2', txSigIndex: 2, ts: 4 },
						{ txSig: 'sig3', txSigIndex: 3, ts: 3 },
					],
				})
			);

			expect(mockPut).toHaveBeenNthCalledWith(
				3,
				'key1/3.json.gz',
				JSON.stringify({
					meta: {
						records: 1,
						currentPage: 3,
						nextPage: null,
						totalRecords: 5,
						totalPages: 3,
					},
					records: [{ txSig: 'sig1', txSigIndex: 1, ts: 1 }],
				})
			);
		});
	});

	describe('getUniqueRecords', () => {
		it('should remove duplicate records based on txSig and txSigIndex', () => {
			const records = [
				{ txSig: 'sig1', txSigIndex: 1, ts: 1 },
				{ txSig: 'sig1', txSigIndex: 1, ts: 1 },
				{ txSig: 'sig1', txSigIndex: 2, ts: 1 },
				{ txSig: 'sig2', txSigIndex: 1, ts: 3 },
			] as DBRecord[];

			const result = getUniqueRecords({ records });

			expect(result).toEqual([
				{ txSig: 'sig2', txSigIndex: 1, ts: 3 },
				{ txSig: 'sig1', txSigIndex: 1, ts: 1 },
				{ txSig: 'sig1', txSigIndex: 2, ts: 1 },
			]);
		});
	});

	describe('sortRecords', () => {
		it('should group and transform records', () => {
			const records = [
				{
					eventType: 'TradeRecord',
					action: 'fill',
					taker: 'user1',
					maker: 'user2',
					marketType: 'perp',
					marketIndex: 0,
				},
				{
					eventType: 'TradeRecord',
					action: 'fill',
					taker: 'user1',
					maker: '',
					marketType: 'perp',
					marketIndex: 0,
				},
				{ eventType: 'DontProcess', user: 'user3' },
			];

			const result = sortRecords({ records });

			expect(result).toEqual({
				user: {
					user1: [
						{
							action: 'fill',
							actionExplanation: undefined,
							baseAssetAmountFilled: 0,
							bitFlags: 0,
							fillRecordId: undefined,
							filler: undefined,
							fillerReward: 0,
							maker: 'user2',
							makerFee: 0,
							makerOrderBaseAssetAmount: 0,
							makerOrderCumulativeBaseAssetAmountFilled: 0,
							makerOrderCumulativeQuoteAssetAmountFilled: 0,
							makerOrderDirection: undefined,
							makerOrderId: undefined,
							makerRebate: 0,
							marketFilter: undefined,
							marketIndex: 0,
							marketType: 'perp',
							oraclePrice: 0,
							quoteAssetAmountFilled: 0,
							quoteAssetAmountSurplus: 0,
							referrerReward: 0,
							slot: undefined,
							spotFulfillmentMethodFee: 0,
							taker: 'user1',
							takerFee: 0,
							takerOrderBaseAssetAmount: 0,
							takerOrderCumulativeBaseAssetAmountFilled: 0,
							takerOrderCumulativeQuoteAssetAmountFilled: 0,
							takerOrderDirection: undefined,
							takerOrderId: undefined,
							ts: 0,
							txSig: undefined,
							user: 'user1',
							symbol: 'SOL-PERP',
							entity: 'user',
							source: IngestionSource.SEQUENTIAL,
							takerExistingQuoteEntryAmount: null,
							makerExistingQuoteEntryAmount: null,
							takerExistingBaseAssetAmount: null,
							makerExistingBaseAssetAmount: null,
							userExistingQuoteEntryAmount: null,
							userExistingBaseAssetAmount: null,
						},
						{
							action: 'fill',
							actionExplanation: undefined,
							baseAssetAmountFilled: 0,
							bitFlags: 0,
							fillRecordId: undefined,
							filler: undefined,
							fillerReward: 0,
							maker: '',
							makerFee: 0,
							makerOrderBaseAssetAmount: 0,
							makerOrderCumulativeBaseAssetAmountFilled: 0,
							makerOrderCumulativeQuoteAssetAmountFilled: 0,
							makerOrderDirection: undefined,
							makerOrderId: undefined,
							makerRebate: 0,
							marketFilter: undefined,
							marketIndex: 0,
							marketType: 'perp',
							oraclePrice: 0,
							quoteAssetAmountFilled: 0,
							quoteAssetAmountSurplus: 0,
							referrerReward: 0,
							slot: undefined,
							spotFulfillmentMethodFee: 0,
							taker: 'user1',
							takerFee: 0,
							takerOrderBaseAssetAmount: 0,
							takerOrderCumulativeBaseAssetAmountFilled: 0,
							takerOrderCumulativeQuoteAssetAmountFilled: 0,
							takerOrderDirection: undefined,
							takerOrderId: undefined,
							ts: 0,
							txSig: undefined,
							user: 'user1',
							entity: 'user',
							symbol: 'SOL-PERP',
							source: IngestionSource.SEQUENTIAL,
							takerExistingQuoteEntryAmount: null,
							makerExistingQuoteEntryAmount: null,
							takerExistingBaseAssetAmount: null,
							makerExistingBaseAssetAmount: null,
							userExistingQuoteEntryAmount: null,
							userExistingBaseAssetAmount: null,
						},
					],
					user2: [
						{
							action: 'fill',
							actionExplanation: undefined,
							baseAssetAmountFilled: 0,
							bitFlags: 0,
							fillRecordId: undefined,
							filler: undefined,
							fillerReward: 0,
							maker: 'user2',
							makerFee: 0,
							makerOrderBaseAssetAmount: 0,
							makerOrderCumulativeBaseAssetAmountFilled: 0,
							makerOrderCumulativeQuoteAssetAmountFilled: 0,
							makerOrderDirection: undefined,
							makerOrderId: undefined,
							makerRebate: 0,
							marketFilter: undefined,
							marketIndex: 0,
							marketType: 'perp',
							oraclePrice: 0,
							quoteAssetAmountFilled: 0,
							quoteAssetAmountSurplus: 0,
							referrerReward: 0,
							slot: undefined,
							spotFulfillmentMethodFee: 0,
							taker: 'user1',
							takerFee: 0,
							takerOrderBaseAssetAmount: 0,
							takerOrderCumulativeBaseAssetAmountFilled: 0,
							takerOrderCumulativeQuoteAssetAmountFilled: 0,
							takerOrderDirection: undefined,
							takerOrderId: undefined,
							ts: 0,
							txSig: undefined,
							user: 'user2',
							entity: 'user',
							symbol: 'SOL-PERP',
							source: IngestionSource.SEQUENTIAL,
							takerExistingQuoteEntryAmount: null,
							makerExistingQuoteEntryAmount: null,
							takerExistingBaseAssetAmount: null,
							makerExistingBaseAssetAmount: null,
							userExistingQuoteEntryAmount: null,
							userExistingBaseAssetAmount: null,
						},
					],
				},
				authority: {},
				market: {
					'SOL-PERP': [
						{
							action: 'fill',
							actionExplanation: undefined,
							baseAssetAmountFilled: 0,
							bitFlags: 0,
							entity: 'market',
							fillRecordId: undefined,
							filler: undefined,
							fillerReward: 0,
							maker: 'user2',
							makerFee: 0,
							makerOrderBaseAssetAmount: 0,
							makerOrderCumulativeBaseAssetAmountFilled: 0,
							makerOrderCumulativeQuoteAssetAmountFilled: 0,
							makerOrderDirection: undefined,
							makerOrderId: undefined,
							makerRebate: 0,
							marketFilter: undefined,
							marketIndex: 0,
							marketType: 'perp',
							oraclePrice: 0,
							quoteAssetAmountFilled: 0,
							quoteAssetAmountSurplus: 0,
							referrerReward: 0,
							slot: undefined,
							source: 'seq',
							spotFulfillmentMethodFee: 0,
							symbol: 'SOL-PERP',
							taker: 'user1',
							takerFee: 0,
							takerOrderBaseAssetAmount: 0,
							takerOrderCumulativeBaseAssetAmountFilled: 0,
							takerOrderCumulativeQuoteAssetAmountFilled: 0,
							takerOrderDirection: undefined,
							takerOrderId: undefined,
							ts: 0,
							txSig: undefined,
							txSigIndex: undefined,
							takerExistingQuoteEntryAmount: null,
							makerExistingQuoteEntryAmount: null,
							takerExistingBaseAssetAmount: null,
							makerExistingBaseAssetAmount: null,
						},
						{
							action: 'fill',
							actionExplanation: undefined,
							baseAssetAmountFilled: 0,
							bitFlags: 0,
							entity: 'market',
							fillRecordId: undefined,
							filler: undefined,
							fillerReward: 0,
							maker: '',
							makerFee: 0,
							makerOrderBaseAssetAmount: 0,
							makerOrderCumulativeBaseAssetAmountFilled: 0,
							makerOrderCumulativeQuoteAssetAmountFilled: 0,
							makerOrderDirection: undefined,
							makerOrderId: undefined,
							makerRebate: 0,
							marketFilter: undefined,
							marketIndex: 0,
							marketType: 'perp',
							oraclePrice: 0,
							quoteAssetAmountFilled: 0,
							quoteAssetAmountSurplus: 0,
							referrerReward: 0,
							slot: undefined,
							source: 'seq',
							spotFulfillmentMethodFee: 0,
							symbol: 'SOL-PERP',
							taker: 'user1',
							takerFee: 0,
							takerOrderBaseAssetAmount: 0,
							takerOrderCumulativeBaseAssetAmountFilled: 0,
							takerOrderCumulativeQuoteAssetAmountFilled: 0,
							takerOrderDirection: undefined,
							takerOrderId: undefined,
							ts: 0,
							txSig: undefined,
							txSigIndex: undefined,
							takerExistingQuoteEntryAmount: null,
							makerExistingQuoteEntryAmount: null,
							takerExistingBaseAssetAmount: null,
							makerExistingBaseAssetAmount: null,
						},
					],
				},
			});
		});

		describe('TradeRecord', () => {
			it('should correctly parse TradeRecord data with existing maker position reduction', () => {
				const mockData = {
					ts: '1728344611',
					action: 'fill',
					actionExplanation: 'orderFilledWithMatch',
					marketIndex: 0,
					marketType: 'perp',
					marketFilter: 'perp',
					filler: 'user-filler',
					fillerReward: '2894',
					fillRecordId: '7796732',
					baseAssetAmountFilled: '800000000',
					quoteAssetAmountFilled: '115786000',
					takerFee: '28947',
					makerFee: '-2894',
					referrerReward: null,
					quoteAssetAmountSurplus: null,
					spotFulfillmentMethodFee: null,
					taker: 'user-taker',
					takerOrderId: 19731,
					takerOrderDirection: 'short',
					takerOrderBaseAssetAmount: '1000000000',
					takerOrderCumulativeBaseAssetAmountFilled: '1000000000',
					takerOrderCumulativeQuoteAssetAmountFilled: '144732500',
					maker: 'user-maker',
					makerOrderId: 19590370,
					makerOrderDirection: 'long',
					makerOrderBaseAssetAmount: '6900000000',
					makerOrderCumulativeBaseAssetAmountFilled: '800000000',
					makerOrderCumulativeQuoteAssetAmountFilled: '115786000',
					oraclePrice: '144699404',
					txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
					slot: 294325004,
					eventType: 'TradeRecord',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
					makerExistingQuoteEntryAmount: '13800000',
				};

				const result = sortRecords({ records: [mockData] });

				expect(result).toEqual({
					user: {
						'user-taker': [
							{
								user: 'user-taker',
								fillerReward: 0.002894,
								baseAssetAmountFilled: 0.8,
								bitFlags: 0,
								quoteAssetAmountFilled: 115.786,
								takerFee: 0.028947,
								makerRebate: -0.002894,
								marketFilter: 'perp',
								referrerReward: 0,
								quoteAssetAmountSurplus: 0,
								takerOrderBaseAssetAmount: 1,
								takerOrderCumulativeBaseAssetAmountFilled: 1,
								takerOrderCumulativeQuoteAssetAmountFilled: 144.7325,
								makerOrderBaseAssetAmount: 6.9,
								makerOrderCumulativeBaseAssetAmountFilled: 0.8,
								makerOrderCumulativeQuoteAssetAmountFilled: 115.786,
								oraclePrice: 144.699404,
								makerFee: -0.002894,
								txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
								txSigIndex: 1,
								source: IngestionSource.SEQUENTIAL,
								slot: 294325004,
								ts: 1728344611,
								action: 'fill',
								actionExplanation: 'orderFilledWithMatch',
								marketIndex: 0,
								marketType: 'perp',
								filler: 'user-filler',
								fillRecordId: '7796732',
								taker: 'user-taker',
								takerOrderId: 19731,
								takerOrderDirection: 'short',
								maker: 'user-maker',
								makerOrderId: 19590370,
								makerOrderDirection: 'long',
								spotFulfillmentMethodFee: 0,
								entity: 'user',
								symbol: 'SOL-PERP',
								userOrderId: 19731,
								makerExistingQuoteEntryAmount: 13.8,
								takerExistingBaseAssetAmount: null,
								takerExistingQuoteEntryAmount: null,
								makerExistingBaseAssetAmount: null,
								userExistingBaseAssetAmount: null,
								userExistingQuoteEntryAmount: null,
							},
						],
						'user-maker': [
							{
								user: 'user-maker',
								fillerReward: 0.002894,
								baseAssetAmountFilled: 0.8,
								bitFlags: 0,
								quoteAssetAmountFilled: 115.786,
								takerFee: 0.028947,
								makerRebate: -0.002894,
								marketFilter: 'perp',
								referrerReward: 0,
								quoteAssetAmountSurplus: 0,
								takerOrderBaseAssetAmount: 1,
								takerOrderCumulativeBaseAssetAmountFilled: 1,
								takerOrderCumulativeQuoteAssetAmountFilled: 144.7325,
								makerOrderBaseAssetAmount: 6.9,
								makerOrderCumulativeBaseAssetAmountFilled: 0.8,
								makerOrderCumulativeQuoteAssetAmountFilled: 115.786,
								oraclePrice: 144.699404,
								makerFee: -0.002894,
								txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
								txSigIndex: 1,
								source: IngestionSource.SEQUENTIAL,
								slot: 294325004,
								ts: 1728344611,
								action: 'fill',
								actionExplanation: 'orderFilledWithMatch',
								marketIndex: 0,
								marketType: 'perp',
								filler: 'user-filler',
								fillRecordId: '7796732',
								taker: 'user-taker',
								takerOrderId: 19731,
								takerOrderDirection: 'short',
								maker: 'user-maker',
								makerOrderId: 19590370,
								makerOrderDirection: 'long',
								spotFulfillmentMethodFee: 0,
								entity: 'user',
								symbol: 'SOL-PERP',
								userOrderId: 19590370,
								takerExistingBaseAssetAmount: null,
								takerExistingQuoteEntryAmount: null,
								makerExistingQuoteEntryAmount: 13.8,
								makerExistingBaseAssetAmount: null,
								userExistingQuoteEntryAmount: 13.8,
								userExistingBaseAssetAmount: null,
							},
						],
					},
					authority: {},
					market: {
						'SOL-PERP': [
							{
								symbol: 'SOL-PERP',
								fillerReward: 0.002894,
								baseAssetAmountFilled: 0.8,
								bitFlags: 0,
								quoteAssetAmountFilled: 115.786,
								takerFee: 0.028947,
								makerRebate: -0.002894,
								marketFilter: 'perp',
								referrerReward: 0,
								quoteAssetAmountSurplus: 0,
								takerOrderBaseAssetAmount: 1,
								takerOrderCumulativeBaseAssetAmountFilled: 1,
								takerOrderCumulativeQuoteAssetAmountFilled: 144.7325,
								makerOrderBaseAssetAmount: 6.9,
								makerOrderCumulativeBaseAssetAmountFilled: 0.8,
								makerOrderCumulativeQuoteAssetAmountFilled: 115.786,
								oraclePrice: 144.699404,
								makerFee: -0.002894,
								txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
								txSigIndex: 1,
								source: IngestionSource.SEQUENTIAL,
								slot: 294325004,
								ts: 1728344611,
								action: 'fill',
								actionExplanation: 'orderFilledWithMatch',
								marketIndex: 0,
								marketType: 'perp',
								filler: 'user-filler',
								fillRecordId: '7796732',
								taker: 'user-taker',
								takerOrderId: 19731,
								takerOrderDirection: 'short',
								maker: 'user-maker',
								makerOrderId: 19590370,
								makerOrderDirection: 'long',
								spotFulfillmentMethodFee: 0,
								entity: 'market',
								makerExistingQuoteEntryAmount: 13.8,
								makerExistingBaseAssetAmount: null,
								takerExistingBaseAssetAmount: null,
								takerExistingQuoteEntryAmount: null,
							},
						],
					},
				});
			});

			it('should correctly parse TradeRecord data with existing taker position reduction', () => {
				const mockData = {
					ts: '1728344611',
					action: 'fill',
					actionExplanation: 'orderFilledWithMatch',
					marketIndex: 0,
					marketType: 'perp',
					marketFilter: 'perp',
					filler: 'user-filler',
					fillerReward: '2894',
					fillRecordId: '7796732',
					baseAssetAmountFilled: '800000000',
					quoteAssetAmountFilled: '115786000',
					takerFee: '28947',
					makerFee: '-2894',
					referrerReward: null,
					quoteAssetAmountSurplus: null,
					spotFulfillmentMethodFee: null,
					taker: 'user-taker',
					takerOrderId: 19731,
					takerOrderDirection: 'short',
					takerOrderBaseAssetAmount: '1000000000',
					takerOrderCumulativeBaseAssetAmountFilled: '1000000000',
					takerOrderCumulativeQuoteAssetAmountFilled: '144732500',
					maker: 'user-maker',
					makerOrderId: 19590370,
					makerOrderDirection: 'long',
					makerOrderBaseAssetAmount: '6900000000',
					makerOrderCumulativeBaseAssetAmountFilled: '800000000',
					makerOrderCumulativeQuoteAssetAmountFilled: '115786000',
					oraclePrice: '144699404',
					txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
					slot: 294325004,
					eventType: 'TradeRecord',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
					takerExistingQuoteEntryAmount: '2500000',
				};

				const result = sortRecords({ records: [mockData] });

				expect(result).toEqual({
					user: {
						'user-taker': [
							{
								user: 'user-taker',
								fillerReward: 0.002894,
								baseAssetAmountFilled: 0.8,
								bitFlags: 0,
								quoteAssetAmountFilled: 115.786,
								takerFee: 0.028947,
								makerRebate: -0.002894,
								marketFilter: 'perp',
								referrerReward: 0,
								quoteAssetAmountSurplus: 0,
								takerOrderBaseAssetAmount: 1,
								takerOrderCumulativeBaseAssetAmountFilled: 1,
								takerOrderCumulativeQuoteAssetAmountFilled: 144.7325,
								makerOrderBaseAssetAmount: 6.9,
								makerOrderCumulativeBaseAssetAmountFilled: 0.8,
								makerOrderCumulativeQuoteAssetAmountFilled: 115.786,
								oraclePrice: 144.699404,
								makerFee: -0.002894,
								txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
								txSigIndex: 1,
								source: IngestionSource.SEQUENTIAL,
								slot: 294325004,
								ts: 1728344611,
								action: 'fill',
								actionExplanation: 'orderFilledWithMatch',
								marketIndex: 0,
								marketType: 'perp',
								filler: 'user-filler',
								fillRecordId: '7796732',
								taker: 'user-taker',
								takerOrderId: 19731,
								takerOrderDirection: 'short',
								maker: 'user-maker',
								makerOrderId: 19590370,
								makerOrderDirection: 'long',
								spotFulfillmentMethodFee: 0,
								entity: 'user',
								symbol: 'SOL-PERP',
								userOrderId: 19731,
								takerExistingQuoteEntryAmount: 2.5,
								userExistingQuoteEntryAmount: 2.5,
								userExistingBaseAssetAmount: null,
								takerExistingBaseAssetAmount: null,
								makerExistingQuoteEntryAmount: null,
								makerExistingBaseAssetAmount: null,
							},
						],
						'user-maker': [
							{
								user: 'user-maker',
								fillerReward: 0.002894,
								baseAssetAmountFilled: 0.8,
								bitFlags: 0,
								quoteAssetAmountFilled: 115.786,
								takerFee: 0.028947,
								makerRebate: -0.002894,
								marketFilter: 'perp',
								referrerReward: 0,
								quoteAssetAmountSurplus: 0,
								takerOrderBaseAssetAmount: 1,
								takerOrderCumulativeBaseAssetAmountFilled: 1,
								takerOrderCumulativeQuoteAssetAmountFilled: 144.7325,
								makerOrderBaseAssetAmount: 6.9,
								makerOrderCumulativeBaseAssetAmountFilled: 0.8,
								makerOrderCumulativeQuoteAssetAmountFilled: 115.786,
								oraclePrice: 144.699404,
								makerFee: -0.002894,
								txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
								txSigIndex: 1,
								source: IngestionSource.SEQUENTIAL,
								slot: 294325004,
								ts: 1728344611,
								action: 'fill',
								actionExplanation: 'orderFilledWithMatch',
								marketIndex: 0,
								marketType: 'perp',
								filler: 'user-filler',
								fillRecordId: '7796732',
								taker: 'user-taker',
								takerOrderId: 19731,
								takerOrderDirection: 'short',
								maker: 'user-maker',
								makerOrderId: 19590370,
								makerOrderDirection: 'long',
								spotFulfillmentMethodFee: 0,
								entity: 'user',
								symbol: 'SOL-PERP',
								userOrderId: 19590370,
								takerExistingQuoteEntryAmount: 2.5,
								takerExistingBaseAssetAmount: null,
								makerExistingQuoteEntryAmount: null,
								makerExistingBaseAssetAmount: null,
								userExistingBaseAssetAmount: null,
								userExistingQuoteEntryAmount: null,
							},
						],
					},
					authority: {},
					market: {
						'SOL-PERP': [
							{
								symbol: 'SOL-PERP',
								fillerReward: 0.002894,
								baseAssetAmountFilled: 0.8,
								bitFlags: 0,
								quoteAssetAmountFilled: 115.786,
								takerFee: 0.028947,
								makerRebate: -0.002894,
								marketFilter: 'perp',
								referrerReward: 0,
								quoteAssetAmountSurplus: 0,
								takerOrderBaseAssetAmount: 1,
								takerOrderCumulativeBaseAssetAmountFilled: 1,
								takerOrderCumulativeQuoteAssetAmountFilled: 144.7325,
								makerOrderBaseAssetAmount: 6.9,
								makerOrderCumulativeBaseAssetAmountFilled: 0.8,
								makerOrderCumulativeQuoteAssetAmountFilled: 115.786,
								oraclePrice: 144.699404,
								makerFee: -0.002894,
								txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
								txSigIndex: 1,
								source: IngestionSource.SEQUENTIAL,
								slot: 294325004,
								ts: 1728344611,
								action: 'fill',
								actionExplanation: 'orderFilledWithMatch',
								marketIndex: 0,
								marketType: 'perp',
								filler: 'user-filler',
								fillRecordId: '7796732',
								taker: 'user-taker',
								takerOrderId: 19731,
								takerOrderDirection: 'short',
								maker: 'user-maker',
								makerOrderId: 19590370,
								makerOrderDirection: 'long',
								spotFulfillmentMethodFee: 0,
								entity: 'market',
								takerExistingQuoteEntryAmount: 2.5,
								takerExistingBaseAssetAmount: null,
								makerExistingQuoteEntryAmount: null,
								makerExistingBaseAssetAmount: null,
							},
						],
					},
				});
			});
			it('should correctly parse TradeRecord data with taker position flipped due to reduction greater than the existing position size', () => {
				const mockData = {
					ts: '1728344611',
					action: 'fill',
					actionExplanation: 'orderFilledWithMatch',
					marketIndex: 0,
					marketType: 'perp',
					marketFilter: 'perp',
					filler: 'user-filler',
					fillerReward: '2894',
					fillRecordId: '7796732',
					baseAssetAmountFilled: '800000000',
					quoteAssetAmountFilled: '115786000',
					takerFee: '28947',
					makerFee: '-2894',
					referrerReward: null,
					quoteAssetAmountSurplus: null,
					spotFulfillmentMethodFee: null,
					taker: 'user-taker',
					takerOrderId: 19731,
					takerOrderDirection: 'short',
					takerOrderBaseAssetAmount: '1000000000',
					takerOrderCumulativeBaseAssetAmountFilled: '1000000000',
					takerOrderCumulativeQuoteAssetAmountFilled: '144732500',
					maker: 'user-maker',
					makerOrderId: 19590370,
					makerOrderDirection: 'long',
					makerOrderBaseAssetAmount: '6900000000',
					makerOrderCumulativeBaseAssetAmountFilled: '800000000',
					makerOrderCumulativeQuoteAssetAmountFilled: '115786000',
					oraclePrice: '144699404',
					txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
					slot: 294325004,
					eventType: 'TradeRecord',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
					takerExistingQuoteEntryAmount: '2500000',
					takerExistingBaseAssetAmount: '200000000',
					makerExistingQuoteEntryAmount: '13800000',
				};

				const result = sortRecords({ records: [mockData] });

				expect(result).toEqual({
					user: {
						'user-taker': [
							{
								user: 'user-taker',
								fillerReward: 0.002894,
								baseAssetAmountFilled: 0.8,
								bitFlags: 0,
								quoteAssetAmountFilled: 115.786,
								takerFee: 0.028947,
								makerRebate: -0.002894,
								marketFilter: 'perp',
								referrerReward: 0,
								quoteAssetAmountSurplus: 0,
								takerOrderBaseAssetAmount: 1,
								takerOrderCumulativeBaseAssetAmountFilled: 1,
								takerOrderCumulativeQuoteAssetAmountFilled: 144.7325,
								makerOrderBaseAssetAmount: 6.9,
								makerOrderCumulativeBaseAssetAmountFilled: 0.8,
								makerOrderCumulativeQuoteAssetAmountFilled: 115.786,
								oraclePrice: 144.699404,
								makerFee: -0.002894,
								txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
								txSigIndex: 1,
								source: IngestionSource.SEQUENTIAL,
								slot: 294325004,
								ts: 1728344611,
								action: 'fill',
								actionExplanation: 'orderFilledWithMatch',
								marketIndex: 0,
								marketType: 'perp',
								filler: 'user-filler',
								fillRecordId: '7796732',
								taker: 'user-taker',
								takerOrderId: 19731,
								takerOrderDirection: 'short',
								maker: 'user-maker',
								makerOrderId: 19590370,
								makerOrderDirection: 'long',
								spotFulfillmentMethodFee: 0,
								entity: 'user',
								symbol: 'SOL-PERP',
								userOrderId: 19731,
								takerExistingQuoteEntryAmount: 2.5,
								takerExistingBaseAssetAmount: 0.2,
								makerExistingQuoteEntryAmount: 13.8,
								makerExistingBaseAssetAmount: null,
								userExistingQuoteEntryAmount: 2.5,
								userExistingBaseAssetAmount: 0.2,
							},
						],
						'user-maker': [
							{
								user: 'user-maker',
								fillerReward: 0.002894,
								baseAssetAmountFilled: 0.8,
								bitFlags: 0,
								quoteAssetAmountFilled: 115.786,
								takerFee: 0.028947,
								makerRebate: -0.002894,
								marketFilter: 'perp',
								referrerReward: 0,
								quoteAssetAmountSurplus: 0,
								takerOrderBaseAssetAmount: 1,
								takerOrderCumulativeBaseAssetAmountFilled: 1,
								takerOrderCumulativeQuoteAssetAmountFilled: 144.7325,
								makerOrderBaseAssetAmount: 6.9,
								makerOrderCumulativeBaseAssetAmountFilled: 0.8,
								makerOrderCumulativeQuoteAssetAmountFilled: 115.786,
								oraclePrice: 144.699404,
								makerFee: -0.002894,
								txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
								txSigIndex: 1,
								source: IngestionSource.SEQUENTIAL,
								slot: 294325004,
								ts: 1728344611,
								action: 'fill',
								actionExplanation: 'orderFilledWithMatch',
								marketIndex: 0,
								marketType: 'perp',
								filler: 'user-filler',
								fillRecordId: '7796732',
								taker: 'user-taker',
								takerOrderId: 19731,
								takerOrderDirection: 'short',
								maker: 'user-maker',
								makerOrderId: 19590370,
								makerOrderDirection: 'long',
								spotFulfillmentMethodFee: 0,
								entity: 'user',
								symbol: 'SOL-PERP',
								userOrderId: 19590370,
								takerExistingQuoteEntryAmount: 2.5,
								takerExistingBaseAssetAmount: 0.2,
								makerExistingQuoteEntryAmount: 13.8,
								userExistingQuoteEntryAmount: 13.8,
								makerExistingBaseAssetAmount: null,
								userExistingBaseAssetAmount: null,
							},
						],
					},
					authority: {},
					market: {
						'SOL-PERP': [
							{
								symbol: 'SOL-PERP',
								fillerReward: 0.002894,
								baseAssetAmountFilled: 0.8,
								bitFlags: 0,
								quoteAssetAmountFilled: 115.786,
								takerFee: 0.028947,
								makerRebate: -0.002894,
								marketFilter: 'perp',
								referrerReward: 0,
								quoteAssetAmountSurplus: 0,
								takerOrderBaseAssetAmount: 1,
								takerOrderCumulativeBaseAssetAmountFilled: 1,
								takerOrderCumulativeQuoteAssetAmountFilled: 144.7325,
								makerOrderBaseAssetAmount: 6.9,
								makerOrderCumulativeBaseAssetAmountFilled: 0.8,
								makerOrderCumulativeQuoteAssetAmountFilled: 115.786,
								oraclePrice: 144.699404,
								makerFee: -0.002894,
								txSig: 'Q88JAM8R2UuHNJC3Dw1fgwEGanPe2SMjdSC7bewYdrfZDc4ngiTs7cEyrmRHoNkm2mAMi1T3K7bWCUYEuHBh27h',
								txSigIndex: 1,
								source: IngestionSource.SEQUENTIAL,
								slot: 294325004,
								ts: 1728344611,
								action: 'fill',
								actionExplanation: 'orderFilledWithMatch',
								marketIndex: 0,
								marketType: 'perp',
								filler: 'user-filler',
								fillRecordId: '7796732',
								taker: 'user-taker',
								takerOrderId: 19731,
								takerOrderDirection: 'short',
								maker: 'user-maker',
								makerOrderId: 19590370,
								makerOrderDirection: 'long',
								spotFulfillmentMethodFee: 0,
								entity: 'market',
								takerExistingQuoteEntryAmount: 2.5,
								takerExistingBaseAssetAmount: 0.2,
								makerExistingQuoteEntryAmount: 13.8,
								makerExistingBaseAssetAmount: null,
							},
						],
					},
				});
			});

			it('should not parse OrderActionRecord data', () => {
				const mockData = {
					ts: '1728344952',
					action: 'cancel',
					actionExplanation: 'orderExpired',
					marketIndex: 1,
					marketType: 'perp',
					filler: '6BNXUfsrmu5aFddZkJ6Q3ZaXDcf2jtkv4rkwKPAf2Lqv',
					fillerReward: '3000',
					fillRecordId: null,
					baseAssetAmountFilled: null,
					quoteAssetAmountFilled: null,
					takerFee: null,
					makerFee: null,
					referrerReward: null,
					quoteAssetAmountSurplus: null,
					spotFulfillmentMethodFee: null,
					taker: null,
					takerOrderId: null,
					takerOrderDirection: null,
					takerOrderBaseAssetAmount: null,
					takerOrderCumulativeBaseAssetAmountFilled: null,
					takerOrderCumulativeQuoteAssetAmountFilled: null,
					maker: 'EjsrAPWU4D9ftwyX9ErEptxBbqt8YaihnWqYp4RM65mz',
					makerOrderId: 80272653,
					makerOrderDirection: 'short',
					makerOrderBaseAssetAmount: '79900000',
					makerOrderCumulativeBaseAssetAmountFilled: '0',
					makerOrderCumulativeQuoteAssetAmountFilled: '0',
					oraclePrice: '62428558090',
					txSig: '4FMosRKmAFv2yT8PnfJvWTD7i5oSrcJhZsxcvr1xq4GVni42UShVLajdgbR1DpXR3ao2PMZwjfNEB5cj1vfHgHMi',
					slot: 294325738,
					txSigIndex: 3,
				};

				const result = sortRecords({ records: [mockData] });

				expect(result).toEqual({
					user: {},
					market: {},
					authority: {},
				});
			});
		});

		it('should correctly parse OrderRecord data', () => {
			const mockData = {
				ts: '1729641614',
				user: 'user1',
				order: {
					slot: '297137798',
					price: '167988100',
					baseAssetAmount: '390000000000',
					baseAssetAmountFilled: '0',
					quoteAssetAmountFilled: '0',
					triggerPrice: '0',
					auctionStartPrice: '0',
					auctionEndPrice: '0',
					maxTs: '1729641640',
					oraclePriceOffset: 0,
					orderId: 41654475,
					marketIndex: 1,
					status: 'open',
					orderType: 'limit',
					marketType: 'spot',
					userOrderId: 0,
					existingPositionDirection: 'short',
					direction: 'short',
					reduceOnly: false,
					postOnly: false,
					immediateOrCancel: false,
					triggerCondition: 'above',
					auctionDuration: 0,
					padding: [0, 0, 0],
				},
				txSig: 'wtMTj6RA7YPdvwT8PCbjx7DYdEiwj85jdhF8VzazJwb1ZMsVARZzCMTr33VNd7XAoCr15mFmoizc2Nyafa1yUSm',
				slot: 297137798,
				eventType: RecordTypes.OrderRecord,
				txSigIndex: 158,
			};

			const result = transformRecord(mockData);

			expect(result).toEqual([
				{
					ts: 1729641614,
					txSig: 'wtMTj6RA7YPdvwT8PCbjx7DYdEiwj85jdhF8VzazJwb1ZMsVARZzCMTr33VNd7XAoCr15mFmoizc2Nyafa1yUSm',
					txSigIndex: 158,
					slot: 297137798,
					user: 'user1',
					price: 167.9881,
					baseAssetAmount: 390,
					baseAssetAmountFilled: 0,
					quoteAssetAmount: 0,
					quoteAssetAmountFilled: 0,
					triggerPrice: 0,
					auctionStartPrice: 0,
					auctionEndPrice: 0,
					maxTs: 1729641640,
					oraclePriceOffset: 0,
					orderId: 41654475,
					marketIndex: 1,
					status: 'open',
					orderType: 'limit',
					marketType: 'spot',
					userOrderId: 0,
					existingPositionDirection: 'short',
					direction: 'short',
					reduceOnly: false,
					postOnly: false,
					immediateOrCancel: false,
					triggerCondition: 'above',
					symbol: 'SOL',
					auctionDuration: 0,
					entity: 'user',
					source: IngestionSource.SEQUENTIAL,
				},
			]);
		});

		it('should correctly parse SwapRecord data', () => {
			const mockData = {
				ts: '1728950847',
				user: 'user1',
				amountOut: '200000209',
				amountIn: '31466365',
				outMarketIndex: 1,
				inMarketIndex: 0,
				outOraclePrice: '157231940',
				inOraclePrice: '1000000',
				fee: '0',
				txSig: '3SxzYLYqZnsJMHgjeYf2iTcnMPxfXUgf4LaVfUh8o3gWQrXAZmtBPasVGfNMwwVXp4ZUgDE8dzWLH7rSkh4UDeT3',
				slot: 295662282,
				eventType: 'SwapRecord',
				txSigIndex: 5,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				user: {
					user1: [
						{
							ts: 1728950847,
							user: 'user1',
							amountOut: 0.200000209,
							amountIn: 31.466365,
							outMarketIndex: 1,
							inSymbol: 'USDC',
							outSymbol: 'SOL',
							inMarketIndex: 0,
							outOraclePrice: 157.23194,
							inOraclePrice: 1,
							fee: 0,
							txSig: '3SxzYLYqZnsJMHgjeYf2iTcnMPxfXUgf4LaVfUh8o3gWQrXAZmtBPasVGfNMwwVXp4ZUgDE8dzWLH7rSkh4UDeT3',
							slot: 295662282,
							txSigIndex: 5,
							entity: 'user',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				authority: {},
				market: {
					USDC: [
						{
							ts: 1728950847,
							user: 'user1',
							amountOut: 0.200000209,
							amountIn: 31.466365,
							outMarketIndex: 1,
							inSymbol: 'USDC',
							outSymbol: 'SOL',
							inMarketIndex: 0,
							outOraclePrice: 157.23194,
							inOraclePrice: 1,
							fee: 0,
							txSig: '3SxzYLYqZnsJMHgjeYf2iTcnMPxfXUgf4LaVfUh8o3gWQrXAZmtBPasVGfNMwwVXp4ZUgDE8dzWLH7rSkh4UDeT3',
							slot: 295662282,
							txSigIndex: 5,
							entity: 'market',
							isInMarket: true,
							source: IngestionSource.SEQUENTIAL,
						},
					],
					SOL: [
						{
							ts: 1728950847,
							user: 'user1',
							amountOut: 0.200000209,
							amountIn: 31.466365,
							outMarketIndex: 1,
							inSymbol: 'USDC',
							outSymbol: 'SOL',
							inMarketIndex: 0,
							outOraclePrice: 157.23194,
							inOraclePrice: 1,
							fee: 0,
							txSig: '3SxzYLYqZnsJMHgjeYf2iTcnMPxfXUgf4LaVfUh8o3gWQrXAZmtBPasVGfNMwwVXp4ZUgDE8dzWLH7rSkh4UDeT3',
							slot: 295662282,
							txSigIndex: 5,
							entity: 'market',
							isInMarket: false,
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
			});
		});

		it('should correctly parse SettlePnlRecord data', () => {
			const mockData = {
				ts: '1728281569',
				user: 'user1',
				marketIndex: 0,
				pnl: '28470753',
				baseAssetAmount: '136300000000',
				quoteAssetAmountAfter: '-20332234512',
				quoteEntryAmount: '-21400926420',
				settlePrice: '149172667',
				explanation: 'none',
				txSig: '5D6BrnxBvU88zeiHDMtj7G5KtBdv1yDgTuKKGTuSDb7THT4YWRJyT3Uh9UYFPkG8VRZr9KLia3uUhGeNwj3mCtWB',
				slot: 294185418,
				eventType: 'SettlePnlRecord',
				txSigIndex: 59,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				user: {
					user1: [
						{
							ts: 1728281569,
							user: 'user1',
							marketIndex: 0,
							pnl: 28.470753,
							baseAssetAmount: 136.3,
							quoteAssetAmountAfter: -20332.234512,
							quoteEntryAmount: -21400.92642,
							settlePrice: 149.172667,
							explanation: 'none',
							txSig: '5D6BrnxBvU88zeiHDMtj7G5KtBdv1yDgTuKKGTuSDb7THT4YWRJyT3Uh9UYFPkG8VRZr9KLia3uUhGeNwj3mCtWB',
							txSigIndex: 59,
							slot: 294185418,
							entity: 'user',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				authority: {},
				market: {},
			});
		});

		it('should correctly parse Deposit data', () => {
			const mockData = {
				ts: '1728344873',
				userAuthority: 'authority',
				user: 'user1',
				direction: 'deposit',
				depositRecordId: '10490877',
				amount: '64999000000',
				marketIndex: 0,
				oraclePrice: '1000000',
				marketDepositBalance: '81870194335389750',
				marketWithdrawBalance: '46034850271270944',
				marketCumulativeDepositInterest: '10958506455',
				marketCumulativeBorrowInterest: '12082799497',
				totalDepositsAfter: '1352258374508',
				totalWithdrawsAfter: '1476737870212',
				explanation: 'none',
				transferUser: null,
				txSig: '4a22msmwUmLPEeF25e3Q3L7QSPF7mvPwASejRJpv2U8kaS59tPPiomtEzGe4a3xxzf8voFVAsw9qpgrznQQQnnWC',
				slot: 294325566,
				eventType: 'DepositRecord',
				txSigIndex: 42,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				user: {
					user1: [
						{
							amount: 64999,
							oraclePrice: 1,
							marketDepositBalance: 81870194.33538975,
							marketWithdrawBalance: 46034850.271270946,
							marketCumulativeDepositInterest: 1.0958506455,
							marketCumulativeBorrowInterest: 1.2082799497,
							totalDepositsAfter: 1352258.374508,
							totalWithdrawsAfter: 1476737.870212,
							txSig: '4a22msmwUmLPEeF25e3Q3L7QSPF7mvPwASejRJpv2U8kaS59tPPiomtEzGe4a3xxzf8voFVAsw9qpgrznQQQnnWC',
							slot: 294325566,
							ts: 1728344873,
							depositRecordId: '10490877',
							userAuthority: 'authority',
							user: 'user1',
							direction: 'deposit',
							marketIndex: 0,
							txSigIndex: 42,
							explanation: 'none',
							symbol: 'USDC',
							entity: 'user',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				authority: {},
				market: {
					USDC: [
						{
							amount: 64999,
							oraclePrice: 1,
							marketDepositBalance: 81870194.33538975,
							marketWithdrawBalance: 46034850.271270946,
							marketCumulativeDepositInterest: 1.0958506455,
							marketCumulativeBorrowInterest: 1.2082799497,
							totalDepositsAfter: 1352258.374508,
							totalWithdrawsAfter: 1476737.870212,
							txSig: '4a22msmwUmLPEeF25e3Q3L7QSPF7mvPwASejRJpv2U8kaS59tPPiomtEzGe4a3xxzf8voFVAsw9qpgrznQQQnnWC',
							slot: 294325566,
							ts: 1728344873,
							symbol: 'USDC',
							depositRecordId: '10490877',
							userAuthority: 'authority',
							user: 'user1',
							direction: 'deposit',
							marketIndex: 0,
							txSigIndex: 42,
							explanation: 'none',
							entity: 'market',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
			});
		});

		it('should correctly parse Reward data', () => {
			const mockData = {
				ts: '1728344873',
				userAuthority: 'authority',
				user: 'user1',
				direction: 'deposit',
				depositRecordId: '10490877',
				amount: '64999000000',
				marketIndex: 0,
				oraclePrice: '1000000',
				marketDepositBalance: '81870194335389750',
				marketWithdrawBalance: '46034850271270944',
				marketCumulativeDepositInterest: '10958506455',
				marketCumulativeBorrowInterest: '12082799497',
				totalDepositsAfter: '1352258374508',
				totalWithdrawsAfter: '1476737870212',
				explanation: 'reward',
				transferUser: null,
				txSig: '4a22msmwUmLPEeF25e3Q3L7QSPF7mvPwASejRJpv2U8kaS59tPPiomtEzGe4a3xxzf8voFVAsw9qpgrznQQQnnWC',
				slot: 294325566,
				eventType: 'RewardRecord',
				txSigIndex: 42,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				user: {
					user1: [
						{
							amount: 64999,
							oraclePrice: 1,
							marketDepositBalance: 81870194.33538975,
							marketWithdrawBalance: 46034850.271270946,
							marketCumulativeDepositInterest: 1.0958506455,
							marketCumulativeBorrowInterest: 1.2082799497,
							totalDepositsAfter: 1352258.374508,
							totalWithdrawsAfter: 1476737.870212,
							txSig: '4a22msmwUmLPEeF25e3Q3L7QSPF7mvPwASejRJpv2U8kaS59tPPiomtEzGe4a3xxzf8voFVAsw9qpgrznQQQnnWC',
							slot: 294325566,
							ts: 1728344873,
							depositRecordId: '10490877',
							userAuthority: 'authority',
							user: 'user1',
							direction: 'deposit',
							marketIndex: 0,
							txSigIndex: 42,
							explanation: 'reward',
							symbol: 'USDC',
							entity: 'user',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				authority: {},
				market: {
					USDC: [
						{
							amount: 64999,
							oraclePrice: 1,
							marketDepositBalance: 81870194.33538975,
							marketWithdrawBalance: 46034850.271270946,
							marketCumulativeDepositInterest: 1.0958506455,
							marketCumulativeBorrowInterest: 1.2082799497,
							totalDepositsAfter: 1352258.374508,
							totalWithdrawsAfter: 1476737.870212,
							txSig: '4a22msmwUmLPEeF25e3Q3L7QSPF7mvPwASejRJpv2U8kaS59tPPiomtEzGe4a3xxzf8voFVAsw9qpgrznQQQnnWC',
							slot: 294325566,
							ts: 1728344873,
							symbol: 'USDC',
							depositRecordId: '10490877',
							userAuthority: 'authority',
							user: 'user1',
							direction: 'deposit',
							marketIndex: 0,
							txSigIndex: 42,
							explanation: 'reward',
							entity: 'market',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
			});
		});

		it('should correctly parse LiquidationRecord data', () => {
			const mockData = {
				ts: '1728356651',
				liquidationType: 'liquidateSpot',
				user: 'user1',
				liquidator: '42vtDSVn9AFFaMhXbtxZL5GoK8SQDyR9QmLUub4hb9yQ',
				marginRequirement: '36389398',
				totalCollateral: '36389397',
				marginFreed: '363894',
				liquidationId: 2,
				bankrupt: false,
				canceledOrderIds: [],
				liquidatePerp: {
					marketIndex: 0,
					oraclePrice: '0',
					baseAssetAmount: '0',
					quoteAssetAmount: '0',
					lpShares: '0',
					fillRecordId: '0',
					userOrderId: 0,
					liquidatorOrderId: 0,
					liquidatorFee: '0',
					ifFee: '0',
				},
				liquidateSpot: {
					assetMarketIndex: 5,
					assetPrice: '1000000',
					assetTransfer: '7285128',
					liabilityMarketIndex: 0,
					liabilityPrice: '1000000',
					liabilityTransfer: '7248884',
					ifFee: '36244',
				},
				liquidateBorrowForPerpPnl: {
					perpMarketIndex: 0,
					marketOraclePrice: '0',
					pnlTransfer: '0',
					liabilityMarketIndex: 0,
					liabilityPrice: '0',
					liabilityTransfer: '0',
				},
				liquidatePerpPnlForDeposit: {
					perpMarketIndex: 0,
					marketOraclePrice: '0',
					pnlTransfer: '0',
					assetMarketIndex: 0,
					assetPrice: '0',
					assetTransfer: '10000000',
				},
				perpBankruptcy: {
					marketIndex: 0,
					pnl: '0',
					ifPayment: '0',
					clawbackUser: null,
					clawbackUserPayment: null,
					cumulativeFundingRateDelta: '0',
				},
				spotBankruptcy: {
					marketIndex: 0,
					borrowAmount: '0',
					ifPayment: '0',
					cumulativeDepositInterestDelta: '0',
				},
				txSig: 'F1RrTJrz3ehxVZcKYjHoHYCeHemC55L48MhALtfUMMhXPC2t4quedUhKaGaViGRTdMb8QW73b6zDZwHPcDzhJaM',
				slot: 294351360,
				eventType: 'LiquidationRecord',
				txSigIndex: 2,
				bitFlags: 1,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				user: {
					user1: [
						{
							bankrupt: false,
							canceledOrderIds: [],
							liquidateBorrowForPerpPnl_liabilityMarketIndex: 0,
							liquidateBorrowForPerpPnl_liabilityPrice: 0,
							liquidateBorrowForPerpPnl_liabilityTransfer: 0,
							liquidateBorrowForPerpPnl_marketOraclePrice: 0,
							liquidateBorrowForPerpPnl_perpMarketIndex: 0,
							liquidateBorrowForPerpPnl_pnlTransfer: 0,
							liquidatePerpPnlForDeposit_assetMarketIndex: 0,
							liquidatePerpPnlForDeposit_assetPrice: 0,
							liquidatePerpPnlForDeposit_assetTransfer: 10,
							liquidatePerpPnlForDeposit_marketOraclePrice: 0,
							liquidatePerpPnlForDeposit_perpMarketIndex: 0,
							liquidatePerpPnlForDeposit_pnlTransfer: 0,
							liquidatePerp_baseAssetAmount: 0,
							liquidatePerp_fillRecordId: '0',
							liquidatePerp_ifFee: 0,
							liquidatePerp_liquidatorFee: 0,
							liquidatePerp_liquidatorOrderId: 0,
							liquidatePerp_lpShares: 0,
							liquidatePerp_marketIndex: 0,
							liquidatePerp_oraclePrice: 0,
							liquidatePerp_quoteAssetAmount: 0,
							liquidatePerp_userOrderId: 0,
							liquidateSpot_assetMarketIndex: 5,
							liquidateSpot_assetPrice: 1,
							liquidateSpot_assetTransfer: 7.285128,
							liquidateSpot_ifFee: 0.036244,
							liquidateSpot_liabilityMarketIndex: 0,
							liquidateSpot_liabilityPrice: 1,
							liquidateSpot_liabilityTransfer: 7.248884,
							liquidationId: 2,
							liquidationType: 'liquidateSpot',
							liquidator: '42vtDSVn9AFFaMhXbtxZL5GoK8SQDyR9QmLUub4hb9yQ',
							marginFreed: 0.363894,
							marginRequirement: 36.389398,
							perpBankruptcy_clawbackUser: null,
							perpBankruptcy_clawbackUserPayment: 0,
							perpBankruptcy_cumulativeFundingRateDelta: 0,
							perpBankruptcy_ifPayment: 0,
							perpBankruptcy_marketIndex: 0,
							perpBankruptcy_pnl: 0,
							slot: 294351360,
							spotBankruptcy_borrowAmount: 0,
							spotBankruptcy_cumulativeDepositInterestDelta: 0,
							spotBankruptcy_ifPayment: 0,
							spotBankruptcy_marketIndex: 0,
							totalCollateral: 36.389397,
							ts: 1728356651,
							txSigIndex: 2,
							txSig: 'F1RrTJrz3ehxVZcKYjHoHYCeHemC55L48MhALtfUMMhXPC2t4quedUhKaGaViGRTdMb8QW73b6zDZwHPcDzhJaM',
							user: 'user1',
							bitFlags: 1,
							entity: 'user',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				authority: {},
				market: {},
			});
		});

		it('should correctly parse LPRecord data', () => {
			const mockData = {
				ts: '1728281765',
				user: 'user1',
				action: 'settleLiquidity',
				nShares: '0',
				marketIndex: 2,
				deltaBaseAssetAmount: '8000000',
				deltaQuoteAssetAmount: '-19994910',
				pnl: '0',
				txSig: '5rCZeWJ8vufG2fNXAvuT4Ayvp6krm4yPG9zN7y3g3P72PC9chZsVGKTPPT2ZDH52WsaDaUMTLf7y2sy511rMQyHB',
				slot: 294185880,
				eventType: 'LPRecord',
				txSigIndex: 31,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				user: {
					user1: [
						{
							ts: 1728281765,
							user: 'user1',
							action: 'settleLiquidity',
							nShares: 0,
							marketIndex: 2,
							deltaBaseAssetAmount: 0.008,
							deltaQuoteAssetAmount: -19.99491,
							pnl: 0,
							txSig: '5rCZeWJ8vufG2fNXAvuT4Ayvp6krm4yPG9zN7y3g3P72PC9chZsVGKTPPT2ZDH52WsaDaUMTLf7y2sy511rMQyHB',
							txSigIndex: 31,
							slot: 294185880,
							entity: 'user',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				authority: {},
				market: {},
			});
		});

		it('should correctly parse LPMintRedeemRecord data', () => {
			const mockData = {
				ts: '1762893737',
				slot: 379450944,
				authority: 'FvFjDU271T4qnqrKYchpaS7Hphtpzkii2Sbfq7tjJFT5',
				description: 1,
				amount: '100000000',
				fee: '89800',
				spotMarketIndex: 1,
				constituentIndex: 1,
				oraclePrice: '156510305',
				mint: 'So11111111111111111111111111111111111111112',
				lpAmount: '17193572',
				lpFee: '5158',
				lpPrice: '909466',
				mintRedeemId: '6',
				lastAum: '32641738077',
				lastAumSlot: '379450944',
				inMarketCurrentWeight: '28342',
				inMarketTargetWeight: '-239854',
				lpPool: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa',
				txSig: 'dq1jUnV1fKdnnrM9n4nuXDD6TUirs5FMdsDsH2c6FdmXTBdEugEmmnuxAFf9GGz5zdimPYDNhEu2vtMMhqBCmC6',
				eventType: 'LPMintRedeemRecord',
				txSigIndex: 1,
				source: 'seq',
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				authority: {
					FvFjDU271T4qnqrKYchpaS7Hphtpzkii2Sbfq7tjJFT5: [
						{
							ts: 1762893737,
							slot: 379450944,
							authority: 'FvFjDU271T4qnqrKYchpaS7Hphtpzkii2Sbfq7tjJFT5',
							description: 1,
							amount: 0.1,
							spotMarketIndex: 1,
							constituentIndex: 1,
							oraclePrice: 156.510305,
							mint: 'So11111111111111111111111111111111111111112',
							lpAmount: 17.193572,
							lpFee: 0.005158,
							lpPrice: 0.909466,
							mintRedeemId: '6',
							lastAumSlot: 379450944,
							fee: 0.0898,
							inMarketCurrentWeight: 0.028342,
							inMarketTargetWeight: -0.239854,
							lastAum: 32641.738077,
							lpPool: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa',
							txSig: 'dq1jUnV1fKdnnrM9n4nuXDD6TUirs5FMdsDsH2c6FdmXTBdEugEmmnuxAFf9GGz5zdimPYDNhEu2vtMMhqBCmC6',
							txSigIndex: 1,
							entity: 'authority',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				market: {},
				user: {},
			});
		});

		it('should correctly parse FundingPaymentRecord data', () => {
			const mockData = {
				ts: '1728281569',
				userAuthority: 'authority1',
				user: 'user1',
				marketIndex: 0,
				fundingPayment: '-515759',
				baseAssetAmount: '136300000000',
				userLastCumulativeFunding: '40962372483',
				ammCumulativeFundingLong: '40966156483',
				ammCumulativeFundingShort: '40759956808',
				txSig: '5D6BrnxBvU88zeiHDMtj7G5KtBdv1yDgTuKKGTuSDb7THT4YWRJyT3Uh9UYFPkG8VRZr9KLia3uUhGeNwj3mCtWB',
				slot: 294185418,
				eventType: 'FundingPaymentRecord',
				txSigIndex: 58,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				user: {
					user1: [
						{
							ts: 1728281569,
							userAuthority: 'authority1',
							user: 'user1',
							marketIndex: 0,
							fundingPayment: -0.515759,
							baseAssetAmount: 136.3,
							userLastCumulativeFunding: 40.962372483,
							ammCumulativeFundingLong: 40.966156483,
							ammCumulativeFundingShort: 40.759956808,
							txSig: '5D6BrnxBvU88zeiHDMtj7G5KtBdv1yDgTuKKGTuSDb7THT4YWRJyT3Uh9UYFPkG8VRZr9KLia3uUhGeNwj3mCtWB',
							txSigIndex: 58,
							slot: 294185418,
							entity: 'user',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				authority: {},
				market: {},
			});
		});

		it('should correctly parse InsuranceFundStakeRecord data', () => {
			const mockData = {
				ts: '1728345983',
				userAuthority: 'authority1',
				action: 'unstake',
				amount: '4557458',
				marketIndex: 15,
				insuranceVaultAmountBefore: '12470920379293',
				ifSharesBefore: '4556671',
				userIfSharesBefore: '12468193500487',
				totalIfSharesBefore: '12468740107867',
				ifSharesAfter: '1',
				userIfSharesAfter: '12468188943817',
				totalIfSharesAfter: '12468735551197',
				txSig: 'jMzmfXZxigMo4PHsHtvAJZJ64XjH5BpaviHBFDWfoB3vJWa3RURX2DpEv4VLXaBTXLqLaSvbjvNMdYstpTRxWnh',
				slot: 294327966,
				eventType: 'InsuranceFundStakeRecord',
				txSigIndex: 0,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				authority: {
					authority1: [
						{
							amount: 4.5574580000000005,
							userAuthority: 'authority1',
							action: 'unstake',
							txSigIndex: 0,
							ts: 1728345983,
							txSig: 'jMzmfXZxigMo4PHsHtvAJZJ64XjH5BpaviHBFDWfoB3vJWa3RURX2DpEv4VLXaBTXLqLaSvbjvNMdYstpTRxWnh',
							slot: 294327966,
							marketIndex: 15,
							ifSharesBefore: 4.556671,
							userIfSharesBefore: 12468193.500487,
							totalIfSharesBefore: 12468740.107867,
							ifSharesAfter: 0.000001,
							userIfSharesAfter: 12468188.943817,
							totalIfSharesAfter: 12468735.551197,
							insuranceVaultAmountBefore: 12470920.379293,
							entity: 'authority',
							symbol: 'DRIFT',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				market: {
					DRIFT: [
						{
							amount: 4.5574580000000005,
							userAuthority: 'authority1',
							action: 'unstake',
							txSigIndex: 0,
							ts: 1728345983,
							txSig: 'jMzmfXZxigMo4PHsHtvAJZJ64XjH5BpaviHBFDWfoB3vJWa3RURX2DpEv4VLXaBTXLqLaSvbjvNMdYstpTRxWnh',
							slot: 294327966,
							marketIndex: 15,
							ifSharesBefore: 4.556671,
							userIfSharesBefore: 12468193.500487,
							totalIfSharesBefore: 12468740.107867,
							ifSharesAfter: 0.000001,
							userIfSharesAfter: 12468188.943817,
							totalIfSharesAfter: 12468735.551197,
							insuranceVaultAmountBefore: 12470920.379293,
							entity: 'market',
							symbol: 'DRIFT',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				user: {},
			});
		});

		it('should correctly parse InsuranceFundRecord data', () => {
			const mockData = {
				ts: '1728345944',
				spotMarketIndex: 16,
				perpMarketIndex: 0,
				userIfFactor: 50000,
				totalIfFactor: 100000,
				vaultAmountBefore: '57517205520741',
				insuranceVaultAmountBefore: '73059170',
				totalIfSharesBefore: '71818696',
				totalIfSharesAfter: '71818696',
				amount: '6913',
				txSig: '3pSRxUcDtkFyuErKNsyDZrCAXc6jQy6wUDFxemEMKMcAriE1CjrkJ6MCNyfMuqayfGPQyhmuyyJqzLEcbxNAsRwm',
				slot: 294327890,
				eventType: 'InsuranceFundRecord',
				txSigIndex: 1,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				authority: {},
				market: {
					INF: [
						{
							amount: 0.000006913,
							insuranceVaultAmountBefore: 0.07305917,
							perpMarketIndex: 0,
							slot: 294327890,
							spotMarketIndex: 16,
							symbol: 'INF',
							totalIfFactor: 100000,
							totalIfSharesAfter: 71.818696,
							totalIfSharesBefore: 71.818696,
							ts: 1728345944,
							txSigIndex: 1,
							source: IngestionSource.SEQUENTIAL,
							txSig: '3pSRxUcDtkFyuErKNsyDZrCAXc6jQy6wUDFxemEMKMcAriE1CjrkJ6MCNyfMuqayfGPQyhmuyyJqzLEcbxNAsRwm',
							userIfFactor: 50000,
							vaultAmountBefore: 57517.205520741,
							entity: 'market',
						},
					],
				},
				user: {},
			});
		});

		it('should correctly parse FundingRateRecord data', () => {
			const mockData = {
				ts: '1728345604',
				recordId: '7100',
				marketIndex: 19,
				fundingRate: '38250',
				fundingRateLong: '38250',
				fundingRateShort: '38250',
				cumulativeFundingRateLong: '4358499886',
				cumulativeFundingRateShort: '4358499886',
				oraclePriceTwap: '5409222',
				markPriceTwap: '5409059',
				periodRevenue: '-35442006',
				baseAssetAmountWithAmm: '-825826209521',
				baseAssetAmountWithUnsettledLp: '-17673790479',
				txSig: '2eJoJDuYNNRZqAWBse4NZYB446YiCwq2QaGhJEfE6G7eYmuwbgP6SjtPTvPT9HdA3JWrqQ7FQzPCfqzJsDCgRSG7',
				slot: 294327144,
				eventType: 'FundingRateRecord',
				txSigIndex: 27,
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				authority: {},
				market: {
					'TIA-PERP': [
						{
							baseAssetAmountWithAmm: -825.826209521,
							baseAssetAmountWithUnsettledLp: -17.673790479,
							cumulativeFundingRateLong: 4.358499886,
							cumulativeFundingRateShort: 4.358499886,
							fundingRate: 0.00003825,
							fundingRateLong: 0.00003825,
							fundingRateShort: 0.00003825,
							markPriceTwap: 5.409059,
							marketIndex: 19,
							oraclePriceTwap: 5.409222,
							periodRevenue: -35.442006,
							recordId: '7100',
							slot: 294327144,
							symbol: 'TIA-PERP',
							ts: 1728345604,
							txSigIndex: 27,
							txSig: '2eJoJDuYNNRZqAWBse4NZYB446YiCwq2QaGhJEfE6G7eYmuwbgP6SjtPTvPT9HdA3JWrqQ7FQzPCfqzJsDCgRSG7',
							entity: 'market',
							source: IngestionSource.SEQUENTIAL,
						},
					],
				},
				user: {},
			});
		});

		it('should correctly parse VaultDepositorRecord data', () => {
			const mockData = {
				ts: '1742355629',
				vault: 'FbaXoNjvii97vwqM6m6rgdEarekTJ3ZAdsc1JH5Ym9Gb',
				depositorAuthority: '4y31jWFrDnYBxDvQv5VQEmP2SmRQ7mJGNWRbyFhkgEHU',
				action: 'deposit',
				amount: '1000000',
				spotMarketIndex: 0,
				vaultSharesBefore: '902929',
				vaultSharesAfter: '1805570',
				vaultEquityBefore: '28440745504110',
				userVaultSharesBefore: '25673114024383',
				totalVaultSharesBefore: '25673143352228',
				userVaultSharesAfter: '25673114927024',
				totalVaultSharesAfter: '25673144254916',
				profitShare: '53',
				managementFee: '0',
				managementFeeShares: '0',
				depositOraclePrice: '1000000',
				txSig: '5hLNyXTtWonTdnkNDcq69Xsuig2o6GoqbGmEMvtLnUUYtDCmRbXvB1LKUN5heo6trhG37M42nejUYixr9TxQvDSG',
				slot: 327705637,
				eventType: 'VaultDepositorRecord',
				txSigIndex: 0,
				source: 'grpc',
			};

			const result = sortRecords({ records: [mockData] });

			expect(result).toEqual({
				user: {},
				market: {},
				authority: {
					'4y31jWFrDnYBxDvQv5VQEmP2SmRQ7mJGNWRbyFhkgEHU': [
						{
							ts: 1742355629,
							vault: 'FbaXoNjvii97vwqM6m6rgdEarekTJ3ZAdsc1JH5Ym9Gb',
							depositorAuthority: '4y31jWFrDnYBxDvQv5VQEmP2SmRQ7mJGNWRbyFhkgEHU',
							action: 'deposit',
							spotMarketIndex: 0,
							amount: 1,
							vaultSharesBefore: 902929,
							vaultSharesAfter: 1805570,
							vaultEquityBefore: 28440745.50411,
							userVaultSharesBefore: 25673114024383,
							totalVaultSharesBefore: 25673143352228,
							userVaultSharesAfter: 25673114927024,
							totalVaultSharesAfter: 25673144254916,
							profitShare: 0.000053,
							managementFee: 0,
							managementFeeShares: 0,
							depositOraclePrice: 1,
							txSig: '5hLNyXTtWonTdnkNDcq69Xsuig2o6GoqbGmEMvtLnUUYtDCmRbXvB1LKUN5heo6trhG37M42nejUYixr9TxQvDSG',
							slot: 327705637,
							txSigIndex: 0,
							entity: 'authority',
							source: 'grpc',
						},
					],
				},
			});
		});
	});

	it('should correctly parse InsuranceFundSwapRecord data', () => {
		const mockData = {
			ts: '1728345944',
			txSig: '3pSRxUcDtkFyuErKNsyDZrCAXc6jQy6wUDFxemEMKMcAriE1CjrkJ6MCNyfMuqayfGPQyhmuyyJqzLEcbxNAsRwm',
			txSigIndex: 1,
			slot: 294327890,
			rebalanceConfig: '1',
			source: IngestionSource.SEQUENTIAL,
			inAmount: '1000000',
			outAmount: '1000000',
			inIfTotalSharesBefore: '1000000',
			inIfUserSharesBefore: '1000000',
			inIfTotalSharesAfter: '1000000',
			inIfUserSharesAfter: '1000000',
			inOraclePrice: '1000000',
			outOraclePrice: '1000000',
			inOraclePriceTwap: '1000000',
			outOraclePriceTwap: '1000000',
			entity: EntityTypes.Market,
			inFundVaultAmountAfter: '1000000',
			outFundVaultAmountAfter: '1000000',
			eventType: 'InsuranceFundSwapRecord',
			inMarketIndex: 0,
			outMarketIndex: 15,
		};

		const result = sortRecords({ records: [mockData] });

		expect(result).toEqual({
			user: {},
			market: {
				DRIFT: [
					{
						entity: 'market',
						inAmount: 1,
						inFundVaultAmountAfter: 1,
						inIfTotalSharesAfter: 1,
						inIfTotalSharesBefore: 1,
						inIfUserSharesAfter: 1,
						inIfUserSharesBefore: 1,
						inMarketIndex: 0,
						inSymbol: 'USDC',
						inVaultAmountBefore: 0,
						isInMarket: false,
						outAmount: 1,
						outFundVaultAmountAfter: 1,
						outIfTotalSharesAfter: 0,
						outIfTotalSharesBefore: 0,
						outIfUserSharesAfter: 0,
						outIfUserSharesBefore: 0,
						outMarketIndex: 15,
						outOraclePrice: 1,
						outOraclePriceTwap: 1,
						outSymbol: 'DRIFT',
						outVaultAmountBefore: 0,
						rebalanceConfig: '1',
						slot: 294327890,
						source: 'seq',
						ts: 1728345944,
						txSig: '3pSRxUcDtkFyuErKNsyDZrCAXc6jQy6wUDFxemEMKMcAriE1CjrkJ6MCNyfMuqayfGPQyhmuyyJqzLEcbxNAsRwm',
						txSigIndex: 1,
					},
				],
			},
			authority: {},
		});
	});

	describe('getRecords', () => {
		it('should parse JSON lines into an array of objects', () => {
			const content = '{"id": 1, "name": "John"}\n{"id": 2, "name": "Jane"}';

			const result = getRecords({ content });

			expect(result).toEqual([
				{ id: 1, name: 'John' },
				{ id: 2, name: 'Jane' },
			]);
		});

		it('should handle empty lines', () => {
			const content = '{"id": 1, "name": "John"}\n\n{"id": 2, "name": "Jane"}';

			const result = getRecords({ content });

			expect(result).toEqual([
				{ id: 1, name: 'John' },
				{ id: 2, name: 'Jane' },
			]);
		});

		it('should throw an error for invalid JSON', () => {
			const content = '{"id": 1, "name": "John"}\ninvalid json\n{"id": 2, "name": "Jane"}';

			expect(() => getRecords({ content })).toThrow(SyntaxError);
		});
	});

	describe('getRecordPathName', () => {
		it('should return correct path for user type', () => {
			const result = getRecordPathName({
				id: 'user123',
				eventType: RecordTypes.TradeRecord,
				year: 2023,
				month: 5,
			});
			expect(result).toBe('users/user=user123/eventType=TradeRecord/year=2023/month=5');
		});

		it('should return correct path for market type', () => {
			const result = getRecordPathName({
				id: 'market456',
				eventType: RecordTypes.LiquidationRecord,
				year: 2023,
				month: 6,
				day: 15,
				entity: EntityTypes.Market,
			});
			expect(result).toBe(
				'markets/market=market456/eventType=LiquidationRecord/year=2023/month=6/day=15'
			);
		});

		it('should return correct path for authority type', () => {
			const result = getRecordPathName({
				id: 'auth789',
				eventType: RecordTypes.DepositRecord,
				year: 2023,
				month: 7,
				entity: EntityTypes.Authority,
			});
			expect(result).toBe(
				'authority/authority=auth789/eventType=DepositRecord/year=2023/month=7'
			);
		});
	});

	describe('getRecordFileName', () => {
		it('should return correct filename', () => {
			const result = getRecordFileName({ page: 1 });
			expect(result).toBe('1.json.gz');
		});
	});

	describe('destructureKey', () => {
		it('should correctly parse user key', () => {
			const key = 'users/user=user123/eventType=TradeRecord/year=2023/month=05';
			const result = destructureKey(key);
			expect(result).toEqual({
				user: 'user123',
				eventType: RecordTypes.TradeRecord,
				year: 2023,
				month: 5,
				day: undefined,
			});
		});

		it('should correctly parse market key', () => {
			const key =
				'markets/market=market456/eventType=LiquidationRecord/year=2023/month=06/day=15';
			const result = destructureKey(key);
			expect(result).toEqual({
				market: 'market456',
				eventType: RecordTypes.LiquidationRecord,
				year: 2023,
				month: 6,
				day: 15,
			});
		});

		it('should correctly parse authority key', () => {
			const key =
				'authority/userAuthority=auth789/eventType=DepositRecord/year=2023/month=07';
			const result = destructureKey(key);
			expect(result).toEqual({
				userAuthority: 'auth789',
				eventType: RecordTypes.DepositRecord,
				year: 2023,
				month: 7,
				day: undefined,
			});
		});

		it('should handle keys without day', () => {
			const key = 'users/user=user123/eventType=TradeRecord/year=2023/month=05';
			const result = destructureKey(key);
			expect(result.day).toBeUndefined();
		});

		it('should handle unknown identifier types', () => {
			const key = 'unknown=value123/eventType=TradeRecord/year=2023/month=05';
			const result = destructureKey(key);
			expect(result.id).toBe(undefined);
		});
	});
});
