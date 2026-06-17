// Shared jest preset for the `apps/*` suites.
//
// Apps use @swc/jest (not the ts-jest base preset the @backend/* libs use). The
// app suites were authored against swc's transform semantics: they rely on
// `jest.mock` factory hoisting and must NOT type-check at run time (the app
// sources are not strictly type-clean against the vendored SDK types). ts-jest
// fails both ways — `isolatedModules: true` skips mock hoisting, and
// `isolatedModules: false` blocks on type errors — so the apps stay on swc to
// match how they were originally tested in infrastructure-v3.
module.exports = {
	testEnvironment: 'node',
	moduleFileExtensions: ['ts', 'js', 'json', 'node'],
	clearMocks: true,
	transform: {
		'^.+\\.(t|j)s$': ['@swc/jest'],
	},
	testMatch: ['**/*.test.ts'],
	setupFilesAfterEnv: [require.resolve('./jest.setup.app.ts')],
};
