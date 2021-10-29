import {PublicKey} from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";

export async function getClearingHouseStatePublicKeyAndNonce(programId: PublicKey): Promise<[PublicKey, number]> {
    return anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from(anchor.utils.bytes.utf8.encode('clearing_house'))],
        programId
    );
}

export async function getClearingHouseStatePublicKey(programId: PublicKey): Promise<PublicKey> {
    return (await getClearingHouseStatePublicKeyAndNonce(programId))[0];
}

export async function getUserPublicKeyAndNonce(
    programId: PublicKey,
    userAuthorityPublicKey: PublicKey
): Promise<[PublicKey, number]> {
    return anchor.web3.PublicKey.findProgramAddress(
        [
            Buffer.from(anchor.utils.bytes.utf8.encode('user')),
            userAuthorityPublicKey.toBuffer(),
        ],
        programId
    );
}

export async function getUserPublicKey(
    programId: PublicKey,
    userAuthorityPublicKey: PublicKey
): Promise<PublicKey> {
    return (await getUserPublicKeyAndNonce(programId, userAuthorityPublicKey))[0];
}