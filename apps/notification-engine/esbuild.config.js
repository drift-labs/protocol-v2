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
	external: [
		'bigint-buffer',
		'@triton-one/yellowstone-grpc',
		'@triton-one/yellowstone-grpc-napi-*',
		'helius-laserstream',
		'helius-laserstream-*',
	],
	plugins: [esbuildPluginTsc()],
};

(async () => {
	let entryPoints = ['./src/oracle-feed.ts', './src/risk-manager.ts', './src/update-stream.ts'];

	await esbuild.build({
		...commonConfig,
		entryPoints,
		outdir: 'dist',
	});
})().catch(() => process.exit(1));
