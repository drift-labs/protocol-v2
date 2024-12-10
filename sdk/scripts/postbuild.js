// scripts/postbuild.js
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const forceEnv = yargs(hideBin(process.argv))
	.option('force-env', {
		type: 'string',
		description: 'Specify environment to force (node or browser)',
		choices: ['node', 'browser']
	})
	.argv?.forceEnv;

const isomorphicPackages = ['grpc'];
const environments = ['node', 'browser'];

environments.forEach((environment) => {
	console.log(`Running ${environment} environment postbuild script`);
	console.log(``);

	isomorphicPackages.forEach((package) => {
		const isomorphPath = path.join(
			__dirname,
			'..',
			'lib',
			environment,
			'isomorphic',
			package + '.js'
		);

		const targetEnv = forceEnv ? forceEnv : environment;

		const targetPath = path.join(
			__dirname,
			'..',
			'lib',
			environment,
			'isomorphic',
			`${package}.${targetEnv}.js`
		);

		try {
			const content = fs.readFileSync(targetPath, 'utf8');
			fs.writeFileSync(isomorphPath, content);
		} catch (error) {
			console.error(
				`Error processing isomophic package : ${package} :: ${error.message}`
			);
		}

		// Delete other environment files for safety
		environments.forEach((otherEnvironment) => {
			if (otherEnvironment === environment) {
				return;
			}

			const otherTargetFiles = [
				`${package}.${otherEnvironment}.js`,
				`${package}.${otherEnvironment}.d.ts`,
			];

			for (const otherTargetFile of otherTargetFiles) {
				const otherTargetPath = path.join(
					__dirname,
					'..',
					'lib',
					environment,
					'isomorphic',
					otherTargetFile
				);

				if (fs.existsSync(otherTargetPath)) {
					fs.unlinkSync(otherTargetPath);
				}
			}
		});
	});
});
