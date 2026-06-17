import { RiskBucket } from '@backend/common';
import { RiskRepository } from '../../src/repositories/risk';

const mockGet = jest.fn();
const mockSet = jest.fn();
const mockMSet = jest.fn();
const mockZAdd = jest.fn();
const mockZRem = jest.fn();
const mockZRange = jest.fn();
const mockZRangeByScore = jest.fn();

jest.mock('../../src/client', () => ({
	Redis: () => ({
		get: mockGet,
		set: mockSet,
		mSet: mockMSet,
		zAdd: mockZAdd,
		zRem: mockZRem,
		zRangeWithScores: mockZRange,
		zRangeByScore: mockZRangeByScore,
	}),
}));

describe('RiskRepository', () => {
	let repository: ReturnType<typeof RiskRepository>;

	beforeEach(() => {
		jest.clearAllMocks();
		repository = RiskRepository();
	});

	describe('key generation', () => {
		it('should generate correct account risk key', () => {
			const key = repository.generateAccountRiskKey('user123');
			expect(key).toBe('{account}:user123:risk');
		});

		it('should generate correct risk bucket key', () => {
			const key = repository.generateRiskBucketKey(RiskBucket.AT_RISK);
			expect(key).toBe('risk:AT_RISK:accounts');
		});
	});

	describe('getAccountRisk', () => {
		it('should return parsed data when account exists', async () => {
			const mockData = {
				healthRatio: '1.5',
				riskBucket: RiskBucket.HEALTHY,
				lastUpdated: '1234567890',
			};
			mockGet.mockResolvedValue(JSON.stringify(mockData));

			const result = await repository.getAccountRisk('user123');
			expect(result).toEqual(mockData);
			expect(mockGet).toHaveBeenCalledWith('{account}:user123:risk');
		});

		it('should return null when account does not exist', async () => {
			mockGet.mockResolvedValue(null);

			const result = await repository.getAccountRisk('user123');
			expect(result).toBeNull();
		});
	});

	describe('updateAccountRisk', () => {
		const mockUpdate = {
			user: 'user123',
			healthRatio: 1.5,
			riskBucket: RiskBucket.HEALTHY,
			lastUpdated: 1234567890,
		};

		it('should update account risk and bucket membership', async () => {
			await repository.updateAccountRisk(mockUpdate.user, RiskBucket.MODERATE, {
				healthRatio: mockUpdate.healthRatio,
				riskBucket: mockUpdate.riskBucket,
				lastUpdated: mockUpdate.lastUpdated,
			});

			expect(mockSet).toHaveBeenCalledWith(
				'{account}:user123:risk',
				JSON.stringify({
					healthRatio: '1.5',
					riskBucket: RiskBucket.HEALTHY,
					lastUpdated: '1234567890',
				})
			);

			expect(mockZAdd).toHaveBeenCalledWith('risk:HEALTHY:accounts', [
				{
					score: 1.5,
					value: 'user123',
				},
			]);

			expect(mockZRem).toHaveBeenCalledTimes(1);
		});
	});

	describe('batchUpdateAccountRisk', () => {
		const mockUpdates = [
			{
				user: 'user1',
				healthRatio: 1.5,
				riskBucket: RiskBucket.HEALTHY,
				lastUpdated: 1234567890,
			},
			{
				user: 'user2',
				healthRatio: 1.1,
				riskBucket: RiskBucket.AT_RISK,
				lastUpdated: 1234567890,
			},
			{
				user: 'user3',
				healthRatio: 1.5,
				riskBucket: RiskBucket.HEALTHY,
				lastUpdated: 1234567890,
			},
		];

		it('should batch update multiple accounts', async () => {
			await repository.batchUpdateAccountRisk(mockUpdates);

			expect(mockMSet).toHaveBeenCalledWith({
				'{account}:user1:risk': JSON.stringify({
					healthRatio: '1.5',
					riskBucket: RiskBucket.HEALTHY,
					lastUpdated: '1234567890',
				}),
				'{account}:user2:risk': JSON.stringify({
					healthRatio: '1.1',
					riskBucket: RiskBucket.AT_RISK,
					lastUpdated: '1234567890',
				}),
				'{account}:user3:risk': JSON.stringify({
					healthRatio: '1.5',
					riskBucket: RiskBucket.HEALTHY,
					lastUpdated: '1234567890',
				}),
			});

			expect(mockZAdd).toHaveBeenCalledTimes(2);
			expect(mockZAdd).toHaveBeenCalledWith('risk:HEALTHY:accounts', [
				{ score: 1.5, value: 'user1' },
				{ score: 1.5, value: 'user3' },
			]);
			expect(mockZAdd).toHaveBeenCalledWith('risk:AT_RISK:accounts', [
				{ score: 1.1, value: 'user2' },
			]);

			expect(mockZRem).toHaveBeenCalledTimes(8);
			expect(mockZRem).toHaveBeenCalledWith('risk:MODERATE:accounts', 'user1', 'user3');
			expect(mockZRem).toHaveBeenCalledWith('risk:LIQUIDATABLE:accounts', 'user1', 'user3');
			expect(mockZRem).toHaveBeenCalledWith('risk:AT_RISK:accounts', 'user1', 'user3');
			expect(mockZRem).toHaveBeenCalledWith('risk:CRITICAL:accounts', 'user1', 'user3');
		});
	});

	describe('getUsersByRiskBucket', () => {
		it('should return users in a risk bucket', async () => {
			mockZRange.mockResolvedValue(['user1', 'user2']);

			const result = await repository.getUsersByRiskBucket(RiskBucket.AT_RISK);
			expect(result).toEqual(['user1', 'user2']);
			expect(mockZRange).toHaveBeenCalledWith('risk:AT_RISK:accounts', 0, -1);
		});
	});

	describe('getUsersInRiskRange', () => {
		it('should return users within a health ratio range', async () => {
			mockZRangeByScore.mockResolvedValue(['user1', 'user2']);

			const result = await repository.getUsersInRiskRange(RiskBucket.AT_RISK, 1.1, 1.2);
			expect(result).toEqual(['user1', 'user2']);
			expect(mockZRangeByScore).toHaveBeenCalledWith('risk:AT_RISK:accounts', 1.1, 1.2);
		});
	});

	describe('error handling', () => {
		it('should handle Redis operation failures', async () => {
			mockSet.mockRejectedValue(new Error('Redis error'));

			await expect(
				repository.updateAccountRisk('user1', RiskBucket.MODERATE, {
					healthRatio: 1.5,
					riskBucket: RiskBucket.HEALTHY,
					lastUpdated: 1234567890,
				})
			).rejects.toThrow('Redis error');
		});

		it('should handle invalid JSON in getAccountRisk', async () => {
			mockGet.mockResolvedValue('invalid-json');

			await expect(repository.getAccountRisk('user1')).rejects.toThrow(SyntaxError);
		});
	});
});
