import { Keypair, PublicKey } from '@solana/web3.js';
import {
	BASE_PRECISION,
	BN,
	OrderStatus,
	OrderTriggerCondition,
	OrderType,
	PositionDirection,
	PositionFlag,
	QUOTE_PRECISION,
	SpotBalanceType,
	TEN_THOUSAND,
	ZERO,
} from '@velocity-exchange/sdk';
import Fastify, { FastifyInstance } from 'fastify';
import onchainRoutes from '../../src/routes/authority/onchain';
import userOnchainRoutes from '../../src/routes/user/onchain';

const mockGetUserAccountsAndAddressesForAuthority = jest.fn();
const mockEnsureVelocityClientSubscribed = jest.fn();
const mockGetSpotMarketAccounts = jest.fn();
const mockGetUser = jest.fn();
const mockCalculateFeesAndFundingPnl = jest.fn();
const mockFetchRevenueShareEscrow = jest.fn();
const mockFetchRevenueShareAccount = jest.fn();

jest.mock('@velocity-exchange/sdk', () => {
	const actual = jest.requireActual('@velocity-exchange/sdk');
	return {
		...actual,
		calculateFeesAndFundingPnl: (...args: any[]) => mockCalculateFeesAndFundingPnl(...args),
	};
});

describe('Onchain Routes', () => {
	let app: FastifyInstance;
	const mockAuthorityKeypair = Keypair.generate();
	const mockUserAccount1Keypair = Keypair.generate();
	const mockUserAccount2Keypair = Keypair.generate();
	const mockUserKeypair = Keypair.generate();
	const mockProgramId = Keypair.generate().publicKey;

	const mockPerpMarketAccount = {
		marketIndex: 0,
		amm: {
			cumulativeFundingRateLong: new BN(0),
			cumulativeFundingRateShort: new BN(0),
		},
	};

	const mockSpotMarket = {
		marketIndex: 0,
		decimals: 6,
		cumulativeDepositInterest: new BN(1000000),
		cumulativeBorrowInterest: new BN(1000000),
	};

	const createMockUser = (
		options: {
			hasAccount?: boolean;
			perpPositions?: any[];
			spotPositions?: any[];
			openOrders?: any[];
			netUsdValue?: BN;
			initialMargin?: BN;
			maintenanceMargin?: BN;
			health?: number;
			totalCollateral?: BN;
			freeCollateral?: BN;
			leverage?: BN;
		} = {}
	) => {
		const {
			hasAccount = true,
			perpPositions = [],
			spotPositions = [],
			openOrders = [],
			netUsdValue = new BN(10000).mul(QUOTE_PRECISION),
			initialMargin = new BN(1000).mul(QUOTE_PRECISION),
			maintenanceMargin = new BN(500).mul(QUOTE_PRECISION),
			health = 50,
			totalCollateral = new BN(10000).mul(QUOTE_PRECISION),
			freeCollateral = new BN(9000).mul(QUOTE_PRECISION),
			leverage = new BN(1).mul(TEN_THOUSAND),
		} = options;

		return {
			getUserAccount: jest.fn(() => (hasAccount ? {} : null)),
			getNetUsdValue: jest.fn(() => netUsdValue),
			getInitialMarginRequirement: jest.fn(() => initialMargin),
			getMaintenanceMarginRequirement: jest.fn(() => maintenanceMargin),
			getHealth: jest.fn(() => health),
			getTotalCollateral: jest.fn(() => totalCollateral),
			getFreeCollateral: jest.fn(() => freeCollateral),
			getLeverage: jest.fn(() => leverage),
			getActivePerpPositions: jest.fn(() => perpPositions),
			getActiveSpotPositions: jest.fn(() => spotPositions),
			getOpenOrders: jest.fn(() => openOrders),
			liquidationPrice: jest.fn((marketIndex: number) => new BN(100).mul(QUOTE_PRECISION)),
			isPerpPositionIsolated: jest.fn(
				(position: { positionFlag?: number }) =>
					((position.positionFlag ?? 0) & PositionFlag.IsolatedPosition) !== 0
			),
			spotLiquidationPrice: jest.fn((marketIndex: number) => new BN(50).mul(QUOTE_PRECISION)),
		};
	};

	const createMockPerpPosition = (
		options: {
			marketIndex?: number;
			baseAssetAmount?: BN;
			quoteEntryAmount?: BN;
			settledPnl?: BN;
			positionFlag?: number;
		} = {}
	) => {
		return {
			marketIndex: options.marketIndex ?? 0,
			baseAssetAmount: options.baseAssetAmount ?? new BN(1).mul(BASE_PRECISION),
			quoteEntryAmount: options.quoteEntryAmount ?? new BN(1000).mul(QUOTE_PRECISION),
			settledPnl: options.settledPnl ?? new BN(100).mul(QUOTE_PRECISION),
			positionFlag: options.positionFlag ?? 0,
		};
	};

	const createMockSpotPosition = (
		options: {
			marketIndex?: number;
			scaledBalance?: BN;
			balanceType?: SpotBalanceType;
			openOrders?: number;
		} = {}
	) => {
		return {
			marketIndex: options.marketIndex ?? 0,
			scaledBalance: options.scaledBalance ?? new BN(1000000),
			balanceType: options.balanceType ?? SpotBalanceType.DEPOSIT,
			openOrders: options.openOrders ?? 0,
		};
	};

	const createMockOrder = (
		options: {
			marketIndex?: number;
			marketType?: string;
			orderId?: number;
			price?: string;
			baseAssetAmount?: string;
			baseAssetAmountFilled?: string;
			status?: OrderStatus;
			orderType?: OrderType;
			direction?: PositionDirection;
			reduceOnly?: boolean;
			postOnly?: boolean;
			triggerPrice?: string;
			triggerCondition?: OrderTriggerCondition;
		} = {}
	) => {
		return {
			marketIndex: options.marketIndex ?? 0,
			marketType: options.marketType ?? 'perp',
			orderId: options.orderId ?? 1,
			price: options.price ?? new BN(100).mul(QUOTE_PRECISION).toString(),
			baseAssetAmount: options.baseAssetAmount ?? new BN(1).mul(BASE_PRECISION).toString(),
			baseAssetAmountFilled: options.baseAssetAmountFilled ?? ZERO.toString(),
			status: options.status ?? OrderStatus.OPEN,
			orderType: options.orderType ?? OrderType.LIMIT,
			direction: options.direction ?? PositionDirection.LONG,
			reduceOnly: options.reduceOnly ?? false,
			postOnly: options.postOnly ?? false,
			triggerPrice: options.triggerPrice ?? ZERO.toString(),
			triggerCondition: options.triggerCondition ?? OrderTriggerCondition.ABOVE,
		};
	};

	beforeEach(async () => {
		app = Fastify();

		// Mock the velocityClient property
		(app as any).velocityClient = {
			getUserAccountsAndAddressesForAuthority: mockGetUserAccountsAndAddressesForAuthority,
			getSpotMarketAccounts: mockGetSpotMarketAccounts,
			getPerpMarketAccount: jest.fn(() => mockPerpMarketAccount),
			program: {
				programId: mockProgramId,
				account: {
					revenueShareEscrow: {
						fetchNullable: mockFetchRevenueShareEscrow,
					},
					revenueShare: {
						fetchNullable: mockFetchRevenueShareAccount,
					},
				},
			},
		};
		// Mock the required properties
		(app as any).ensureVelocityClientSubscribed = mockEnsureVelocityClientSubscribed;
		(app as any).centralServerVelocity = {
			getUser: mockGetUser,
		};

		await app.register(userOnchainRoutes);
		await app.register(onchainRoutes);
		await app.ready();

		// Reset mocks
		mockGetUserAccountsAndAddressesForAuthority.mockReset();
		mockEnsureVelocityClientSubscribed.mockReset();
		mockGetSpotMarketAccounts.mockReset();
		mockGetUser.mockReset();
		mockCalculateFeesAndFundingPnl.mockReset();
		mockFetchRevenueShareEscrow.mockReset();
		mockFetchRevenueShareAccount.mockReset();

		// Default mock implementations
		mockEnsureVelocityClientSubscribed.mockResolvedValue(undefined);
		mockGetSpotMarketAccounts.mockResolvedValue([mockSpotMarket]);
		mockCalculateFeesAndFundingPnl.mockReturnValue(new BN(50).mul(QUOTE_PRECISION));
		mockFetchRevenueShareEscrow.mockResolvedValue(null);
		mockFetchRevenueShareAccount.mockResolvedValue(null);
	});

	afterEach(async () => {
		await app.close();
		jest.clearAllMocks();
	});

	describe('GET /:authorityId/accounts', () => {
		const createMockUserAccount = (
			publicKey: PublicKey,
			subAccountId: number,
			name: string
		) => {
			const nameBuffer = Buffer.alloc(32);
			Buffer.from(name, 'utf8').copy(nameBuffer);

			return {
				publicKey,
				account: {
					subAccountId,
					name: Array.from(nameBuffer),
				},
			};
		};

		it('should successfully retrieve user accounts for an authority', async () => {
			const mockAccounts = [
				createMockUserAccount(mockUserAccount1Keypair.publicKey, 0, 'Main Account'),
				createMockUserAccount(mockUserAccount2Keypair.publicKey, 1, 'Trading Account'),
			];

			mockGetUserAccountsAndAddressesForAuthority.mockResolvedValue(mockAccounts);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockAuthorityKeypair.publicKey.toString()}/accounts`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				builderRevenueShareAccount: null,
				revenueShareEscrow: null,
				accounts: [
					{
						accountId: mockUserAccount1Keypair.publicKey.toString(),
						name: 'Main Account',
						subAccountId: 0,
					},
					{
						accountId: mockUserAccount2Keypair.publicKey.toString(),
						subAccountId: 1,
						name: 'Trading Account',
					},
				],
			});

			expect(mockGetUserAccountsAndAddressesForAuthority).toHaveBeenCalledWith(
				expect.any(PublicKey)
			);
			expect(mockGetUserAccountsAndAddressesForAuthority).toHaveBeenCalledTimes(1);
		});

		it('should return empty array when authority has no accounts', async () => {
			mockGetUserAccountsAndAddressesForAuthority.mockResolvedValue([]);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockAuthorityKeypair.publicKey.toString()}/accounts`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				builderRevenueShareAccount: null,
				revenueShareEscrow: null,
				accounts: [],
			});
		});

		it('should handle accounts with empty names', async () => {
			const mockAccounts = [createMockUserAccount(mockUserAccount1Keypair.publicKey, 0, '')];

			mockGetUserAccountsAndAddressesForAuthority.mockResolvedValue(mockAccounts);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockAuthorityKeypair.publicKey.toString()}/accounts`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				builderRevenueShareAccount: null,
				revenueShareEscrow: null,
				accounts: [
					{
						accountId: mockUserAccount1Keypair.publicKey.toString(),
						subAccountId: 0,
						name: '',
					},
				],
			});
		});

		it('should handle invalid authority public key', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/invalid_public_key/accounts',
			});

			// Should return 500 or 400 depending on how PublicKey constructor handles it
			expect(response.statusCode).toBeGreaterThanOrEqual(400);
		});

		it('should handle velocityClient throwing an error', async () => {
			mockGetUserAccountsAndAddressesForAuthority.mockRejectedValue(
				new Error('Failed to fetch accounts')
			);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockAuthorityKeypair.publicKey.toString()}/accounts`,
			});

			expect(response.statusCode).toBeGreaterThanOrEqual(500);
		});

		it('should handle accounts with special characters in names', async () => {
			const mockAccounts = [
				createMockUserAccount(mockUserAccount1Keypair.publicKey, 0, 'Test™ Account®'),
				createMockUserAccount(mockUserAccount2Keypair.publicKey, 1, '日本語'),
			];

			mockGetUserAccountsAndAddressesForAuthority.mockResolvedValue(mockAccounts);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockAuthorityKeypair.publicKey.toString()}/accounts`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.accounts[0].name).toBe('Test™ Account®');
			expect(payload.accounts[1].name).toBe('日本語');
		});

		it('should include approved builders when revenue share escrow exists', async () => {
			const builderAuthority1 = Keypair.generate().publicKey;
			const builderAuthority2 = Keypair.generate().publicKey;

			mockGetUserAccountsAndAddressesForAuthority.mockResolvedValue([
				createMockUserAccount(mockUserAccount1Keypair.publicKey, 0, 'Main Account'),
			]);
			mockFetchRevenueShareEscrow.mockResolvedValue({
				approvedBuilders: [
					{ authority: builderAuthority1, maxFeeTenthBps: 10 },
					{ authority: builderAuthority2, maxFeeTenthBps: 0 },
				],
			});
			mockFetchRevenueShareAccount.mockResolvedValue({
				totalBuilderRewards: new BN(123),
			});

			const response = await app.inject({
				method: 'GET',
				url: `/${mockAuthorityKeypair.publicKey.toString()}/accounts`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.revenueShareEscrow).toEqual(
				expect.objectContaining({
					accountId: expect.any(String),
					approvedBuilders: [
						expect.objectContaining({
							authority: builderAuthority1.toString(),
							maxFeeTenthBps: 10,
						}),
					],
				})
			);
			expect(payload.builderRevenueShareAccount).toEqual(
				expect.objectContaining({
					accountId: expect.any(String),
					totalBuilderRewards: '123',
				})
			);
		});
	});

	describe('GET /:accountId', () => {
		it('should successfully retrieve user account with no positions', async () => {
			const mockUser = createMockUser();
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				account: {
					balance: '10000.000000',
					freeCollateral: '9000.000000',
					health: '50',
					initialMargin: '1000.000000',
					leverage: '1',
					maintenanceMargin: '500.000000',
					totalCollateral: '10000.000000',
				},
				balances: [],
				orders: [],
				positions: [],
			});

			expect(mockEnsureVelocityClientSubscribed).toHaveBeenCalledTimes(1);
			expect(mockGetUser).toHaveBeenCalledWith(expect.any(PublicKey));
		});

		it('should successfully retrieve user account with perp positions', async () => {
			const perpPosition = createMockPerpPosition({
				marketIndex: 0,
				baseAssetAmount: new BN(5).mul(BASE_PRECISION),
				quoteEntryAmount: new BN(5000).mul(QUOTE_PRECISION),
				settledPnl: new BN(200).mul(QUOTE_PRECISION),
			});

			const mockUser = createMockUser({
				perpPositions: [perpPosition],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				account: {
					balance: '10000.000000',
					freeCollateral: '9000.000000',
					health: '50',
					initialMargin: '1000.000000',
					leverage: '1',
					maintenanceMargin: '500.000000',
					totalCollateral: '10000.000000',
				},
				balances: [],
				orders: [],
				positions: [
					{
						baseAssetAmount: '5.000000000',
						feesAndFunding: '50.000000',
						liquidationPrice: '100.000000',
						marginMode: 'cross',
						marketIndex: 0,
						quoteEntryAmount: '5000.000000',
						settledPnl: '200.000000',
						symbol: 'SOL-PERP',
					},
				],
			});
		});

		it('should pass isolated margin type for isolated perp liquidation price', async () => {
			const perpPosition = createMockPerpPosition({
				marketIndex: 0,
				positionFlag: PositionFlag.IsolatedPosition,
			});

			const mockUser = createMockUser({
				perpPositions: [perpPosition],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(mockUser.liquidationPrice).toHaveBeenCalledWith(
				0,
				ZERO,
				ZERO,
				'Maintenance',
				false,
				ZERO,
				'Isolated'
			);
			expect(payload.positions[0].marginMode).toBe('isolated');
		});

		it('should successfully retrieve user account with spot balances', async () => {
			const spotPosition = createMockSpotPosition({
				marketIndex: 0,
				scaledBalance: new BN(1000000000),
				balanceType: SpotBalanceType.DEPOSIT,
				openOrders: 2,
			});

			const mockUser = createMockUser({
				spotPositions: [spotPosition],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				account: {
					balance: '10000.000000',
					freeCollateral: '9000.000000',
					health: '50',
					initialMargin: '1000.000000',
					leverage: '1',
					maintenanceMargin: '500.000000',
					totalCollateral: '10000.000000',
				},
				balances: [
					{
						balance: '0.000100',
						liquidationPrice: '50.000000',
						marketIndex: 0,
						openOrders: 2,
						symbol: 'USDC',
					},
				],
				orders: [],
				positions: [],
			});
		});

		it('should successfully retrieve user account with open orders', async () => {
			const order = createMockOrder({
				marketIndex: 0,
				marketType: 'perp',
				orderId: 1,
				status: OrderStatus.OPEN,
				orderType: OrderType.LIMIT,
				direction: PositionDirection.LONG,
			});

			const mockUser = createMockUser({
				openOrders: [order],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				account: {
					balance: '10000.000000',
					freeCollateral: '9000.000000',
					health: '50',
					initialMargin: '1000.000000',
					leverage: '1',
					maintenanceMargin: '500.000000',
					totalCollateral: '10000.000000',
				},
				balances: [],
				orders: [
					{
						baseAssetAmount: '1.000000000',
						baseAssetAmountFilled: '0.000000000',
						direction: 'long',
						marketIndex: 0,
						marketType: 'perp',
						orderId: 1,
						orderType: 'limit',
						postOnly: false,
						price: '100.000000',
						quoteAssetAmountFilled: '0.000000',
						reduceOnly: false,
						status: 'open',
						symbol: 'SOL-PERP',
						triggerCondition: 'above',
						triggerPrice: '0.000000',
					},
				],
				positions: [],
			});
		});

		it('should handle spot orders with correct decimals', async () => {
			const spotMarket = {
				marketIndex: 1,
				decimals: 9, // Different decimals for testing
				cumulativeDepositInterest: new BN(1000000),
				cumulativeBorrowInterest: new BN(1000000),
			};

			mockGetSpotMarketAccounts.mockResolvedValue([mockSpotMarket, spotMarket]);

			const spotOrder = createMockOrder({
				marketIndex: 1,
				marketType: 'spot',
				orderId: 2,
			});

			const mockUser = createMockUser({
				openOrders: [spotOrder],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				account: {
					balance: '10000.000000',
					freeCollateral: '9000.000000',
					health: '50',
					initialMargin: '1000.000000',
					leverage: '1',
					maintenanceMargin: '500.000000',
					totalCollateral: '10000.000000',
				},
				balances: [],
				orders: [
					{
						baseAssetAmount: '1.000000000',
						baseAssetAmountFilled: '0.000000000',
						direction: 'long',
						marketIndex: 1,
						marketType: 'spot',
						orderId: 2,
						orderType: 'limit',
						postOnly: false,
						price: '100.000000',
						quoteAssetAmountFilled: '0.000000',
						reduceOnly: false,
						status: 'open',
						symbol: 'SOL',
						triggerCondition: 'above',
						triggerPrice: '0.000000',
					},
				],
				positions: [],
			});
		});

		it('should filter out perp positions with zero baseAssetAmount', async () => {
			const positions = [
				createMockPerpPosition({
					marketIndex: 0,
					baseAssetAmount: ZERO,
				}),
				createMockPerpPosition({
					marketIndex: 1,
					baseAssetAmount: new BN(1).mul(BASE_PRECISION),
				}),
			];

			const mockUser = createMockUser({
				perpPositions: positions,
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.positions).toHaveLength(1);
			expect(payload.positions[0].marketIndex).toBe(1);
		});

		it('should return 400 for invalid account ID format', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/invalid_public_key',
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				error: 'ValidationError',
				message: expect.stringContaining('Invalid account ID format'),
			});
		});

		it('should return 503 when spot market accounts fetch fails', async () => {
			mockGetSpotMarketAccounts.mockRejectedValue(new Error('RPC error'));

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(503);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				error: 'RPCError',
				message: expect.stringContaining('Failed to fetch spot market data'),
			});
		});

		it('should return 503 when user account does not exist', async () => {
			const mockUser = createMockUser({ hasAccount: false });
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(503);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				error: 'RPCError',
				message: expect.stringContaining('Failed to fetch user account'),
			});
		});

		it('should throw error when spot market is not found for balance', async () => {
			const spotPosition = createMockSpotPosition({
				marketIndex: 999, // Non-existent market
			});

			const mockUser = createMockUser({
				spotPositions: [spotPosition],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBeGreaterThanOrEqual(500);
		});

		it('should throw error when spot market decimals not found for order', async () => {
			const spotOrder = createMockOrder({
				marketIndex: 999, // Non-existent market
				marketType: 'spot',
			});

			const mockUser = createMockUser({
				openOrders: [spotOrder],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBeGreaterThanOrEqual(500);
		});

		it('should handle multiple positions, balances, and orders', async () => {
			const mockUser = createMockUser({
				perpPositions: [
					createMockPerpPosition({ marketIndex: 0 }),
					createMockPerpPosition({ marketIndex: 1 }),
				],
				spotPositions: [
					createMockSpotPosition({ marketIndex: 0 }),
					createMockSpotPosition({ marketIndex: 1 }),
				],
				openOrders: [
					createMockOrder({ marketIndex: 0, orderId: 1 }),
					createMockOrder({ marketIndex: 1, orderId: 2 }),
				],
			});

			mockGetSpotMarketAccounts.mockResolvedValue([
				mockSpotMarket,
				{ ...mockSpotMarket, marketIndex: 1 },
			]);

			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				account: {
					balance: '10000.000000',
					freeCollateral: '9000.000000',
					health: '50',
					initialMargin: '1000.000000',
					leverage: '1',
					maintenanceMargin: '500.000000',
					totalCollateral: '10000.000000',
				},
				balances: [
					{
						balance: '0.000000',
						liquidationPrice: '50.000000',
						marketIndex: 0,
						openOrders: 0,
						symbol: 'USDC',
					},
					{
						balance: '0.000000',
						liquidationPrice: '50.000000',
						marketIndex: 1,
						openOrders: 0,
						symbol: 'SOL',
					},
				],
				orders: [
					{
						baseAssetAmount: '1.000000000',
						baseAssetAmountFilled: '0.000000000',
						direction: 'long',
						marketIndex: 0,
						marketType: 'perp',
						orderId: 1,
						orderType: 'limit',
						postOnly: false,
						price: '100.000000',
						quoteAssetAmountFilled: '0.000000',
						reduceOnly: false,
						status: 'open',
						symbol: 'SOL-PERP',
						triggerCondition: 'above',
						triggerPrice: '0.000000',
					},
					{
						baseAssetAmount: '1.000000000',
						baseAssetAmountFilled: '0.000000000',
						direction: 'long',
						marketIndex: 1,
						marketType: 'perp',
						orderId: 2,
						orderType: 'limit',
						postOnly: false,
						price: '100.000000',
						quoteAssetAmountFilled: '0.000000',
						reduceOnly: false,
						status: 'open',
						symbol: 'BTC-PERP',
						triggerCondition: 'above',
						triggerPrice: '0.000000',
					},
				],
				positions: [
					{
						baseAssetAmount: '1.000000000',
						liquidationPrice: '100.000000',
						marginMode: 'cross',
						marketIndex: 0,
						feesAndFunding: '50.000000',
						quoteEntryAmount: '1000.000000',
						settledPnl: '100.000000',
						symbol: 'SOL-PERP',
					},
					{
						baseAssetAmount: '1.000000000',
						liquidationPrice: '100.000000',
						marginMode: 'cross',
						marketIndex: 1,
						feesAndFunding: '50.000000',
						quoteEntryAmount: '1000.000000',
						settledPnl: '100.000000',
						symbol: 'BTC-PERP',
					},
				],
			});
		});

		it('should correctly calculate fees and funding for positions', async () => {
			const expectedFeesAndFunding = new BN(123).mul(QUOTE_PRECISION);
			mockCalculateFeesAndFundingPnl.mockReturnValue(expectedFeesAndFunding);

			const mockUser = createMockUser({
				perpPositions: [createMockPerpPosition()],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(mockCalculateFeesAndFundingPnl).toHaveBeenCalled();
			expect(payload.positions[0]).toHaveProperty('feesAndFunding');
		});

		it('should handle orders with trigger conditions', async () => {
			const triggerOrder = createMockOrder({
				orderType: OrderType.TRIGGER_LIMIT,
				triggerPrice: new BN(1000).mul(QUOTE_PRECISION).toString(),
				triggerCondition: OrderTriggerCondition.ABOVE,
			});

			const mockUser = createMockUser({
				openOrders: [triggerOrder],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				account: {
					balance: '10000.000000',
					freeCollateral: '9000.000000',
					health: '50',
					initialMargin: '1000.000000',
					leverage: '1',
					maintenanceMargin: '500.000000',
					totalCollateral: '10000.000000',
				},
				balances: [],
				orders: [
					{
						baseAssetAmount: '1.000000000',
						baseAssetAmountFilled: '0.000000000',
						direction: 'long',
						marketIndex: 0,
						marketType: 'perp',
						orderId: 1,
						orderType: 'triggerLimit',
						postOnly: false,
						price: '100.000000',
						quoteAssetAmountFilled: '0.000000',
						reduceOnly: false,
						status: 'open',
						symbol: 'SOL-PERP',
						triggerCondition: 'above',
						triggerPrice: '1000.000000',
					},
				],
				positions: [],
			});
		});

		it('should handle reduce only and post only orders', async () => {
			const order = createMockOrder({
				reduceOnly: true,
				postOnly: true,
			});

			const mockUser = createMockUser({
				openOrders: [order],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.orders[0].reduceOnly).toBe(true);
			expect(payload.orders[0].postOnly).toBe(true);
		});

		it('should handle different order directions', async () => {
			const longOrder = createMockOrder({
				direction: PositionDirection.LONG,
				orderId: 1,
			});
			const shortOrder = createMockOrder({
				direction: PositionDirection.SHORT,
				orderId: 2,
			});

			const mockUser = createMockUser({
				openOrders: [longOrder, shortOrder],
			});
			mockGetUser.mockResolvedValue(mockUser);

			const response = await app.inject({
				method: 'GET',
				url: `/${mockUserKeypair.publicKey.toString()}`,
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				account: {
					balance: '10000.000000',
					freeCollateral: '9000.000000',
					health: '50',
					initialMargin: '1000.000000',
					leverage: '1',
					maintenanceMargin: '500.000000',
					totalCollateral: '10000.000000',
				},
				balances: [],
				orders: [
					{
						baseAssetAmount: '1.000000000',
						baseAssetAmountFilled: '0.000000000',
						direction: 'long',
						marketIndex: 0,
						marketType: 'perp',
						orderId: 1,
						orderType: 'limit',
						postOnly: false,
						price: '100.000000',
						quoteAssetAmountFilled: '0.000000',
						reduceOnly: false,
						status: 'open',
						symbol: 'SOL-PERP',
						triggerCondition: 'above',
						triggerPrice: '0.000000',
					},
					{
						baseAssetAmount: '1.000000000',
						baseAssetAmountFilled: '0.000000000',
						direction: 'short',
						marketIndex: 0,
						marketType: 'perp',
						orderId: 2,
						orderType: 'limit',
						postOnly: false,
						price: '100.000000',
						quoteAssetAmountFilled: '0.000000',
						reduceOnly: false,
						status: 'open',
						symbol: 'SOL-PERP',
						triggerCondition: 'above',
						triggerPrice: '0.000000',
					},
				],
				positions: [],
			});
		});
	});
});
