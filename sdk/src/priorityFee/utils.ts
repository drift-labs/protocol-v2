import { assert } from "../assert/assert";

export const assertSamplesDescending = (samples: { slot: number; prioritizationFee: number }[]) => {
    assert(samples.length > 1 ? (samples[0].slot > samples[1].slot) : true, 'Expected priority fee samples in descending order');
};