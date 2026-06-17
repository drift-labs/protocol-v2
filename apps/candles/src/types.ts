import * as ws from 'ws';

declare module 'ws' {
	export interface CustomWebSocket extends ws {
		isAlive: boolean;
		clientId?: string;
		subscriptions: Map<string, string>;
	}
}

export interface ClientMessage {
	type: 'subscribe' | 'unsubscribe';

	symbol?: string;
	resolution?: string;
	accountId?: string;
	authorityId?: string;

	channelType?: string;
}

interface BaseServerResponse {
	type: 'init' | 'subscription' | 'error' | string;
	message?: string;
}

interface CandleServerResponse extends BaseServerResponse {
	symbol: string;
	resolution: string;
	candle?: any;
}

interface GenericServerResponse extends BaseServerResponse {
	channelType: string;
	data?: any;
	channel?: string;
}

export type ServerResponse = CandleServerResponse | GenericServerResponse;

export interface VolumeData {
	symbol: string;
	quoteVolume: string;
	baseVolume: string;
	marketIndex: number;
	marketType: string;
}
