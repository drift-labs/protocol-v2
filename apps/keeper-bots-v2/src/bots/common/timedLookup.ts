import CacheableLookup from 'cacheable-lookup';

const cacheable = new CacheableLookup();

function hrtimeMs() {
	const [s, ns] = process.hrtime();
	return s * 1e3 + ns / 1e6;
}

export function timedCacheableLookup(
	hostname: string,
	options: any,
	callback: (
		err: NodeJS.ErrnoException | null,
		address: string,
		family: number
	) => void
) {
	const start = hrtimeMs();

	// Use cacheable lookup instead of direct dns.lookup
	//@ts-ignore
	cacheable.lookup(hostname, options, (err, address, family) => {
		console.debug(`Cached Lookup: ${hostname}: ${hrtimeMs() - start}ms`);
		callback(err, address, family);
	});
}
