// Bundles the realtime-archiver Lambda handlers into single-file CJS bundles for
// zip-based deployment (velocity OpenTofu stack 10-realtime-archiver). The drift
// CDK bundled these on the fly via NodejsFunction; here CI runs this config and
// zips each output to dist-lambda/<handler>.zip, then uploads to the
// lambda-artifacts bucket.
//
// @triton-one/yellowstone-grpc and helius-laserstream are pulled transitively by
// the @backend/* + @velocity-exchange/sdk packages but never called by these
// handlers — alias them to the noop stub so we don't bundle native grpc binaries
// (mirrors NOOP_OPTIONAL_DEPS_ESBUILD_ARGS in lib/lambda-bundling.ts).

const esbuild = require('esbuild');
const esbuildPluginTsc = require('esbuild-plugin-tsc');
const path = require('path');

const noopStub = path.resolve(__dirname, '../../lib/stubs/noop.ts');

esbuild
	.build({
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'cjs',
		sourcemap: false,
		minify: false,
		treeShaking: true,
		legalComments: 'none',
		mainFields: ['source', 'main', 'module'],
		entryPoints: [
			'./src/async-slot-queue.ts',
			'./src/async-slot-ingestion.ts',
			'./src/slot-verifier.ts',
			'./src/record-ingestion.ts',
			'./src/record-ingestion-backfill.ts',
		],
		outdir: 'dist-lambda',
		alias: {
			'@triton-one/yellowstone-grpc': noopStub,
			'helius-laserstream': noopStub,
		},
		// Native addon variants — never reached once the grpc clients are stubbed,
		// kept external defensively so esbuild never tries to bundle a .node binary.
		external: ['@triton-one/yellowstone-grpc-napi-*', 'helius-laserstream-*'],
		plugins: [esbuildPluginTsc()],
	})
	.catch(() => process.exit(1));
