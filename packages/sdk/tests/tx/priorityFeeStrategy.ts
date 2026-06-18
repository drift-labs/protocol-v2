import { expect } from 'chai';
import { AverageStrategy } from '../../src/priorityFee/averageStrategy';
import { MaxStrategy } from '../../src/priorityFee/maxStrategy';
import { EwmaStrategy } from '../../src/priorityFee/ewmaStrategy';
import { MaxOverSlotsStrategy } from '../../src/priorityFee/maxOverSlotsStrategy';
import { AverageOverSlotsStrategy } from '../../src/priorityFee/averageOverSlotsStrategy';

describe('PriorityFeeStrategy', () => {
	it('AverageStrategy should calculate the average prioritization fee', () => {
		const averageStrategy = new AverageStrategy();
		const samples = [
			{ slot: 3, prioritizationFee: 300 },
			{ slot: 2, prioritizationFee: 200 },
			{ slot: 1, prioritizationFee: 100 },
		];
		const average = averageStrategy.calculate(samples);
		expect(average).to.equal(200);
	});

	it('MaxStrategy should calculate the maximum prioritization fee', () => {
		const maxStrategy = new MaxStrategy();
		const samples = [
			{ slot: 3, prioritizationFee: 300 },
			{ slot: 2, prioritizationFee: 200 },
			{ slot: 1, prioritizationFee: 100 },
		];
		const max = maxStrategy.calculate(samples);
		expect(max).to.equal(300);
	});

	it('EwmaStrategy should calculate the ewma prioritization fee', () => {
		// halflife of 5 alots
		const ewmaStrategy = new EwmaStrategy(5);
		const samples = [
			{ slot: 6, prioritizationFee: 0 },
			{ slot: 2, prioritizationFee: 0 },
			{ slot: 2, prioritizationFee: 0 },
			{ slot: 2, prioritizationFee: 0 },
			{ slot: 2, prioritizationFee: 0 },
			{ slot: 1, prioritizationFee: 1000 },
		];
		const ewma = ewmaStrategy.calculate(samples);
		expect(ewma).to.be.approximately(500, 0.00001);
	});

	it('EwmaStrategy should calculate the ewma prioritization fee, length 1', () => {
		// halflife of 5 alots
		const ewmaStrategy = new EwmaStrategy(5);
		const samples = [{ slot: 6, prioritizationFee: 1000 }];
		const ewma = ewmaStrategy.calculate(samples);
		expect(ewma).to.be.approximately(1000, 0.00001);
	});

	it('EwmaStrategy should calculate the ewma prioritization fee, length 6', () => {
		const ewmaStrategy = new EwmaStrategy(5);
		const samples = [
			{ slot: 6, prioritizationFee: 1000 },
			{ slot: 5, prioritizationFee: 570 },
			{ slot: 4, prioritizationFee: 860 },
			{ slot: 3, prioritizationFee: 530 },
			{ slot: 2, prioritizationFee: 701 },
			{ slot: 1, prioritizationFee: 230 },
		];
		const ewma = ewmaStrategy.calculate(samples);
		expect(ewma).to.be.approximately(490.43706, 0.00001);
	});

	it('MaxOverSlotsStrategy should calculate the max prioritization fee over slots', () => {
		const maxOverSlotsStrategy = new MaxOverSlotsStrategy();
		const samples = [
			{ slot: 6, prioritizationFee: 432 },
			{ slot: 3, prioritizationFee: 543 },
			{ slot: 3, prioritizationFee: 342 },
			{ slot: 3, prioritizationFee: 832 },
			{ slot: 2, prioritizationFee: 123 },
			{ slot: 1, prioritizationFee: 1000 },
		];
		const maxOverSlots = maxOverSlotsStrategy.calculate(samples);
		expect(maxOverSlots).to.equal(1000);
	});

	it('AverageOverSlotsStrategy should calculate the average prioritization fee over slots', () => {
		const averageOverSlotsStrategy = new AverageOverSlotsStrategy();
		const samples = [
			{ slot: 6, prioritizationFee: 432 },
			{ slot: 3, prioritizationFee: 543 },
			{ slot: 3, prioritizationFee: 342 },
			{ slot: 3, prioritizationFee: 832 },
			{ slot: 2, prioritizationFee: 123 },
			{ slot: 1, prioritizationFee: 1000 },
		];
		const averageOverSlots = averageOverSlotsStrategy.calculate(samples);
		expect(averageOverSlots).to.approximately(545.33333, 0.00001);
	});
});
