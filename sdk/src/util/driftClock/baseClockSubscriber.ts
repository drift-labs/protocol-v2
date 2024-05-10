export interface ChainClockSubscriber {
    blockHeight: number;
    slot: number;
    ts: number;

    update(slot?:number, ts?:number): void;
}

export class BaseChainClockSubscriber {
    private _blockHeight: number;
    private _slot: number;
    private _ts: number;

    public get blockHeight(): number {
        return this._blockHeight;
    }

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

    protected updateBlockHeight(blockHeight: number): void {
        if (!this.blockHeight || blockHeight > this.blockHeight) this._blockHeight = blockHeight;
    }

    protected updateSlot(slot: number): void {
        if (!this.slot || slot > this.slot) this._slot = slot;
    }

    protected updateTs(ts: number): void {
        if (!this.ts || ts > this.ts) this._ts = ts;
    }

    update(blockHeight?:number, slot?:number, ts?:number): void {
        this.updateBlockHeight(blockHeight);
        this.updateSlot(slot);
        this.updateTs(ts);
    }
}