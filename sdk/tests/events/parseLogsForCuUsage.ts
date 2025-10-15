import { expect } from 'chai';
import { parseLogsForCuUsage } from '../../src/events/parse';

// if you used the '@types/mocha' method to install mocha type definitions, uncomment the following line
// import 'mocha';

describe('parseLogsForCuUsage Tests', () => {
	it('can parse single ix', () => {
		const logs = [
			'Program ComputeBudget111111111111111111111111111111 invoke [1]',
			'Program ComputeBudget111111111111111111111111111111 success',
			'Program ComputeBudget111111111111111111111111111111 invoke [1]',
			'Program ComputeBudget111111111111111111111111111111 success',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH invoke [1]',
			'Program log: Instruction: UpdateFundingRate',
			'Program log: correcting mark twap update (oracle previously invalid for 1625 seconds)',
			'Program data: Ze4o5EYuPXWjSrNoAAAAADkUAAAAAAAAZTIKAAAAAAAAAAAAAAAAAGwIAGYvdqgAAAAAAAAAAAAxpQahVMKdAAAAAAAAAAAAK0cfnMcFowAAAAAAAAAAAGUyCgAAAAAAAAAAAAAAAAAbXpy4n6WoAAAAAAAAAAAAGAAXbsHunQAAAAAAAAAAAObum9evM6MAAAAAAAAAAAAA9PA5+UYKAAAAAAAAAAAAAKhuDZ0RCgAAAAAAAAAAAABMgixcNQAAAAAAAAAAAAA9NqYKSgAAAAAAAAAAAAAA4nylcy0AAAAAAAAAAAAAAMvCAAAAAAAAAAAAAAAAAACOjAkAAAAAAET3AgAAAAAAAAAAAAAAAAAMAQAAHgA=',
			'Program data: RAP/GoVbk/6jSrNoAAAAAA0rAAAAAAAAHgBxcgEAAAAAAHFyAQAAAAAAAAAAAAAAAABxcgEAAAAAAAAAAAAAAAAAZRuYAQAAAAAAAAAAAAAAAJMNmAEAAAAAAAAAAAAAAAC0eAkAAAAAAByBCQAAAAAAWUbv4v////8ATIIsXDUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH consumed 102636 of 143817 compute units',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH success',
		];
		const cuUsage = parseLogsForCuUsage(logs);
		expect(cuUsage).to.deep.equal([
			{
				name: 'CuUsage',
				data: {
					instruction: 'UpdateFundingRate',
					cuUsage: 102636,
				},
			},
		]);
	});

	it('can parse multiple ixs', () => {
		const logs = [
			'Program ComputeBudget111111111111111111111111111111 invoke [1]',
			'Program ComputeBudget111111111111111111111111111111 success',
			'Program ComputeBudget111111111111111111111111111111 invoke [1]',
			'Program ComputeBudget111111111111111111111111111111 success',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH invoke [1]',
			'Program log: Instruction: PostPythLazerOracleUpdate',
			'Program log: Skipping new lazer update. current ts 1756622092550000 >= next ts 1756622092000000',
			'Program log: Skipping new lazer update. current ts 1756622092550000 >= next ts 1756622092000000',
			'Program log: Skipping new lazer update. current ts 1756622092550000 >= next ts 1756622092000000',
			'Program log: Price updated to 433158894',
			'Program log: Posting new lazer update. current ts 1756622079000000 < next ts 1756622092000000',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH consumed 29242 of 199700 compute units',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH success',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH invoke [1]',
			'Program log: Instruction: UpdatePerpBidAskTwap',
			'Program log: estimated_bid = None estimated_ask = None',
			'Program log: after amm bid twap = 204332308 -> 204328128 \n        ask twap = 204350474 -> 204347149 \n        ts = 1756622080 -> 1756622092',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH consumed 71006 of 170458 compute units',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH success',
		];
		const cuUsage = parseLogsForCuUsage(logs);
		expect(cuUsage).to.deep.equal([
			{
				name: 'CuUsage',
				data: {
					instruction: 'PostPythLazerOracleUpdate',
					cuUsage: 29242,
				},
			},
			{
				name: 'CuUsage',
				data: {
					instruction: 'UpdatePerpBidAskTwap',
					cuUsage: 71006,
				},
			},
		]);
	});

	it('can parse ixs with CPI (swaps)', () => {
		const logs = [
			'Program ComputeBudget111111111111111111111111111111 invoke [1]',
			'Program ComputeBudget111111111111111111111111111111 success',
			'Program ComputeBudget111111111111111111111111111111 invoke [1]',
			'Program ComputeBudget111111111111111111111111111111 success',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH invoke [1]',
			'Program log: Instruction: BeginSwap',
			'Program data: t7rLuuG7X4K7X+loAAAAAAAAoDz72UK0JwQAAAAAAAAAAMS7r8ACAAAAAAAAAAAAAAB36Aiv26cZAwAAAAAAAAAArDDOLAMAAAAAAAAAAAAAAAA1DAAUzQAAoLsNAA==',
			'Program data: t7rLuuG7X4K7X+loAAAAAAEASQcRhBUVAQAAAAAAAAAAAG3WGn8CAAAAAAAAAAAAAADBBakRTIoAAAAAAAAAAAAAFfFDwgIAAAAAAAAAAAAAAAA1DACghgEAYOMWAA==',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]',
			'Program log: Instruction: Transfer',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4645 of 1336324 compute units',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH consumed 79071 of 1399700 compute units',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH success',
			'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]',
			'Program log: Instruction: Route',
			'Program SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF invoke [2]',
			'Program data: S3VCwUhV8CXSyrcV3EtPUNCsQJvXpBqCGUobEJZVRnl5bVAAAAAAAFUFNBYAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]',
			'Program log: Instruction: Transfer',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4645 of 1255262 compute units',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]',
			'Program log: Instruction: Transfer',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4736 of 1249195 compute units',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
			'Program SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF consumed 69257 of 1311915 compute units',
			'Program SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF success',
			'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [2]',
			'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 consumed 199 of 1241147 compute units',
			'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success',
			'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 consumed 81059 of 1320629 compute units',
			'Program return: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 Z/tXxXEAAAA=',
			'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH invoke [1]',
			'Program log: Instruction: EndSwap',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]',
			'Program log: Instruction: Transfer',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4736 of 1187840 compute units',
			'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
			'Program data: ort7woo4+vG7X+loAAAAAJ1Bg8Gp9WhWrw9VRm1UiC0KW6LRC2am2mjhfd3lzm6WZ/tXxXEAAAAA6HZIFwAAAAEAAAAJdDEMAAAAANFBDwAAAAAAAAAAAAAAAAA=',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH consumed 156076 of 1239570 compute units',
			'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH success',
		];
		const cuUsage = parseLogsForCuUsage(logs);
		expect(cuUsage).to.deep.equal([
			{
				name: 'CuUsage',
				data: {
					instruction: 'BeginSwap',
					cuUsage: 79071,
				},
			},
			{
				name: 'CuUsage',
				data: {
					instruction: 'EndSwap',
					cuUsage: 156076,
				},
			},
		]);
	});
});
