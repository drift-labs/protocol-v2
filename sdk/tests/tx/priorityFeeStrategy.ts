import { expect } from 'chai';
import { AverageStrategy } from '../../src/priorityFee/averageStrategy';
import { MaxStrategy } from '../../src/priorityFee/maxStrategy';
import { EwmaStrategy } from '../../src/priorityFee/ewmaStrategy';

describe('PriorityFeeStrategy', () => {

    it('AverageStrategy should calculate the average prioritization fee', () => {
        const averageStrategy = new AverageStrategy();
    const samples = [
        { slot: 1, prioritizationFee: 100 },
        { slot: 2, prioritizationFee: 200 },
        { slot: 3, prioritizationFee: 300 },
    ];
        const average = averageStrategy.calculate(samples);
        expect(average).to.equal(200);
    });

    it('MaxStrategy should calculate the maximum prioritization fee', () => {
        const maxStrategy = new MaxStrategy();
    const samples = [
        { slot: 1, prioritizationFee: 100 },
        { slot: 2, prioritizationFee: 200 },
        { slot: 3, prioritizationFee: 300 },
    ];
        const max = maxStrategy.calculate(samples);
        expect(max).to.equal(300);
    });

    it('EwmaStrategy should calculate the ewma prioritization fee', () => {
        // halflife of 5 alots
        const ewmaStrategy = new EwmaStrategy(5);
        const samples = [
            { slot: 1, prioritizationFee: 1000 },
            { slot: 2, prioritizationFee: 0 },
            { slot: 2, prioritizationFee: 0 },
            { slot: 2, prioritizationFee: 0 },
            { slot: 2, prioritizationFee: 0 },
            { slot: 6, prioritizationFee: 0 },
        ];
        const ewma = ewmaStrategy.calculate(samples);
        expect(ewma).to.be.approximately(500, 0.00001);
    });
});