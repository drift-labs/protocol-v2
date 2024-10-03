// scripts/postbuild.js
const fs = require('fs');
const path = require('path');

const environment = process.argv[2]; // 'server' or 'client'

const isomorphicPackages = [
    'grpc'
]

isomorphicPackages.forEach(package => {
    const isomorphPath = path.join(__dirname, '..', 'lib', 'isomorphic', package+'.js');
    const content = `
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = require('./${package}.${environment}').default;
    `;
    
    fs.writeFileSync(isomorphPath, content);
    console.log(`Generated isomorphic ${package} for ${environment} environment`);
});