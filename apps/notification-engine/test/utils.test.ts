import { OrderLabel } from '@backend/common';
import { formatNumber, getOrderFillNotificationBody } from '../src/utils';

describe('notification utils', () => {
	describe('formatNumber', () => {
		it('should preserve small crypto sizes', () => {
			expect(formatNumber(0.00005)).toBe('0.00005');
		});

		it('should keep large whole sizes compact', () => {
			expect(formatNumber(10000)).toBe('10000');
		});

		it('should keep fractional sizes without unnecessary trailing zeros', () => {
			expect(formatNumber(1.72)).toBe('1.72');
		});
	});

	describe('getOrderFillNotificationBody', () => {
		it('should format tiny crypto size and large price', () => {
			expect(
				getOrderFillNotificationBody({
					orderType: OrderLabel.LIMIT,
					size: 0.00005,
					symbol: 'BTC-PERP',
					price: 60000,
				})
			).toBe('Your Limit Order of 0.00005 BTC-PERP at $60000 has been filled');
		});

		it('should format large token size and tiny price', () => {
			expect(
				getOrderFillNotificationBody({
					orderType: OrderLabel.LIMIT,
					size: 10000,
					symbol: 'BONK-PERP',
					price: 0.00002,
				})
			).toBe('Your Limit Order of 10000 BONK-PERP at $0.00002 has been filled');
		});

		it('should use the shared number formatter for price display', () => {
			expect(
				getOrderFillNotificationBody({
					orderType: OrderLabel.LIMIT,
					size: 1,
					symbol: 'SOL-PERP',
					price: 0.123456789,
				})
			).toBe('Your Limit Order of 1 SOL-PERP at $0.123457 has been filled');
		});
	});
});
