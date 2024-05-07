import { BaseClockSubscriber } from "./baseClockSubscriber";

/**
 * PassiveClockSubscriber is a clock subscriber that does not actively update the clock. Requires updates piped in instead.
 */
export class PassiveClockSubscriber extends BaseClockSubscriber {
    constructor() {
        super();
    }

    update(slot?: number, ts?: number): void {
        if (slot !== undefined) {
            this.updateSlot(slot);
        }
        if (ts !== undefined) {
            this.updateTs(ts);
        }
    }
}