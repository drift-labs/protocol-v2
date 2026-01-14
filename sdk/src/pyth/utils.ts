import { PublicKey } from '@solana/web3.js';

export const getGuardianSetPda = (
	guardianSetIndex: number,
	wormholeProgramId: PublicKey
) => {
	const guardianSetIndexBuf = Buffer.alloc(4);
	guardianSetIndexBuf.writeUInt32BE(guardianSetIndex, 0);
	return PublicKey.findProgramAddressSync(
		[Buffer.from('GuardianSet'), guardianSetIndexBuf],
		wormholeProgramId
	)[0];
};
