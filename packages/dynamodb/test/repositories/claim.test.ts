import { ClaimStatus, ClaimType, DevicePlatform } from '@backend/common';
import { ClaimRepository } from '../../src/repositories/claim';
import { getBaseRecordFields, getRecordKeys } from '../../src/utils';

const mockBatchWrite = jest.fn();
const mockGet = jest.fn();
const mockPut = jest.fn();
const mockQuery = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		get: mockGet,
		put: mockPut,
		query: mockQuery,
		update: mockUpdate,
	}),
}));

jest.mock('../../src/utils', () => ({
	...jest.requireActual('../../src/utils'),
	getRecordKeys: jest.fn(),
	getBaseRecordFields: jest.fn(),
}));

describe('ClaimRepository', () => {
	const {
		createEligibleClaims,
		resetClaim,
		getClaim,
		reserveClaim,
		getClaimsByStatus,
		upsertAccrualClaimProgress,
	} = ClaimRepository();

	beforeEach(() => {
		jest.clearAllMocks();
		(getRecordKeys as jest.Mock).mockImplementation((record) => ({
			pk: `AUTHORITY#${record.authorityId}`,
			sk: `CLAIM#${record.campaignId}`,
			GSI1PK: `CLAIM#${record.campaignId}#${record.status}`,
			GSI1SK: `${record.updatedAt ?? 1234567890}#${record.authorityId}`,
		}));
		(getBaseRecordFields as jest.Mock).mockReturnValue({
			createdAt: 1234567890,
		});
	});

	it('creates eligible claim records', async () => {
		await createEligibleClaims([
			{
				campaignId: 'mobile-launch',
				authorityId: 'auth-1',
				amount: 5,
				assetSymbol: 'USDC',
				campaignStartTs: 100,
				campaignEndTs: 200,
			},
		]);

		expect(mockBatchWrite).toHaveBeenCalledWith({
			records: [
				expect.objectContaining({
					pk: 'AUTHORITY#auth-1',
					sk: 'CLAIM#mobile-launch',
					status: ClaimStatus.ELIGIBLE,
					amount: 5,
					assetSymbol: 'USDC',
				}),
			],
		});
	});

	it('gets a claim by authority and campaign', async () => {
		const claim = {
			pk: 'AUTHORITY#auth-1',
			sk: 'CLAIM#mobile-launch',
			authorityId: 'auth-1',
			campaignId: 'mobile-launch',
			status: ClaimStatus.ELIGIBLE,
		};
		mockGet.mockResolvedValue({ Item: claim });

		const result = await getClaim({
			authorityId: 'auth-1',
			campaignId: 'mobile-launch',
		});

		expect(mockGet).toHaveBeenCalledWith({
			pk: 'AUTHORITY#auth-1',
			sk: 'CLAIM#mobile-launch',
		});
		expect(result).toEqual(claim);
	});

	it('reserves an eligible claim', async () => {
		mockUpdate.mockResolvedValue({
			Attributes: { status: ClaimStatus.PROCESSING },
		});

		await reserveClaim({
			authorityId: 'auth-1',
			campaignId: 'mobile-launch',
			deviceId: 'device-1',
			platform: DevicePlatform.IOS,
			targetUserAccount: 'user-1',
		});

		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				pk: 'AUTHORITY#auth-1',
				sk: 'CLAIM#mobile-launch',
				conditionExpression:
					'attribute_exists(pk) AND attribute_exists(sk) AND #status = :expectedStatus',
				expressionValues: expect.objectContaining({
					':processing': ClaimStatus.PROCESSING,
					':claimedByDeviceId': 'device-1',
					':platform': 'ios',
					':targetUserAccount': 'user-1',
				}),
			})
		);
	});

	it('resets a claim back to eligible', async () => {
		mockUpdate.mockResolvedValue({
			Attributes: { status: ClaimStatus.ELIGIBLE },
		});

		await resetClaim({
			authorityId: 'auth-1',
			campaignId: 'mobile-launch',
		});

		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				pk: 'AUTHORITY#auth-1',
				sk: 'CLAIM#mobile-launch',
				conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
				expressionValues: expect.objectContaining({
					':eligible': ClaimStatus.ELIGIBLE,
					':rewardRunnerAttemptCount': 0,
				}),
			})
		);
	});

	it('queries claims by status using GSI1', async () => {
		mockQuery.mockResolvedValue({
			Items: [{ authorityId: 'auth-1' }],
			LastEvaluatedKey: { pk: 'next' },
		});

		const result = await getClaimsByStatus({
			campaignId: 'mobile-launch',
			status: ClaimStatus.PROCESSING,
			limit: 10,
		});

		expect(mockQuery).toHaveBeenCalledWith({
			pk: 'CLAIM#mobile-launch#processing',
			sk: '',
			secondaryIndex: 'GSI1',
			lastEvaluatedKey: undefined,
			limit: 10,
			orderAsc: true,
		});
		expect(result).toEqual({
			records: [{ authorityId: 'auth-1' }],
			meta: { nextPage: { pk: 'next' } },
		});
	});

	it('upserts an accruing claim record', async () => {
		mockGet.mockResolvedValue({});

		const result = await upsertAccrualClaimProgress({
			authorityId: 'auth-1',
			campaignId: 'fees-rebate-v1',
			amount: 10,
			assetSymbol: 'USDC',
			campaignStartTs: 100,
			campaignEndTs: 200,
			progressAmount: 4,
			progressCap: 10,
		});

		expect(mockPut).toHaveBeenCalledWith({
			record: expect.objectContaining({
				authorityId: 'auth-1',
				campaignId: 'fees-rebate-v1',
				claimType: ClaimType.ACCRUAL,
				status: ClaimStatus.ACCRUING,
				progressAmount: 4,
				progressCap: 10,
				claimableAmount: 0,
				claimedAmount: 0,
			}),
		});
		expect(result).toEqual(
			expect.objectContaining({
				status: ClaimStatus.ACCRUING,
				progressAmount: 4,
			})
		);
	});

	it('caps accrual progress and marks the claim eligible once the cap is reached', async () => {
		mockGet.mockResolvedValue({});

		await upsertAccrualClaimProgress({
			authorityId: 'auth-1',
			campaignId: 'fees-rebate-v1',
			amount: 10,
			assetSymbol: 'USDC',
			campaignStartTs: 100,
			campaignEndTs: 200,
			progressAmount: 25,
			progressCap: 10,
		});

		expect(mockPut).toHaveBeenCalledWith({
			record: expect.objectContaining({
				status: ClaimStatus.ELIGIBLE,
				progressAmount: 10,
				progressCap: 10,
				claimableAmount: 10,
			}),
		});
	});

	it('preserves completed accrual claims during sync', async () => {
		mockGet.mockResolvedValue({
			Item: {
				authorityId: 'auth-1',
				campaignId: 'fees-rebate-v1',
				status: ClaimStatus.COMPLETED,
				amount: 10,
				claimedAmount: 10,
				createdAt: 1234567890,
			},
		});

		await upsertAccrualClaimProgress({
			authorityId: 'auth-1',
			campaignId: 'fees-rebate-v1',
			amount: 10,
			assetSymbol: 'USDC',
			campaignStartTs: 100,
			campaignEndTs: 200,
			progressAmount: 10,
			progressCap: 10,
		});

		expect(mockPut).toHaveBeenCalledWith({
			record: expect.objectContaining({
				status: ClaimStatus.COMPLETED,
				claimableAmount: 0,
				claimedAmount: 10,
			}),
		});
	});
});
