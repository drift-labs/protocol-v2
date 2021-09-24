import * as anchor from '@project-serum/anchor';

//doesn't work with import statement for some reason...
// eslint-disable-next-line @typescript-eslint/no-var-requires
const main = require('./deploy');

main(anchor.Provider.local("https://api.devnet.solana.com"));
