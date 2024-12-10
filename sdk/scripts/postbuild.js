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

		// We want to overwrite the base isomorphic files (the "target" files) with the concrete implementation code and definition files (the "source" files).

		const isomorphicFolderPath = path.join(
			__dirname,
			'..',
			'lib',
			environment,
			'isomorphic'
		);

		const targetEnv = forceEnv ? forceEnv : environment;

		const filesToSwap = [
			{
				source: `${package}.${targetEnv}.js`,
				target: `${package}.js`,
			},
			{
				source: `${package}.${targetEnv}.d.ts`,
				target: `${package}.d.ts`,
			},
		];

		for (const file of filesToSwap) {
			const sourcePath = path.join(
				isomorphicFolderPath,
				file.source
			);

			const targetPath = path.join(
				isomorphicFolderPath,
				file.target
			);

			try {
				const sourceContent = fs.readFileSync(sourcePath, 'utf8');
				fs.writeFileSync(targetPath, sourceContent);
			} catch (error) {
				console.error(
					`Error processing isomophic package : ${package} :: ${error.message}`
				);
			}
		}

		// Delete other environment files for safety
		environments.forEach((otherEnvironment) => {
			if (otherEnvironment === targetEnv) {
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
