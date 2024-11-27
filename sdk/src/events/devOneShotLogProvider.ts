import {
    Connection,
    PublicKey,
    TransactionSignature,
} from '@solana/web3.js';
import { LogProvider, logProviderCallback } from './types';
import { oneShotFetchLogs } from './fetchLogs';

export class DevOneShotLogProvider implements LogProvider {
    private callback?: logProviderCallback;
    private _isSubscribed = false;

    constructor(
        private connection: Connection,
        private address: PublicKey,
    ) {}

    public async subscribe(
        callback: logProviderCallback,
        _skipHistory?: boolean
    ): Promise<boolean> {
        if (this.isSubscribed()) {
            return true;
        }

        this.callback = callback;
        this._isSubscribed = true;
        return true;
    }

    public async triggerLogs(txSig: TransactionSignature): Promise<void> {
        if (!this.isSubscribed() || !this.callback) {
            console.warn('DevOneShotLogProvider: Not subscribed or no callback registered');
            return;
        }

        try {
            // const response = await fetchLogs(
            //     this.connection,
            //     this.address,
            //     'confirmed',
            //     undefined,
            //     txSig,
            //     1
            // );

            const response = await oneShotFetchLogs(
                this.connection,
                this.address,
                'confirmed',
                txSig
            );

            if (!response || response.transactionLogs.length === 0) {
                console.warn(`DevOneShotLogProvider: No logs found for tx ${txSig}`);
                return;
            }

            for (const { txSig, slot, logs } of response.transactionLogs) {
                this.callback(txSig, slot, logs, response.mostRecentBlockTime, undefined);
            }
        } catch (e) {
            console.error('DevOneShotLogProvider: Error fetching logs');
            console.error(e);
        }
    }

    public isSubscribed(): boolean {
        return this._isSubscribed;
    }

    public async unsubscribe(): Promise<boolean> {
        this.callback = undefined;
        this._isSubscribed = false;
        return true;
    }
} 