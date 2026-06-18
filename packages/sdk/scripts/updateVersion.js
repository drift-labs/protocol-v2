const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');

const versionFilePath = path.join(__dirname, '..', 'VERSION');

let version = fs.readFileSync(versionFilePath, 'utf8');
version = version.replace(/\n/g, '');

const filesToReplace = [
    // sdk/src/idl/velocity.json
    path.join(__dirname, '..', 'src', 'idl', 'velocity.json'),
    // programs/velocity/Cargo.toml
    path.join(__dirname, '..', '..', 'programs', 'velocity', 'Cargo.toml'),
    // Cargo.lock
    path.join(__dirname, '..', '..', 'Cargo.lock'),
]

console.log(`Updating versions from ${version} to ${packageJson.version} in:`);
for (const file of filesToReplace) {
    console.log(`* ${file}`);
    const fileContents = fs.readFileSync(file, 'utf8');
    const newFileContents = fileContents.replace(version, packageJson.version);
    fs.writeFileSync(file, newFileContents);
}

fs.writeFileSync(versionFilePath, packageJson.version);
console.log("");