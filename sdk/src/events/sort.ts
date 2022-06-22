import {
	Event,
	EventData,
	EventMap,
	EventSubscriptionOrderBy,
	EventSubscriptionOrderDirection,
	EventType,
	SortFn,
} from './types';

function clientSortAscFn(): 'less than' {
	return 'less than';
}

function clientSortDescFn(): 'greater than' {
	return 'greater than';
}

function defaultBlockchainSortFn(
	currentRecord: Event<EventType, EventData>,
	newRecord: Event<EventType, EventData>
): 'less than' | 'greater than' {
	return currentRecord.slot <= newRecord.slot ? 'less than' : 'greater than';
}

function tradeRecordSortFn(
	currentRecord: Event<'TradeRecord', EventMap['TradeRecord']>,
	newRecord: Event<'TradeRecord', EventMap['TradeRecord']>
): 'less than' | 'greater than' {
	if (!currentRecord.data.marketIndex.eq(newRecord.data.marketIndex)) {
		return currentRecord.data.ts.lte(newRecord.data.ts)
			? 'less than'
			: 'greater than';
	}

	return currentRecord.data.recordId.lte(newRecord.data.recordId)
		? 'less than'
		: 'greater than';
}

export function getSortFn(
	orderBy: EventSubscriptionOrderBy,
	orderDir: EventSubscriptionOrderDirection,
	eventType: EventType
): SortFn {
	if (orderBy === 'client') {
		return orderDir === 'asc' ? clientSortAscFn : clientSortDescFn;
	}

	switch (eventType) {
		case 'TradeRecord':
			return tradeRecordSortFn;
		default:
			return defaultBlockchainSortFn;
	}
}
