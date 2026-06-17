import { expect } from 'chai';
import { BN } from '@drift-labs/sdk';
import { selectMakers } from './makerSelection';
import { MAX_MAKERS_PER_FILL } from './bots/filler';

describe('selectMakers', () => {
	let originalRandom: { (): number; (): number };

	beforeEach(() => {
		// Mock Math.random
		let seed = 12345;
		originalRandom = Math.random;
		Math.random = () => {
			const x = Math.sin(seed++) * 10000;
			return x - Math.floor(x);
		};
	});

	afterEach(() => {
		// Restore original Math.random
		Math.random = originalRandom;
	});

	it('more than 6', function () {
		// Mock DLOBNode and Order
		const mockOrder = (filledAmount: number, orderId: number) => ({
			orderId,
			baseAssetAmount: new BN(100),
			baseAssetAmountFilled: new BN(filledAmount),
		});

		const mockDLOBNode = (filledAmount: number, orderId: number) => ({
			order: mockOrder(filledAmount, orderId),
			// Include other necessary properties of DLOBNode if needed
		});

		const makerNodeMap = new Map([
			['0', [mockDLOBNode(10, 0)]],
			['1', [mockDLOBNode(20, 1)]],
			['2', [mockDLOBNode(30, 2)]],
			['3', [mockDLOBNode(40, 3)]],
			['4', [mockDLOBNode(50, 4)]],
			['5', [mockDLOBNode(60, 5)]],
			['6', [mockDLOBNode(70, 6)]],
			['7', [mockDLOBNode(80, 7)]],
			['8', [mockDLOBNode(90, 8)]],
		]);

		// @ts-ignore
		const selectedMakers = selectMakers(makerNodeMap);

		expect(selectedMakers).to.not.be.undefined;
		expect(selectedMakers.size).to.be.equal(MAX_MAKERS_PER_FILL);

		expect(selectedMakers.get('0')).to.not.be.undefined;
		expect(selectedMakers.get('1')).to.not.be.undefined;
		expect(selectedMakers.get('2')).to.not.be.undefined;
		expect(selectedMakers.get('3')).to.not.be.undefined;
		expect(selectedMakers.get('4')).to.be.undefined;
		expect(selectedMakers.get('5')).to.not.be.undefined;
		expect(selectedMakers.get('6')).to.not.be.undefined;
		expect(selectedMakers.get('7')).to.be.undefined;
		expect(selectedMakers.get('8')).to.be.undefined;
	});
});
