import { BaseChainClockSubscriber } from "./baseClockSubscriber";

/**
 * PassiveClockSubscriber is a clock subscriber that does not actively update the clock. Requires updates piped in instead.
 */
export class PassiveClockSubscriber extends BaseChainClockSubscriber {
    constructor() {
        super();
    }

    update(blockHeight?:number, slot?: number, ts?: number): void {
        if (blockHeight !== undefined) {
            this.updateBlockHeight(blockHeight);
        }
        if (slot !== undefined) {
            this.updateSlot(slot);
        }
        if (ts !== undefined) {
            this.updateTs(ts);
        }
    }
}