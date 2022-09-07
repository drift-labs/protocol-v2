import {
	EventMap,
	EventSubscriptionOrderBy,
	EventSubscriptionOrderDirection,
	EventType,
	SortFn,
	Event,
} from './types';
import { OrderActionRecord } from '../types';
import { ZERO } from '../index';

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

function orderActionRecordSortFn(
	currentEvent: Event<OrderActionRecord>,
	newEvent: Event<OrderActionRecord>
): 'less than' | 'greater than' {
	const currentEventMarketIndex = currentEvent.marketIndex;
	const newEventMarketIndex = newEvent.marketIndex;
	if (!currentEventMarketIndex.eq(newEventMarketIndex)) {
		return currentEvent.ts.lte(newEvent.ts) ? 'less than' : 'greater than';
	}

	if (currentEvent.fillRecordId?.gt(ZERO) && newEvent.fillRecordId?.gt(ZERO)) {
		return currentEvent.fillRecordId.lte(newEvent.fillRecordId)
			? 'less than'
			: 'greater than';
	} else {
		return currentEvent.ts.lte(newEvent.ts) ? 'less than' : 'greater than';
	}
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
		case 'OrderActionRecord':
			return orderActionRecordSortFn;
		default:
			return defaultBlockchainSortFn;
	}
}
