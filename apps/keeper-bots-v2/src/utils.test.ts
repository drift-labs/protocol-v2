import { expect } from 'chai';
import { isSetComputeUnitsIx } from './utils';
import { ComputeBudgetProgram } from '@solana/web3.js';

describe('transaction simulation tests', () => {
	it('isSetComputeUnitsIx', () => {
		const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
			units: 1_400_000,
		});
		const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
			microLamports: 10_000,
		});

		expect(isSetComputeUnitsIx(cuLimitIx)).to.be.true;
		expect(isSetComputeUnitsIx(cuPriceIx)).to.be.false;
	});
});
