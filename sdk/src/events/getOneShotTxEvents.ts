import { Connection, PublicKey, TransactionSignature, Finality } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { WrappedEvents } from './types';
import { oneShotFetchLogs } from './fetchLogs';
import { parseLogs } from './parse';

/**
 * Fetches and parses events for a single transaction signature
 * @param connection Solana connection
 * @param program Anchor program
 * @param programId Program ID to fetch events for
 * @param txSig Transaction signature to fetch events for
 * @param commitment Finality commitment level
 * @returns Promise containing array of parsed events, or undefined if transaction not found
 */
export async function getOneShotTxEvents(
    connection: Connection,
    program: Program,
    programId: PublicKey,
    txSig: TransactionSignature,
    commitment: Finality = 'confirmed'
): Promise<WrappedEvents | undefined> {
    try {
        // Fetch the transaction logs
        const response = await oneShotFetchLogs(
            connection,
            programId,
            commitment,
            txSig
        );

        if (!response || response.transactionLogs.length === 0) {
            return undefined;
        }

        const txLog = response.transactionLogs[0];
        
        // Parse the events
        const events = parseLogs(program, txLog.logs);
        const records: WrappedEvents = [];

        let runningEventIndex = 0;
        for (const event of events) {
            event.data.txSig = txLog.txSig;
            event.data.slot = txLog.slot;
            event.data.eventType = event.name;
            event.data.txSigIndex = runningEventIndex;
            // @ts-ignore
            records.push(event.data);
            runningEventIndex++;
        }

        return records;
    } catch (e) {
        console.error(`Error fetching events for tx ${txSig}:`, e);
        return undefined;
    }
} 