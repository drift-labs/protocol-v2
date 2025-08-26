/**
 * for anon Oct 7, 2024
 *
 *   const userStatsMap = new UserStatsMap(driftClient, new BulkAccountLoader(driftClient.connection, 'processed', 0));
 */

import { Connection, Keypair } from "@solana/web3.js";
import { BulkAccountLoader, DriftClient, PublicKey, UserMap, UserStatsMap } from "../../src";
import { Wallet } from "@coral-xyz/anchor";
import { ReferrerMap } from "../../src/userMap/referrerMap";

const main = async () => {
	const rpcEndpoint = 'https://drift-cranking.rpcpool.com/f1ead98714b94a67f82203cce918';
	const connection = new Connection(rpcEndpoint, 'confirmed');
	const driftClient = new DriftClient({
		connection,
		wallet: new Wallet(Keypair.generate()),
	});

	const userMap = new UserMap({
		driftClient,
		subscriptionConfig: {
			type: 'polling',
			frequency: 1000,
		},
		skipInitialLoad: false,
		includeIdle: false,
	});
	const start = Date.now();
	console.log('subscribing usermap...');
	await userMap.subscribe();
	const end = Date.now();
	console.log(`subscribed in ${end - start}ms`);

	const startUserStatsMap = Date.now();
	const userStatsMap = new UserStatsMap(driftClient);
	const referrerMap = new ReferrerMap(driftClient);

	const usermapstart = Date.now();
	const auths = userMap.getUniqueAuthorities();
	await userStatsMap.sync(auths);
	const usermapend = Date.now();
	console.log(`got ${auths.length} authorities in ${usermapend - usermapstart}ms, userstatsmap synced`);

	// const u0 = await userStatsMap.mustGet('taytayopCMREJjXAAJP7GTFkqi55sDtNXAnBfPAvtU3');
	// // console.log(u0);
	// console.log(u0.getReferrerInfo());

	// const auths = userMap.getUniqueAuthorities();
	// console.log(`got ${auths.length} authorities`);
	// auths = auths.filter(a => a.toString() !== '7651tUHQDSWHnKG4PJmdS9q6cPn5x9N57ZKAYa9q3VPE');
	// console.log(`filtered auths to ${auths.length} authorities`);

	console.log('fetching 7651 before sub...');
	console.log(await referrerMap.mustGet('7651tUHQDSWHnKG4PJmdS9q6cPn5x9N57ZKAYa9q3VPE'));

	await referrerMap.subscribe();
	const endUserStatsMap = Date.now();
	console.log(`referrermap subscribed in ${endUserStatsMap - startUserStatsMap}ms`);
	// await userStatsMap.sync(auths);
	console.log(`referrerMap size: ${referrerMap.size()}`);

	console.log('fetching taytay...');
	const u2 = await userStatsMap.mustGet('taytayopCMREJjXAAJP7GTFkqi55sDtNXAnBfPAvtU3');
	console.log(u2.getReferrerInfo());
	console.log(referrerMap.get('taytayopCMREJjXAAJP7GTFkqi55sDtNXAnBfPAvtU3'));

	console.log('fetching 7651...');
	const u = await userStatsMap.mustGet('7651tUHQDSWHnKG4PJmdS9q6cPn5x9N57ZKAYa9q3VPE');
	console.log(u.getReferrerInfo());
	console.log(referrerMap.get('7651tUHQDSWHnKG4PJmdS9q6cPn5x9N57ZKAYa9q3VPE'));

	console.log('fetching 7651t25y9orUttNi2nvd7W3QKuGA9RdAY6E2Pp2BPAAC...');
	const u3 = await userStatsMap.mustGet('7651t25y9orUttNi2nvd7W3QKuGA9RdAY6E2Pp2BPAAC');
	console.log(u3.getReferrerInfo());
	console.log(referrerMap.get('7651t25y9orUttNi2nvd7W3QKuGA9RdAY6E2Pp2BPAAC'));
};

main();
