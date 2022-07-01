import {
	EventMap,
	EventSubscriptionOrderBy,
	EventSubscriptionOrderDirection,
	EventType,
	SortFn,
	Event,
} from './types';
import { TradeRecord } from '../types';

function clientSortAscFn(): 'less than' {
	return 'less than';
}

function clientSortDescFn(): 'greater than' {
	return 'greater than';
}

function defaultBlockchainSortFn(
	currentEvent: EventMap[EventType],
	newEvent: EventMap[EventType]
): 'less than' | 'greater than' {
	return currentEvent.slot <= newEvent.slot ? 'less than' : 'greater than';
}

function tradeRecordSortFn(
	currentEvent: Event<TradeRecord>,
	newEvent: Event<TradeRecord>
): 'less than' | 'greater than' {
	if (!currentEvent.marketIndex.eq(newEvent.marketIndex)) {
		return currentEvent.ts.lte(newEvent.ts) ? 'less than' : 'greater than';
	}

	return currentEvent.recordId.lte(newEvent.recordId)
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
