"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const web3_js_1 = require("@solana/web3.js");
const sdk_1 = require("@drift-labs/sdk");
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        const driftConfig = sdk_1.configs['mainnet-beta'];
        const connection = new web3_js_1.Connection('https://api.mainnet-beta.solana.com');
        const driftClient = new sdk_1.DriftClient({
            connection: connection,
            wallet: new sdk_1.Wallet(new web3_js_1.Keypair()),
            programID: new web3_js_1.PublicKey(driftConfig.DRIFT_PROGRAM_ID),
            userStats: true,
            env: 'mainnet-beta',
        });
        console.log(`driftClientSubscribed: ${yield driftClient.subscribe()}`);
        const txHash = "3gvGQufckXGHrFDv4dNWEXuXKRMy3NZkKHMyFrAhLoYScaXXTGCp9vq58kWkfyJ8oDYZrz4bTyGayjUy9PKigeLS";
        const tx = yield driftClient.connection.getParsedTransaction(txHash, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
        let logIdx = 0;
        // @ts-ignore
        for (const event of driftClient.program._events._eventParser.parseLogs(tx.meta.logMessages)) {
            console.log("----------------------------------------");
            console.log(`Log ${logIdx++}`);
            console.log("----------------------------------------");
            console.log(`${JSON.stringify(event, null, 2)}`);
        }
        console.log("========================================");
        console.log("Raw transaction logs");
        console.log("========================================");
        console.log(JSON.stringify(tx.meta.logMessages, null, 2));
        process.exit(0);
    });
}
main().catch(console.error);
