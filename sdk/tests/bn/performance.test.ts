import { BN } from '../../src/index';
import { BigNum } from '../../src/factory/bigNum';

const BIGNUM_VERSION = 'v1.3';

describe('BigNum Performance Tests', () => {
	const testValues = [
		{ val: '123', precision: 0 },
		{ val: '1234567', precision: 0 },
		{ val: '123456789', precision: 3 },
		{ val: '1000000000123', precision: 6 },
		{ val: '999999999999999', precision: 9 },
		{ val: '123456789012345', precision: 12 },
	];

	const createTestBigNums = () => {
		return testValues.map(({ val, precision }) => 
			BigNum.from(new BN(val), new BN(precision))
		);
	};

	const performanceTest = (name: string, fn: () => void, iterations: number) => {
		const start = performance.now();
		for (let i = 0; i < iterations; i++) {
			fn();
		}
		const end = performance.now();
		const duration = end - start;
		console.log(`[${BIGNUM_VERSION}] ${name}: ${duration.toFixed(2)}ms (${iterations} iterations)`);
		return duration;
	};

	it('should benchmark print() method', () => {
		const bigNums = createTestBigNums();
		
		performanceTest('print() method', () => {
			bigNums.forEach(bn => bn.print());
		}, 100000);
	});

	it('should benchmark prettyPrint() method', () => {
		const bigNums = createTestBigNums();
		
		performanceTest('prettyPrint() method', () => {
			bigNums.forEach(bn => bn.prettyPrint());
		}, 100000);
	});

	it('should benchmark toFixed() method', () => {
		const bigNums = createTestBigNums();
		
		performanceTest('toFixed() method', () => {
			bigNums.forEach(bn => bn.toFixed(4));
		}, 100000);
	});

	it('should benchmark toNum() method', () => {
		const bigNums = createTestBigNums();
		
		performanceTest('toNum() method', () => {
			bigNums.forEach(bn => bn.toNum());
		}, 100000);
	});

	it('should benchmark printShort() method', () => {
		const bigNums = createTestBigNums();
		
		performanceTest('printShort() method', () => {
			bigNums.forEach(bn => bn.printShort());
		}, 100000);
	});

	it('should stress test with large numbers', () => {
		const largeBigNums = [
			BigNum.from(new BN('999999999999999999999999999999'), new BN(15)),
			BigNum.from(new BN('123456789012345678901234567890'), new BN(18)),
			BigNum.from(new BN('987654321098765432109876543210'), new BN(20)),
		];

		performanceTest('Large number print()', () => {
			largeBigNums.forEach(bn => bn.print());
		}, 50000);

		performanceTest('Large number prettyPrint()', () => {
			largeBigNums.forEach(bn => bn.prettyPrint());
		}, 50000);

		performanceTest('Large number toFixed()', () => {
			largeBigNums.forEach(bn => bn.toFixed(4));
		}, 50000);
	});

	it('should test repeated operations on single instance', () => {
		const bigNum = BigNum.from(new BN('123456789'), new BN(6));
		
		performanceTest('Repeated print() operations', () => {
			for (let i = 0; i < 1000; i++) {
				bigNum.print();
			}
		}, 1000);

		performanceTest('Repeated prettyPrint() operations', () => {
			for (let i = 0; i < 1000; i++) {
				bigNum.prettyPrint();
			}
		}, 1000);

		performanceTest('Repeated toFixed() operations', () => {
			for (let i = 0; i < 1000; i++) {
				bigNum.toFixed(2);
			}
		}, 1000);
	});

	it('should benchmark locale-specific formatting', () => {
		const bigNums = createTestBigNums();
		
		performanceTest('toNum() with default locale', () => {
			bigNums.forEach(bn => bn.toNum());
		}, 100000);

		BigNum.setLocale('de-DE');
		
		performanceTest('toNum() with custom locale', () => {
			bigNums.forEach(bn => bn.toNum());
		}, 100000);

		BigNum.setLocale('en-US');
	});
});