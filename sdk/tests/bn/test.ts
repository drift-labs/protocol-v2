import { BN, numberToSafeBN } from '../../src/index';
import { expect } from 'chai';
import { BigNum } from '../../src/factory/bigNum';
import {
	AMM_RESERVE_PRECISION_EXP,
	BASE_PRECISION,
	BASE_PRECISION_EXP,
	TEN_THOUSAND,
} from '../../src/constants/numericConstants';

// if you used the '@types/mocha' method to install mocha type definitions, uncomment the following line
// import 'mocha';

const bn = (value: number, precision: number) =>
	new BigNum(Math.round(value * 10 ** precision), precision);
const _bnPrice = (value: number) => bn(value, 6); // Price precision (6 decimals)
const _bnNotional = (value: number) => bn(value, 6); // USDC precision (6 decimals)
const _bnPercentage = (value: number) => bn(value, 4); // Percentage precision (4 decimals)
const bnBaseAmount = (value: number) => bn(value, 8); // BTC-like precision (8 decimals)

describe('BigNum Tests', () => {
	it('basic string representations are correct', () => {
		const bn = BigNum.from(TEN_THOUSAND);
		expect(bn.toString()).to.equal('10000');
		expect(bn.print()).to.equal('10000');

		const bn2 = BigNum.from(TEN_THOUSAND, new BN(4));
		expect(bn2.toString()).to.equal('10000');
		expect(bn2.print()).to.equal('1.0000');

		const bn3 = BigNum.from(new BN('123456789'), new BN(4));
		expect(bn3.toString()).to.equal('123456789');
		expect(bn3.print()).to.equal('12345.6789');
	});

	it('can do basic maths correctly', () => {
		const val1 = BigNum.from(10 ** 4, 2).mul(BigNum.from(123456));

		expect(val1.toString()).to.equal('1234560000');

		// should trim one point of precision off
		const val2 = val1.div(BigNum.from(10 ** 5));

		expect(val2.toString()).to.equal('12345');
		expect(val2.print()).to.equal('123.45');

		// Trying to represent a 33.33333333% figure to precision 4
		const baseNumberPrecision = 10;
		const adjustmentPrecision = 4;

		const currentNumber = 400 * 10 ** baseNumberPrecision;
		const comparisonNumber = 300 * 10 ** baseNumberPrecision;

		const val3 = BigNum.from(currentNumber, baseNumberPrecision)
			.sub(BigNum.from(comparisonNumber, baseNumberPrecision))
			.mul(BigNum.from(10 ** adjustmentPrecision, adjustmentPrecision))
			.mul(BigNum.from(100))
			.div(BigNum.from(comparisonNumber, baseNumberPrecision))
			.abs();

		expect(val3.toString()).to.equal('333333');
		expect(val3.print()).to.equal('33.3333');
	});

	it('can shift numbers correctly', () => {
		const val1 = BigNum.from(new BN(`319657850313098510000000000`), 23).shift(
			new BN(-10)
		);

		expect(val1.toString()).to.equal(`31965785031309851`);
		expect(val1.print()).to.equal(`3196.5785031309851`);
	});

	it('can print numbers correctly', () => {
		// Case 1
		const val = BigNum.from(123456789, 5);

		expect(val.toString()).to.equal('123456789');

		expect(val.print()).to.equal('1234.56789');

		expect(val.toNum().toFixed(3)).to.equal('1234.568');
		expect(val.toPrecision(1)).to.equal('1e3');
		expect(val.toPrecision(3)).to.equal('123e1');
		expect(val.toPrecision(4)).to.equal('1234');
		expect(val.toPrecision(5)).to.equal('1234.5');
		expect(val.toPrecision(11)).to.equal('1234.5678900');

		expect(BigNum.from('1234').toPrecision(5)).to.equal('1234.0');

		// Case 2
		const val2 = BigNum.from(1, 5);

		expect(val2.toString()).to.equal('1');

		expect(val2.print()).to.equal('0.00001');

		// Case 3
		const val3 = BigNum.from(101003, 5);

		expect(val3.toString()).to.equal('101003');

		expect(val3.print()).to.equal('1.01003');
		expect(val3.toPrecision(7)).to.equal('1.010030');

		// Case 4
		const rawQuoteValue = 1;
		const entryPriceNum = 40;
		const val4 = BigNum.from(rawQuoteValue * 10 ** 8)
			.shift(AMM_RESERVE_PRECISION_EXP)
			.div(BigNum.from(entryPriceNum * 10 ** 8));

		expect(val4.toString()).to.equal('25000000');
		expect(val4.print()).to.equal('0.025000000');
		expect(val4.toNum().toFixed(3)).to.equal('0.025');
		expect(val4.toPrecision(4)).to.equal('0.025');

		expect(bnBaseAmount(0.001234).toPrecision(4)).to.equal('0.001234');

		expect(bnBaseAmount(0.001004).toPrecision(4)).to.equal('0.001004');

		expect(bnBaseAmount(0.001).toPrecision(4)).to.equal('0.001');

		// Case 5
		expect(BigNum.fromPrint('1').toMillified()).to.equal('1.00');
		expect(BigNum.fromPrint('12').toMillified()).to.equal('12.0');
		expect(BigNum.fromPrint('123').toMillified()).to.equal('123');
		expect(BigNum.fromPrint('1234').toMillified()).to.equal('1.23K');
		expect(BigNum.fromPrint('12345').toMillified()).to.equal('12.3K');
		expect(BigNum.fromPrint('123456').toMillified()).to.equal('123K');
		expect(BigNum.fromPrint('1234567').toMillified()).to.equal('1.23M');
		expect(BigNum.fromPrint('12345678').toMillified()).to.equal('12.3M');
		expect(BigNum.fromPrint('123456789').toMillified()).to.equal('123M');

		expect(BigNum.fromPrint('1').toMillified(5)).to.equal('1.0000');
		expect(BigNum.fromPrint('12').toMillified(5)).to.equal('12.000');
		expect(BigNum.fromPrint('123').toMillified(5)).to.equal('123.00');
		expect(BigNum.fromPrint('1234').toMillified(5)).to.equal('1234.0');
		expect(BigNum.fromPrint('12345').toMillified(5)).to.equal('12345');
		expect(BigNum.fromPrint('123456').toMillified(5)).to.equal('123.45K');
		expect(BigNum.fromPrint('1234567').toMillified(5)).to.equal('1.2345M');
		expect(BigNum.fromPrint('12345678').toMillified(5)).to.equal('12.345M');
		expect(BigNum.fromPrint('123456789').toMillified(5)).to.equal('123.45M');

		expect(BigNum.fromPrint('-1').toMillified(5)).to.equal('-1.0000');
		expect(BigNum.fromPrint('-12').toMillified(5)).to.equal('-12.000');
		expect(BigNum.fromPrint('-123').toMillified(5)).to.equal('-123.00');
		expect(BigNum.fromPrint('-1234').toMillified(5)).to.equal('-1234.0');
		expect(BigNum.fromPrint('-12345').toMillified(5)).to.equal('-12345');
		expect(BigNum.fromPrint('-123456').toMillified(5)).to.equal('-123.45K');
		expect(BigNum.fromPrint('-1234567').toMillified(5)).to.equal('-1.2345M');
		expect(BigNum.fromPrint('-12345678').toMillified(5)).to.equal('-12.345M');
		expect(BigNum.fromPrint('-123456789').toMillified(5)).to.equal('-123.45M');

		expect(BigNum.from(-95, 2).print()).to.equal('-0.95');

		// Case 6 strange numbers
		expect(BigNum.from('-100', 2).print()).to.equal('-1.00');
		expect(BigNum.from('-8402189', 13).print()).to.equal('-0.0000008402189');
		expect(BigNum.from('-10000000000000', 13).print()).to.equal(
			'-1.0000000000000'
		);
		expect(BigNum.from('-100', 6).print()).to.equal('-0.000100');

		// Case 7: really large numbers + switching between scientific/financial
		expect(BigNum.fromPrint('123000000000').toMillified(3)).to.equal('123B');
		expect(
			BigNum.fromPrint('123000000000').toMillified(3, undefined, 'scientific')
		).to.equal('123G'); // (G = Giga)
		expect(BigNum.fromPrint('123000000000000').toMillified(3)).to.equal('123T');
		expect(
			BigNum.fromPrint('123000000000000').toMillified(
				3,
				undefined,
				'scientific'
			)
		).to.equal('123T'); // (T = Tera)
		expect(BigNum.fromPrint('123000000000000000').toMillified(3)).to.equal(
			'123Q'
		);
		expect(
			BigNum.fromPrint('123000000000000000').toMillified(
				3,
				undefined,
				'scientific'
			)
		).to.equal('123P'); // (P = Peta)

		// TODO : Need to make the appropriate changes for the next line to pass
		// expect(BigNum.fromPrint('123000000000000000000').toMillified(3)).to.equal('123000Q');
	});

	it('can initialise from string values correctly', () => {
		// Case 1

		const baseAmountVal1 = '14.33';
		const val1 = BigNum.fromPrint(baseAmountVal1, BASE_PRECISION_EXP);

		expect(val1.toString()).to.equal('14330000000');
		expect(val1.print()).to.equal('14.330000000');

		const baseAmountVal2 = '34.1';
		const val2 = BigNum.fromPrint(baseAmountVal2, BASE_PRECISION_EXP);

		expect(val2.printShort()).to.equal('34.1');
	});

	it('is immutable', () => {
		// Case 1
		const initVal = BigNum.from(1);
		const postShift = initVal.shift(new BN(10), true);
		const postScale = postShift.scale(1, 10 ** 10);

		expect(initVal.toString()).to.equal(postScale.toString());
		expect(initVal === postShift).to.equal(false);
		expect(initVal.val === postShift.val).to.equal(false);
		expect(initVal === postScale).to.equal(false);
		expect(initVal.val === postScale.val).to.equal(false);
		expect(postShift === postScale).to.equal(false);
		expect(postShift.val === postScale.val).to.equal(false);

		const postMul = postScale.mul(new BN(1000));
		const postDiv = postMul.div(new BN(1000));

		expect(postMul.toString()).to.equal('1000');
		expect(postDiv.toString()).to.equal('1');
		expect(postMul === postDiv).to.equal(false);
		expect(postMul.val === postDiv.val).to.equal(false);

		const postAdd = postDiv.add(BigNum.from(new BN(1000)));
		const postSub = postAdd.sub(BigNum.from(new BN(1000)));

		expect(postAdd.toString()).to.equal('1001');
		expect(postSub.toString()).to.equal('1');
		expect(postAdd === postSub).to.equal(false);
		expect(postAdd.val === postSub.val).to.equal(false);
	});

	it('serializes properly', () => {
		// JSON
		let val = BigNum.from(new BN('123456'), 3);
		expect(val.toString()).to.equal('123456');
		val = val.shift(new BN(3));
		expect(val.toString()).to.equal('123456000');
		expect(val.print()).to.equal('123.456000');

		const stringified = JSON.stringify(val);

		expect(stringified).to.equal('{"val":"123456000","precision":"6"}');

		let parsed = BigNum.fromJSON(JSON.parse(stringified));
		expect(parsed.toString()).to.equal('123456000');
		expect(parsed.print()).to.equal('123.456000');

		parsed = parsed.shift(new BN(3));
		expect(parsed.toString()).to.equal('123456000000');
		expect(parsed.print()).to.equal('123.456000000');
	});

	it('can convert to a percentage', () => {
		// JSON
		const val = BigNum.from(new BN('100000'), 3);
		const val2 = BigNum.from(new BN('200000'), 3);
		const val3 = BigNum.from(new BN('66666'), 3);
		const val4 = BigNum.from(new BN('50000'), 3);
		const val5 = BigNum.from(new BN('700000'), 3);

		expect(val.toPercentage(val2, 3)).to.equal('50.0');
		expect(val.toPercentage(val2, 4)).to.equal('50.00');
		expect(val3.toPercentage(val2, 4)).to.equal('33.33');
		expect(val4.toPercentage(val2, 4)).to.equal('25.00');
		expect(val.toPercentage(val5, 6)).to.equal('14.2857');
	});

	it('can print without unnecessary trailing zeroes', () => {
		const rawQuoteValue = 1;
		const entryPriceNum = 40;
		const val = BigNum.from(rawQuoteValue * 10 ** 8)
			.shift(AMM_RESERVE_PRECISION_EXP)
			.div(BigNum.from(entryPriceNum * 10 ** 8));

		expect(val.toString()).to.equal('25000000');
		expect(val.printShort()).to.equal('0.025');

		const val2 = BigNum.from(10000, 4);
		expect(val2.print()).to.equal('1.0000');
		expect(val2.printShort()).to.equal('1');
	});

	it('can pretty print', () => {
		const val = BigNum.from('123');
		expect(val.prettyPrint()).to.equal('123');

		const val2 = BigNum.from('1234');
		expect(val2.prettyPrint()).to.equal('1,234');

		const val3 = BigNum.from('123456');
		expect(val3.prettyPrint()).to.equal('123,456');

		const val4 = BigNum.from('1234567');
		expect(val4.prettyPrint()).to.equal('1,234,567');

		const val5 = BigNum.from('12345678');
		expect(val5.prettyPrint()).to.equal('12,345,678');

		const val6 = BigNum.from('123456', 3);
		expect(val6.prettyPrint()).to.equal('123.456');

		const val7 = BigNum.from('123456789', 3);
		expect(val7.prettyPrint()).to.equal('123,456.789');

		const val8 = BigNum.from('1000000000000', 6);
		expect(val8.prettyPrint()).to.equal('1,000,000');

		const val9 = BigNum.from('1000000000123', 6);
		expect(val9.prettyPrint()).to.equal('1,000,000.000123');

		const val10 = BigNum.from('100000000000', 6);
		expect(val10.prettyPrint(true)).to.equal('100,000');
	});

	it('can round up and down', () => {
		const val1 = BigNum.from('1234', 1);
		expect(val1.toRounded(3).toString()).to.equal('1230');

		const val2 = BigNum.from('1236', 1);
		expect(val2.toRounded(3).toString()).to.equal('1240');

		const val3 = BigNum.from('123456789', 5);
		expect(val3.toRounded(4).print()).to.equal('1235.00000');

		const val4 = BigNum.from('123456789', 5);
		expect(val4.toRounded(3).print()).to.equal('1230.00000');

		const val5 = BigNum.from('123000000', 5);
		expect(val5.toRounded(3).print()).to.equal('1230.00000');

		const val6 = BigNum.from('0', 5);
		expect(val6.toRounded(3).print()).to.equal('0.00000');
	});

	it('test numberToSafeBN', async () => {
		expect(
			numberToSafeBN(32445073.479281776, BASE_PRECISION).toString()
		).to.equal(new BN('32445073000000000').toString());
		expect(
			// eslint-disable-next-line @typescript-eslint/no-loss-of-precision
			numberToSafeBN(9999999999111111111, BASE_PRECISION).toString()
		).to.equal(new BN('9999999999111110000000000000').toString());
		expect(numberToSafeBN(123, BASE_PRECISION).toString()).to.equal(
			new BN('123000000000').toString()
		);
	});
});
