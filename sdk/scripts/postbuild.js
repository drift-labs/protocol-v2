// scripts/postbuild.js
const fs = require('fs');
const path = require('path');

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

		const targetPath = path.join(
			__dirname,
			'..',
			'lib',
			environment,
			'isomorphic',
			`${package}.${environment}.js`
		);

		try {
			const content = fs.readFileSync(targetPath, 'utf8');
			fs.writeFileSync(isomorphPath, content);
		} catch (error) {
			console.error(
				`Error processing isomophic package : ${package} :: ${error.message}`
			);
		}
	});

	// Add a console log of the environment to the main index.js file to help with debugging
	const indexFilePath = path.join(
		__dirname,
		'..',
		'lib',
		environment,
		'index.js'
	);
	const indexFileContent = fs.readFileSync(indexFilePath, 'utf8');
	const newContent = `${indexFileContent}\nconsole.log('SDK Environment: ${environment}');`;
	fs.writeFileSync(indexFilePath, newContent);
});
