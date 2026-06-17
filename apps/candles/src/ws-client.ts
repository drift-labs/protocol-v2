import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000/ws');

ws.on('open', async () => {
	console.log('Connected to the server');

	// ws.send(
	// 	JSON.stringify({
	// 		type: 'subscribe',
	// 		symbol: 'BTC-PERP',
	// 		resolution: '1',
	// 	})
	// );

	ws.send(
		JSON.stringify({
			type: 'subscribe',
			channelType: 'orderbook',
			symbol: 'BTC-PERP',
		})
	);

	ws.on('message', (data: WebSocket.Data) => {
		const message = JSON.parse(data.toString());
		if (message.type === 'init') {
			console.log('init', message);
		} else if (message.type === 'create') {
			console.log('create', message);
		} else if (message.type === 'update') {
			console.log('update', message);
		}
	});

	ws.on('close', () => {
		console.log('Disconnected from the server');
	});

	ws.on('error', (error: Error) => {
		console.error('WebSocket error:', error);
	});
});
