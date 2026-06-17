// Bundles the aggregator-api Lambda handlers into single-file CJS bundles for
// zip-based deployment (velocity OpenTofu stack 16-aggregator). The drift CDK
// bundled these on the fly via NodejsFunction; here CI runs this config and
// zips each output to dist-lambda/<handler>.zip, then uploads to the
// lambda-artifacts bucket.
//
// Entry points are mapped to flat output names so the three handlers land
// directly in dist-lambda/ (the worker lives under src/worker/ but emits as
// user-exports.js): lambda.handler, cache-proxy.handler, user-exports.handler.
//
// @triton-one/yellowstone-grpc + helius-laserstream are pulled transitively by
// @velocity-exchange/sdk but never called by these handlers — alias them to the
// noop stub so we don't bundle native grpc binaries (mirrors the realtime-
// archiver config / NOOP_OPTIONAL_DEPS_ESBUILD_ARGS in lib/lambda-bundling.ts).
//
// @fastify/swagger-ui is kept external: it resolves static UI assets from its
// package directory at runtime, which a single-file bundle can't satisfy. app.ts
// only loads it outside Lambda (process.env.LAMBDA !== '1'), so it's never
// required at runtime in the zip. @fastify/swagger (spec only, no assets) is
// bundled normally for /openapi.json.

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
		entryPoints: {
			lambda: './src/lambda.ts',
			'cache-proxy': './src/cache-proxy.ts',
			'user-exports': './src/worker/user-exports.ts',
		},
		outdir: 'dist-lambda',
		alias: {
			'@triton-one/yellowstone-grpc': noopStub,
			'helius-laserstream': noopStub,
		},
		// Native addon variants — never reached once the grpc clients are stubbed,
		// kept external defensively so esbuild never tries to bundle a .node binary.
		external: [
			'@triton-one/yellowstone-grpc-napi-*',
			'helius-laserstream-*',
			'@fastify/swagger-ui',
		],
		plugins: [esbuildPluginTsc()],
	})
	.catch(() => process.exit(1));
