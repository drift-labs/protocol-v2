// Shared jest preset for all workspace packages with `*.test.ts` suites.
// Each package's jest.config.cjs re-exports this so test tooling lives in one
// place (single root install provides jest/ts-jest/@types/jest).
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	moduleFileExtensions: ['ts', 'js'],
	transform: {
		'^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
	},
	testMatch: ['**/*.test.ts'],
};
