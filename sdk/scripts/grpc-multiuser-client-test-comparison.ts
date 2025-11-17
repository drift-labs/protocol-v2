import { grpcUserAccountSubscriber } from '../src/accounts/grpcUserAccountSubscriber';
import { grpcMultiUserAccountSubscriber } from '../src/accounts/grpcMultiUserAccountSubscriber';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DRIFT_PROGRAM_ID } from '../src';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { AnchorProvider, Idl, Program } from '@coral-xyz/anchor';
import driftIDL from '../src/idl/drift.json';
import assert from 'assert';
import { Wallet } from '../src';

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;
const TOKEN = process.env.TOKEN;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;

const USER_ACCOUNT_PUBKEYS = [
  // Add user account public keys here, e.g.:
  // new PublicKey('...')
];

async function testGrpcUserAccountSubscriberV1VsV2() {
  console.log('🚀 Initializing User Account Subscriber V1 vs V2 Test...');

  if (USER_ACCOUNT_PUBKEYS.length === 0) {
    console.error('❌ No user account public keys provided. Please add some to USER_ACCOUNT_PUBKEYS array.');
    process.exit(1);
  }

  const connection = new Connection(RPC_ENDPOINT);
  const wallet = new Wallet(new Keypair());

  const programId = new PublicKey(DRIFT_PROGRAM_ID);
  const provider = new AnchorProvider(
    connection,
    // @ts-ignore
    wallet,
    {
      commitment: 'processed',
    }
  );

  const program = new Program(driftIDL as Idl, programId, provider);

  const grpcConfigs = {
    endpoint: GRPC_ENDPOINT,
    token: TOKEN,
    commitmentLevel: CommitmentLevel.PROCESSED,
    channelOptions: {
      'grpc.keepalive_time_ms': 10_000,
      'grpc.keepalive_timeout_ms': 1_000,
      'grpc.keepalive_permit_without_calls': 1,
    },
  };

  console.log(`📊 Testing ${USER_ACCOUNT_PUBKEYS.length} user accounts...`);

  // V1: Create individual subscribers for each user account
  const v1Subscribers = USER_ACCOUNT_PUBKEYS.map(
    (pubkey) =>
      new grpcUserAccountSubscriber(
        grpcConfigs,
        program,
        pubkey,
        { logResubMessages: true }
      )
  );

  // V2: Create a single multi-subscriber and get per-user interfaces
  const v2MultiSubscriber = new grpcMultiUserAccountSubscriber(
    program,
    grpcConfigs,
    { logResubMessages: true }
  );
  const v2Subscribers = USER_ACCOUNT_PUBKEYS.map((pubkey) =>
    v2MultiSubscriber.forUser(pubkey)
  );

  // Subscribe all V1 subscribers
  console.log('🔗 Subscribing V1 subscribers...');
  await Promise.all(v1Subscribers.map((sub) => sub.subscribe()));
  console.log('✅ V1 subscribers ready');

  // Subscribe all V2 subscribers
  console.log('🔗 Subscribing V2 subscribers...');
  await v2MultiSubscriber.subscribe();
  console.log('✅ V2 subscribers ready');

  const compare = () => {
    try {
      let passedTests = 0;
      let totalTests = 0;

      // Test each user account
      for (let i = 0; i < USER_ACCOUNT_PUBKEYS.length; i++) {
        const pubkey = USER_ACCOUNT_PUBKEYS[i];
        const v1Sub = v1Subscribers[i];
        const v2Sub = v2Subscribers[i];

        totalTests++;

        // 1. Test isSubscribed
        assert.strictEqual(
          v1Sub.isSubscribed,
          v2Sub.isSubscribed,
          `User ${pubkey.toBase58()}: isSubscribed should match`
        );

        // 2. Test getUserAccountAndSlot
        const v1Data = v1Sub.getUserAccountAndSlot();
        const v2Data = v2Sub.getUserAccountAndSlot();

        // Compare the user account data
        assert.deepStrictEqual(
          v1Data.data,
          v2Data.data,
          `User ${pubkey.toBase58()}: account data should match`
        );

                // Slots might differ slightly due to timing, but let's check if they're close
                const slotDiff = Math.abs(v1Data.slot - v2Data.slot);
                if (slotDiff > 10) {
                  console.warn(
                    `⚠️  User ${pubkey.toBase58()}: slot difference is ${slotDiff} (v1: ${v1Data.slot}, v2: ${v2Data.slot})`
                  );
                }
        
                passedTests++;
              }
        
              console.log(`✅ All comparisons passed (${passedTests}/${totalTests} user accounts)`);
            } catch (error) {
              console.error('❌ Comparison failed:', error);
            }
          };
        
          // Run initial comparison
          compare();
        
          // Run comparison every second to verify live updates
          const interval = setInterval(compare, 1000);
        
          const cleanup = async () => {
            clearInterval(interval);
            console.log('🧹 Cleaning up...');
            await Promise.all([
              ...v1Subscribers.map((sub) => sub.unsubscribe()),
              ...v2Subscribers.map((sub) => sub.unsubscribe()),
            ]);
            console.log('✅ Cleanup complete');
            process.exit(0);
          };
        
          process.on('SIGINT', cleanup);
          process.on('SIGTERM', cleanup);
        }
        
        testGrpcUserAccountSubscriberV1VsV2().catch(console.error);