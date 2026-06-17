const esbuild = require('esbuild');
const esbuildPluginTsc = require('esbuild-plugin-tsc');

const commonConfig = {
	bundle: true,
	platform: 'node',
	target: 'node20',
	sourcemap: false,
	minify: false,
	treeShaking: true,
	legalComments: 'none',
	metafile: true,
	format: 'cjs',
	mainFields: ['source', 'main', 'module'],
	// Native bindings pulled in transitively via `@velocity-exchange/vaults-sdk`
	// (which re-exports the gRPC + laserstream clients). Keep them external so
	// the runtime resolves them from node_modules instead of the bundle (where
	// esbuild has no `.node` loader).
	external: [
		'bigint-buffer',
		'@triton-one/yellowstone-grpc',
		'@triton-one/yellowstone-grpc-napi-*',
		'helius-laserstream',
		'helius-laserstream-*',
	],
	plugins: [esbuildPluginTsc()],
	// Resolve the bundled Drift IDL JSON.
	loader: { '.json': 'json' },
};

(async () => {
	await esbuild.build({
		...commonConfig,
		entryPoints: ['./src/index.ts'],
		outdir: 'dist',
	});
})().catch(() => process.exit(1));
