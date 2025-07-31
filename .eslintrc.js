module.exports = {
	"root": true,
	"parser": "@typescript-eslint/parser",
	"env": {
		"browser": true,
		"node": true
	},
	"ignorePatterns": ["**/lib", "**/node_modules", "migrations"],
	"plugins": [],
	"extends": [
		"eslint:recommended",
		"plugin:@typescript-eslint/eslint-recommended",
		"plugin:@typescript-eslint/recommended"
	],
	"rules": {
		"@typescript-eslint/explicit-function-return-type": "off",
		"@typescript-eslint/ban-ts-ignore": "off",
		"@typescript-eslint/ban-ts-comment": "off",
		"@typescript-eslint/no-explicit-any": "off",
		"@typescript-eslint/no-unused-vars": [
			2,
			{
				"argsIgnorePattern": "^_",
				"varsIgnorePattern": "^_"
			}
		],
		"@typescript-eslint/no-var-requires": 0,
		"@typescript-eslint/no-empty-function": 0,
		"no-mixed-spaces-and-tabs": [2, "smart-tabs"],
		"no-prototype-builtins": "off",
		"semi": 2,
		"no-restricted-imports": [
			"error",
			{
				"patterns": [
					{
						// Restrict importing BN from bn.js
						"group": ["bn.js"],
						"message": "Import BN from @drift-labs/sdk instead",
					},
					{
						// Prevent imports from index files within the same package
						group: [
							'**/index',
							'**/index.ts',
						],
						message:
							'Do not import from index file within the same package. Import directly from source files instead. This prevents barrel imports.',
					},
				],
			},
		],
	}
};
