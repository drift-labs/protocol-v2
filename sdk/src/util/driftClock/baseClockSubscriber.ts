export interface ClockSubscriber {
    slot: number;
    ts: number;

    updateSlot(slot: number): void;
    updateTs(ts: number): void;

    update(slot?:number, ts?:number): void;
}

export class BaseClockSubscriber implements ClockSubscriber {
    private _slot: number;
    private _ts: number;

    public get slot(): number {
        return this._slot;
    }

    public get ts(): number {
        return this._ts;
    }

    constructor(slot?: number, ts?: number) {
        this._slot = slot;
        this._ts = ts;
    }

    updateSlot(slot: number): void {
        if (!this.slot || slot > this.slot) this._slot = slot;
    }

    updateTs(ts: number): void {
        if (!this.ts || ts > this.ts) this._ts = ts;
    }

    update(slot?:number, ts?:number): void {
        if (slot !== undefined) {
            this.updateSlot(slot);
        }
        if (ts !== undefined) {
            this.updateTs(ts);
        }
    }
}