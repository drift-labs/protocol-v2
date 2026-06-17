import Fastify, { FastifyInstance } from 'fastify';
import whitelistRoutes from '../../src/routes/whitelist';

const mockCreateWhitelist = jest.fn();
const mockGetWhitelist = jest.fn();
const mockUpdateWhitelist = jest.fn();
const mockRemoveWhitelist = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	WhitelistRepository: jest.fn(() => ({
		createWhitelist: mockCreateWhitelist,
		getWhitelist: mockGetWhitelist,
		updateWhitelist: mockUpdateWhitelist,
		removeWhitelist: mockRemoveWhitelist,
	})),
}));

jest.mock('../../src/hooks/solana-auth', () => ({
	solanaAuth: async (request: { walletAddress?: string }) => {
		request.walletAddress = 'auth123';
	},
}));

describe('Whitelist Routes', () => {
	let app: FastifyInstance;

	const authHeaders = {
		'x-wallet-address': 'auth123',
		'x-signature': 'sig',
		'x-signed-message': '{"action":"test","ts":1,"walletAddress":"auth123"}',
	};

	beforeEach(async () => {
		app = Fastify();
		await app.register(whitelistRoutes, { prefix: '/whitelist' });
		await app.ready();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('POST /whitelist', () => {
		it('should create a whitelist entry', async () => {
			const mockEntry = {
				whitelistId: 'wl1',
				authorityId: 'auth123',
				address: 'wallet123',
				label: 'Main Wallet',
				token: 'USDC',
				chainId: 'solana',
			};

			mockCreateWhitelist.mockResolvedValue(mockEntry);

			const response = await app.inject({
				method: 'POST',
				url: '/whitelist',
				headers: authHeaders,
				payload: {
					address: 'wallet123',
					label: 'Main Wallet',
					token: 'USDC',
					chainId: 'solana',
				},
			});

			expect(response.statusCode).toBe(200);
			expect(mockCreateWhitelist).toHaveBeenCalledWith({
				authorityId: 'auth123',
				address: 'wallet123',
				label: 'Main Wallet',
				token: 'USDC',
				chainId: 'solana',
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				item: mockEntry,
			});
		});
	});

	describe('GET /whitelist', () => {
		it('should return all whitelist entries', async () => {
			const mockEntries = [
				{
					whitelistId: 'wl1',
					authorityId: 'auth123',
					address: 'wallet123',
					label: 'Main Wallet',
					token: 'USDC',
					chainId: 'solana',
				},
			];

			mockGetWhitelist.mockResolvedValue(mockEntries);

			const response = await app.inject({
				method: 'GET',
				url: '/whitelist',
				headers: authHeaders,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetWhitelist).toHaveBeenCalledWith({ authorityId: 'auth123' });

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				items: mockEntries,
			});
		});
	});

	describe('PUT /whitelist/:whitelistId', () => {
		it('should update a whitelist entry', async () => {
			const mockEntry = {
				whitelistId: 'wl1',
				authorityId: 'auth123',
				address: 'wallet123',
				label: 'Updated Label',
				token: 'USDC',
				chainId: 'solana',
			};

			mockUpdateWhitelist.mockResolvedValue(mockEntry);

			const response = await app.inject({
				method: 'PUT',
				url: '/whitelist/wl1',
				headers: authHeaders,
				payload: {
					address: 'wallet123',
					label: 'Updated Label',
					token: 'USDC',
					chainId: 'solana',
				},
			});

			expect(response.statusCode).toBe(200);
			expect(mockUpdateWhitelist).toHaveBeenCalledWith({
				authorityId: 'auth123',
				whitelistId: 'wl1',
				address: 'wallet123',
				label: 'Updated Label',
				token: 'USDC',
				chainId: 'solana',
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				item: mockEntry,
			});
		});
	});

	describe('DELETE /whitelist/:whitelistId', () => {
		it('should delete a whitelist entry', async () => {
			mockRemoveWhitelist.mockResolvedValue(undefined);

			const response = await app.inject({
				method: 'DELETE',
				url: '/whitelist/wl1',
				headers: authHeaders,
			});

			expect(response.statusCode).toBe(200);
			expect(mockRemoveWhitelist).toHaveBeenCalledWith({
				authorityId: 'auth123',
				whitelistId: 'wl1',
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
			});
		});
	});
});
