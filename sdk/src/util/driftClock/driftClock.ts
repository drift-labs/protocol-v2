import { ClockSubscriber } from "./baseClockSubscriber";

/**
 * Best-Effort "clock" for tracking the on chain slot and timestamp. 
 * 
 * Can subscribe in two ways: 
 * - Self-contained subscriber that will poll the chain for the current slot and timestamp
 * - Passive subscriber which other components can pipe their updates into
 */
export class DriftClock {
    private subscriber: ClockSubscriber;
    
    constructor(
        subscriber: ClockSubscriber,
    ) {
        this.subscriber = subscriber;
    }

    get slot(): number {
        return this.subscriber.slot;
    }

    get ts(): number {
        return this.subscriber.ts;
    }
}