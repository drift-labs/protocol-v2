#!/usr/bin/env node
// Rewrite the local file:../sdk dep to a real semver range based on the
// SDK's current version, just before `npm publish`. The committed
// package.json stays on file:../sdk so monorepo dev works without a
// workspace setup.
//
// Run from `cli-admin/`. Pair with `scripts/restore-publish.js` post-publish.

const fs = require('fs');
const path = require('path');

const cliPkgPath = path.join(__dirname, '..', 'package.json');
const sdkPkgPath = path.join(__dirname, '..', '..', 'sdk', 'package.json');

const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf-8'));
const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, 'utf-8'));

const sdkVersion = sdkPkg.version;
if (!sdkVersion) {
	console.error('[prepare-publish] sdk/package.json has no version');
	process.exit(1);
}

// Save current state so the post-publish step can restore it.
fs.writeFileSync(`${cliPkgPath}.bak`, JSON.stringify(cliPkg, null, '\t') + '\n');

// Beta/alpha versions need an exact pin (npm strips prereleases out of ^/~ ranges).
const isPrerelease = /-(alpha|beta|rc)/.test(sdkVersion);
const range = isPrerelease ? sdkVersion : `^${sdkVersion}`;

cliPkg.dependencies = {
	...cliPkg.dependencies,
	'@velocity-exchange/sdk': range,
};

fs.writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, '\t') + '\n');
console.log(
	`[prepare-publish] cli-admin/package.json @velocity-exchange/sdk -> ${range}`
);
