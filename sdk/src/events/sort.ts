import {
	Event,
	EventData,
	EventMap,
	EventSubscriptionOrder,
	EventType,
	SortFn,
} from './types';

function clientSortFn(): 'before' {
	return 'before';
}

function defaultBlockchainSortFn(
	currentRecord: Event<EventType, EventData>,
	newRecord: Event<EventType, EventData>
): 'before' | 'after' {
	return currentRecord.slot <= newRecord.slot ? 'before' : 'after';
}

function tradeRecordSortFn(
	currentRecord: Event<'TradeRecord', EventMap['TradeRecord']>,
	newRecord: Event<'TradeRecord', EventMap['TradeRecord']>
): 'before' | 'after' {
	if (!currentRecord.data.marketIndex.eq(newRecord.data.marketIndex)) {
		return currentRecord.data.ts.lte(newRecord.data.ts) ? 'before' : 'after';
	}

	return currentRecord.data.recordId.lte(newRecord.data.recordId)
		? 'before'
		: 'after';
}

export function getSortFn(
	order: EventSubscriptionOrder,
	eventType: EventType
): SortFn {
	if (order === 'client') {
		return clientSortFn;
	}

	switch (eventType) {
		case 'TradeRecord':
			return tradeRecordSortFn;
		default:
			return defaultBlockchainSortFn;
	}
}
