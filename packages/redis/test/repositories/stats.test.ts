import { LiquidationStats, RateHistoryType, Rates, Vault } from '@backend/common';
import { Redis } from '../../src/client';
import { StatsCacheRepository } from '../../src/repositories/stats';

jest.mock('../../src/client', () => ({
	Redis: jest.fn(),
}));

describe('StatsCacheRepository', () => {
	const mockLiquidationStats: LiquidationStats = {
		'24h': { amount: '1', count: '42' },
		'30d': { amount: '110', count: '156' },
	};

	const mockBankruptcyStats = {
		totalAmount: '1023',
		ifPayment: '123',
		socialLoss: '13',
		totalCount: '123',
	};

	const mockVaults = [
		{ pubkey: 'vault1', userShares: 201982974, totalShares: 201982974 },
		{ pubkey: 'vault2', userShares: 150000000, totalShares: 300000000 },
	];

	const _mockLpArps = [
		{
			symbol: 'SOL-PERP',
			marketIndex: 0,
			aprs: {
				all: 85.11529751732797,
				'30d': 305.35621356173016,
				'7d': -1.8927889168564724,
				'24h': 2.1541506812608398,
			},
		},
	];

	const mockRedis = {
		get: jest.fn(),
		set: jest.fn(),
	};

	(Redis as jest.Mock).mockReturnValue(mockRedis);

	const {
		setLiquidationStats,
		getLiquidationStats,
		setBankruptcyStats,
		getBankruptcyStats,
		setVaultStats,
		getVaultStats,
		setRateHistory,
		getRateHistory,
	} = StatsCacheRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('setLiquidationStats', () => {
		it('should store liquidation stats in Redis', async () => {
			await setLiquidationStats(mockLiquidationStats);

			expect(mockRedis.set).toHaveBeenCalledWith(
				'liquidation:stats',
				JSON.stringify(mockLiquidationStats)
			);
		});
	});

	describe('getLiquidationStats', () => {
		it('should return null when no stats exist', async () => {
			mockRedis.get.mockResolvedValue(null);

			const result = await getLiquidationStats();
			expect(result).toBeNull();
		});

		it('should return liquidation stats when they exist', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockLiquidationStats));

			const result = await getLiquidationStats();
			expect(result).toEqual(mockLiquidationStats);
		});
	});

	describe('setVaultStats', () => {
		it('should store vault stats in Redis', async () => {
			await setVaultStats(mockVaults as Vault[]);

			expect(mockRedis.set).toHaveBeenCalledWith('vaults:stats', JSON.stringify(mockVaults));
		});
	});

	describe('getVaultStats', () => {
		it('should return null when no vault stats exist', async () => {
			mockRedis.get.mockResolvedValue(null);

			const result = await getVaultStats();
			expect(result).toBeNull();
		});

		it('should return vault stats when they exist', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockVaults));

			const result = await getVaultStats();
			expect(result).toEqual(mockVaults);
		});
	});

	describe('setBankruptcyStats', () => {
		it('should store bankruptcy stats in Redis', async () => {
			await setBankruptcyStats(mockBankruptcyStats);
			expect(mockRedis.set).toHaveBeenCalledWith(
				'bankruptcy:stats',
				JSON.stringify(mockBankruptcyStats)
			);
		});
	});

	describe('getBankruptcyStats', () => {
		it('should return null when no bankruptcy stats exist', async () => {
			mockRedis.get.mockResolvedValue(null);
			const result = await getBankruptcyStats();
			expect(result).toBeNull();
		});

		it('should return bankruptcy stats when they exist', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockBankruptcyStats));
			const result = await getBankruptcyStats();
			expect(result).toEqual(mockBankruptcyStats);
		});
	});

	const mockRates: Rates = [
		[1738637201, '0.065205'],
		[1738647201, '0.062981'],
		[1738657201, '0.064749'],
	];
	const mockSymbol = 'BTC';
	const mockType = RateHistoryType.DEPOSIT;

	describe('setRateHistory', () => {
		it('should store rate history in Redis with correct formatting', async () => {
			await setRateHistory({
				symbol: mockSymbol,
				type: mockType,
				rates: mockRates,
			});

			expect(mockRedis.set).toHaveBeenCalledWith(
				'rateHistory:deposit:BTC',
				JSON.stringify(mockRates)
			);
		});
	});

	describe('getRateHistory', () => {
		it('should return null when no rate history exists', async () => {
			mockRedis.get.mockResolvedValue(null);

			const result = await getRateHistory({
				symbol: mockSymbol,
				type: mockType,
			});

			expect(mockRedis.get).toHaveBeenCalledWith('rateHistory:deposit:BTC');
			expect(result).toBeNull();
		});

		it('should return rate history when it exists', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockRates));

			const result = await getRateHistory({
				symbol: mockSymbol,
				type: mockType,
			});

			expect(mockRedis.get).toHaveBeenCalledWith('rateHistory:deposit:BTC');
			expect(result).toEqual(mockRates);
		});
	});
});
