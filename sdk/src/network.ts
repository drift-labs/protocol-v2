import { PublicKey } from '@solana/web3.js';

export enum Network {
	DEV,
	TEST,
	MAIN,
	LOCAL,
}

export const LOCAL_NET = {
	clearinghouse: new PublicKey('4s2rcQxL5FLZpEQr6amwMnmgPTR7TgM7q2LUGQ1pAF7P'),
	amm: new PublicKey('CWjf7bVvoVEnE82YLc52CkX8gJYZbWY348WDC5XoDgBB'),
};
