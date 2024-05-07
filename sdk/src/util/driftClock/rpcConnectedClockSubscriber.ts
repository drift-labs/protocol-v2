import { Connection } from "@solana/web3.js";
import { BaseClockSubscriber } from "./baseClockSubscriber";

/**
 * A clock subscriber that listens to the RPC connection and updates the clock accordingly.
 */
export class RpcConnectedClockSubscriber extends BaseClockSubscriber {
    private updateInterval: number;
    private connection: Connection;
    private subscribed = false;
    private subscriptionInterval: NodeJS.Timeout | null = null;

    constructor(connection: Connection, updateInterval: number) {
        super();
        this.connection = connection;
        this.updateInterval = updateInterval;
        this.update();
    }

    async update() {
        const slot = await this.connection.getSlot();
        this.updateSlot(slot);
        const ts = await this.connection.getBlockTime(slot);
        this.updateTs(ts);
    }

    async subscribe() {
        if (this.subscribed) {
            return;
        }
        this.subscribed = true;

        this.subscriptionInterval = setInterval(async () => {
            this.update();
        }, this.updateInterval);
    }

    async unsubscribe() {
        if (!this.subscribed) {
            return;
        }
        this.subscribed = false;

        if (this.subscriptionInterval) {
            clearInterval(this.subscriptionInterval);
            this.subscriptionInterval = null;
        }
    }

    get slot(): number {
        if (!this.subscribed) {
            throw new Error("Not subscribed to RPC connection");
        }
        return super.slot;
    }

    get ts(): number {
        if (!this.subscribed) {
            throw new Error("Not subscribed to RPC connection");
        }
        return super.ts;
    }
}