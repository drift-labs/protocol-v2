module.exports = {
	root: true,
	parser: '@typescript-eslint/parser',
	parserOptions: {
		ecmaFeatures: { jsx: true },
	},
	env: {
		browser: true,
		node: true,
	},
	ignorePatterns: ['**/lib'],
	extends: [
		'eslint:recommended',
		'plugin:@typescript-eslint/eslint-recommended',
		'plugin:@typescript-eslint/recommended',
		'plugin:prettier/recommended',
	],
	rules: {
		// Include .prettierrc.js rules
		'prettier/prettier': ['error', {}, { usePrettierrc: true }],
		'@typescript-eslint/explicit-function-return-type': 'off',
		'@typescript-eslint/ban-ts-ignore': 'off',
		'@typescript-eslint/no-explicit-any': 'off',
	},
	settings: {
		react: {
			version: 'detect',
		},
	},
};
