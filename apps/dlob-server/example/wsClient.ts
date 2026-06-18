import WebSocket from 'ws';
// const ws = new WebSocket('wss://dlob.drift.trade/ws');
const ws = new WebSocket('http://localhost:3000/ws');
import { sleep } from '../src/utils/utils';

ws.on('open', async () => {
  console.log('Connected to the server');

  // Subscribe and unsubscribe to orderbook channels
  ws.send(JSON.stringify({ type: 'subscribe', marketType: 'perp', channel: 'orderbook', market: 'SOL-PERP' }));
  ws.send(JSON.stringify({ type: 'subscribe', marketType: 'perp', channel: 'orderbook', market: 'INJ-PERP' }));
  ws.send(JSON.stringify({ type: 'subscribe', marketType: 'perp', channel: 'orderbook', market: 'BTC-PERP' }));
  ws.send(JSON.stringify({ type: 'subscribe', marketType: 'spot', channel: 'orderbook', market: 'SOL' }));
  await sleep(5000);
  
  // ws.send(JSON.stringify({ type: 'unsubscribe', marketType: 'perp', channel: 'orderbook', market: 'SOL-PERP' }));
  console.log("####################");


  // Subscribe to trades data
  ws.send(JSON.stringify({ type: 'subscribe', marketType: 'perp', channel: 'trades', market: 'SOL-PERP' }));
  ws.send(JSON.stringify({ type: 'subscribe', marketType: 'spot', channel: 'trades', market: 'SOL' }));
  await sleep(5000);
  
  // ws.send(JSON.stringify({ type: 'unsubscribe', marketType: 'perp', channel: 'trades', market: 'SOL-PERP' }));
  console.log("####################");
});

ws.on('message', (data: WebSocket.Data) => {
  try {
    const message = JSON.parse(data.toString());
    if (!message.channel) {
      console.log(`Received data: ${JSON.stringify(message)}`);
      return;
    }
    console.log(`Received data from channel: ${JSON.stringify(message.channel)}`);
    // book and trades data is in message.data
  } catch (e) {
    console.error('Invalid message:', data);
  }
});

ws.on('close', () => {
  console.log('Disconnected from the server');
});

ws.on('error', (error: Error) => {
  console.error('WebSocket error:', error);
});
