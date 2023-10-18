import { expect } from 'chai';
import { PriorityFeeCalculator } from '../../src/tx/priorityFeeCalculator';

describe('PriorityFeeCalculator', () => {
	let priorityFeeCalculator: PriorityFeeCalculator;

	const startTime = 1000000;
	const latch_duration = 10_000;

	beforeEach(() => {
		priorityFeeCalculator = new PriorityFeeCalculator(
			startTime,
			latch_duration
		);
	});

	it('should trigger priority fee when timeout count increases', () => {
		const timeoutCount = 1;
		expect(priorityFeeCalculator.updatePriorityFee(startTime, timeoutCount)).to
			.be.true;
		expect(
			priorityFeeCalculator.updatePriorityFee(
				startTime + latch_duration,
				timeoutCount + 1
			)
		).to.be.true;
		expect(
			priorityFeeCalculator.updatePriorityFee(
				startTime + latch_duration,
				timeoutCount + 2
			)
		).to.be.true;
	});

	it('should trigger priority fee when timeout count increases, and stay latched until latch duration', () => {
		const timeoutCount = 1;
		expect(priorityFeeCalculator.updatePriorityFee(startTime, timeoutCount)).to
			.be.true;
		expect(
			priorityFeeCalculator.updatePriorityFee(
				startTime + latch_duration / 2,
				timeoutCount
			)
		).to.be.true;
		expect(
			priorityFeeCalculator.updatePriorityFee(
				startTime + latch_duration - 1,
				timeoutCount
			)
		).to.be.true;
		expect(
			priorityFeeCalculator.updatePriorityFee(
				startTime + latch_duration * 2,
				timeoutCount
			)
		).to.be.false;
	});

	it('should not trigger priority fee when timeout count does not increase', () => {
		const timeoutCount = 0;
		expect(priorityFeeCalculator.updatePriorityFee(startTime, timeoutCount)).to
			.be.false;
	});

	it('should correctly calculate compute unit price', () => {
		const computeUnitLimit = 1_000_000;
		const additionalFeeMicroLamports = 1_000_000_000; // 1000 lamports
		const actualComputeUnitPrice =
			priorityFeeCalculator.calculateComputeUnitPrice(
				computeUnitLimit,
				additionalFeeMicroLamports
			);
		expect(actualComputeUnitPrice * computeUnitLimit).to.equal(
			additionalFeeMicroLamports
		);
	});
});
