// scripts/postbuild.js
const fs = require('fs');
const path = require('path');

const environment = process.argv[2]; // 'node' or 'browser'

const isomorphicPackages = ['grpc'];

console.log(`Running ${environment} environment postbuild script`);
console.log(``);

isomorphicPackages.forEach((package) => {
	const isomorphPath = path.join(
		__dirname,
		'..',
		'lib',
		'isomorphic',
		package + '.js'
	);

	const targetPath = path.join(
		__dirname,
		'..',
		'lib',
		'isomorphic',
		`${package}.${environment}.js`
	);

	try {
		const content = fs.readFileSync(targetPath, 'utf8');
		fs.writeFileSync(isomorphPath, content);
		console.log(
			`Copied ${environment} content from isomorphic/${package}.${environment}.js to isomorphic/${package}.js`
		);
	} catch (error) {
		console.error(`Error processing ${package}: ${error.message}`);
	}
});
