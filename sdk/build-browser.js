const esbuild = require('esbuild');
const path = require('path');

async function build() {
  try {
    await esbuild.build({
      entryPoints: ['./lib/browser/index.js'],
      bundle: true,
      minify: true,
      format: 'cjs',
      platform: 'browser',
      target: ['es2020'],
      outfile: './dist/browser.min.js',
      external: [
        '@solana/web3.js',
        '@coral-xyz/anchor',
        '@coral-xyz/anchor-30',
      ],
      define: {
        'process.env.NODE_ENV': '"production"',
        'global': 'globalThis',
      },
      inject: [path.resolve(__dirname, 'esbuild-shims.js')],
      alias: {
        // Node polyfills for browser
        'crypto': 'crypto-browserify',
        'stream': 'stream-browserify',
        'path': 'path-browserify',
        'os': 'os-browserify/browser',
        'process': 'process/browser',
        'vm': 'vm-browserify',
      },
      // Ignore node-only modules
      plugins: [{
        name: 'ignore-node-modules',
        setup(build) {
          build.onResolve({ filter: /^(fs|net|dns|tls|http2)$/ }, args => {
            return { path: args.path, namespace: 'ignore-ns' };
          });
          build.onLoad({ filter: /.*/, namespace: 'ignore-ns' }, () => {
            return { contents: 'export default {}' };
          });
        },
      }],
      loader: {
        '.json': 'json',
      },
      treeShaking: true,
      sourcemap: false,
    });
    console.log('✅ Browser build complete');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

build();