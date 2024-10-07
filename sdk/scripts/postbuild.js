// scripts/postbuild.js
const fs = require('fs');
const path = require('path');

const environment = process.argv[2]; // 'server' or 'client'

const isomorphicPackages = [
    'grpc'
]

isomorphicPackages.forEach(package => {
    const isomorphPath = path.join(__dirname, '..', 'lib', 'isomorphic', package+'.js');
    const targetPath = path.join(__dirname, '..', 'lib', 'isomorphic', `${package}.${environment}.js`);
    
    try {
        const content = fs.readFileSync(targetPath, 'utf8');
        fs.writeFileSync(isomorphPath, content);
        console.log(`Copied content from ${targetPath} to ${isomorphPath}`);
    } catch (error) {
        console.error(`Error processing ${package}: ${error.message}`);
    }
});