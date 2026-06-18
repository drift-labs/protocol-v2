// Rewrites `workspace:` protocol dependency ranges in a package's package.json
// to concrete versions, so the manifest is publishable with `npm publish`.
//
// npm — unlike bun/yarn — does not understand the `workspace:` protocol, so a
// raw `npm publish` would ship `"@velocity-exchange/sdk": "workspace:*"` and
// break every install. The npm-publish workflow runs this before publishing.
//
// `workspace:*` -> exact current workspace version; `workspace:^`/`~` -> caret/
// tilde of it; `workspace:<range>` -> that explicit range. Mirrors bun's
// documented publish rewrite, but reads versions straight from the source tree
// (deterministic) rather than from bun's resolver cache.
//
// Usage: node .github/scripts/rewrite-workspace-deps.mjs <package-dir>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2];
if (!target) {
	console.error('usage: rewrite-workspace-deps.mjs <package-dir>');
	process.exit(1);
}

// Map every workspace package name -> its current version, from packages/*.
const versions = new Map();
for (const dir of readdirSync('packages', { withFileTypes: true })) {
	if (!dir.isDirectory()) continue;
	try {
		const pj = JSON.parse(
			readFileSync(join('packages', dir.name, 'package.json'), 'utf8')
		);
		if (pj.name && pj.version) versions.set(pj.name, pj.version);
	} catch {
		// not a package dir — skip
	}
}

const resolve = (range, depName) => {
	const ver = versions.get(depName);
	if (!ver) {
		throw new Error(
			`${depName} is a workspace: dep (${range}) but no packages/* package declares that name`
		);
	}
	const spec = range.slice('workspace:'.length); // '', '*', '^', '~', or a range
	if (spec === '' || spec === '*') return ver;
	if (spec === '^') return `^${ver}`;
	if (spec === '~') return `~${ver}`;
	return spec; // explicit range pinned in the workspace: dep
};

const pjPath = join(target, 'package.json');
const pkg = JSON.parse(readFileSync(pjPath, 'utf8'));

for (const field of [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
]) {
	const deps = pkg[field];
	if (!deps) continue;
	for (const [dep, range] of Object.entries(deps)) {
		if (typeof range === 'string' && range.startsWith('workspace:')) {
			deps[dep] = resolve(range, dep);
			console.log(`rewrote ${field}.${dep}: ${range} -> ${deps[dep]}`);
		}
	}
}

writeFileSync(pjPath, JSON.stringify(pkg, null, '\t') + '\n');
