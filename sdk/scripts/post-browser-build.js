// README
// This script is used to ensure that all isomorphic packages are browser compatible.
// Even if the browser build has server code (e.g. NextJS APIs), they will import the browser compatible versions of the isomorphic packages.

// scripts/postbuild.js
const fs = require('fs');
const path = require('path');

const isomorphicPackages = ['grpc'];

const BROWSER_ENVIRONMENT = 'browser';

const environments = ['node', BROWSER_ENVIRONMENT];

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

		const targetPath = path.join(
			__dirname,
			'..',
			'lib',
			environment,
			'isomorphic',
			`${package}.${BROWSER_ENVIRONMENT}.js` // force all isomorphic packages to be browser compatible
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

			const otherTargetPath = path.join(
				__dirname,
				'..',
				'lib',
				environment,
				'isomorphic',
				`${package}.${otherEnvironment}.js`
			);

			if (fs.existsSync(otherTargetPath)) {
				fs.unlinkSync(otherTargetPath);
			}
		});
	});
});
