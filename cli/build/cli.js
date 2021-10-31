#!/usr/bin/env node
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadKeypair = void 0;
const commander_1 = require("commander");
const os_1 = __importDefault(require("os"));
const fs_1 = __importDefault(require("fs"));
const loglevel_1 = __importDefault(require("loglevel"));
const sdk_1 = require("@moet/sdk");
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@project-serum/anchor");
loglevel_1.default.setLevel(loglevel_1.default.levels.INFO);
function commandWithDefaultOption(commandName) {
    return commander_1.program
        .command(commandName)
        .option('-e, --env <env>', 'environment e.g devnet, mainnet-beta')
        .option('-k, --keypair <path>', 'Solana wallet')
        .option('-u, --url <url>', 'rpc url e.g. https://api.devnet.solana.com');
}
function loadKeypair(keypairPath) {
    if (!keypairPath || keypairPath == '') {
        throw new Error('Keypair is required!');
    }
    const loaded = web3_js_1.Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs_1.default.readFileSync(keypairPath).toString())));
    loglevel_1.default.info(`wallet public key: ${loaded.publicKey}`);
    return loaded;
}
exports.loadKeypair = loadKeypair;
function adminFromOptions(options) {
    let { env, keypair, url } = options;
    const config = getConfig();
    if (!env) {
        env = config.env;
    }
    loglevel_1.default.info(`env: ${env}`);
    const sdkConfig = sdk_1.initialize({ env: env });
    if (!url) {
        url = config.url;
    }
    loglevel_1.default.info(`url: ${url}`);
    const connection = new web3_js_1.Connection(url);
    if (!keypair) {
        keypair = config.keypair;
    }
    const wallet = new anchor_1.Wallet(loadKeypair(keypair));
    return sdk_1.Admin.from(connection, wallet, new web3_js_1.PublicKey(sdkConfig.CLEARING_HOUSE_PROGRAM_ID));
}
function wrapActionInSubscribeUnsubscribe(options, action) {
    return __awaiter(this, void 0, void 0, function* () {
        const admin = adminFromOptions(options);
        loglevel_1.default.info(`ClearingHouse subscribing`);
        yield admin.subscribe();
        loglevel_1.default.info(`ClearingHouse subscribed`);
        try {
            yield action(admin);
        }
        catch (e) {
            loglevel_1.default.error(e);
        }
        loglevel_1.default.info(`ClearingHouse unsubscribing`);
        yield admin.unsubscribe();
        loglevel_1.default.info(`ClearingHouse unsubscribed`);
    });
}
commandWithDefaultOption('initialize')
    .argument('<collateral mint>', 'The collateral mint')
    .argument('<admin controls prices>', 'Whether the admin should control prices')
    .action((collateralMint, adminControlsPrices, options) => __awaiter(void 0, void 0, void 0, function* () {
    yield wrapActionInSubscribeUnsubscribe(options, (admin) => __awaiter(void 0, void 0, void 0, function* () {
        loglevel_1.default.info(`collateralMint: ${collateralMint}`);
        loglevel_1.default.info(`adminControlsPrices: ${adminControlsPrices}`);
        const collateralMintPublicKey = new web3_js_1.PublicKey(collateralMint);
        loglevel_1.default.info(`ClearingHouse initializing`);
        yield admin.initialize(collateralMintPublicKey, adminControlsPrices);
    }));
}));
function getConfigFileDir() {
    return os_1.default.homedir() + `/.config/drift-v1`;
}
function getConfigFilePath() {
    return `${getConfigFileDir()}/config.json`;
}
function getConfig() {
    if (!fs_1.default.existsSync(getConfigFilePath())) {
        console.error('drfit-v1 config does not exit. Run `drift-v1 config init`');
        return;
    }
    return JSON.parse(fs_1.default.readFileSync(getConfigFilePath(), 'utf8'));
}
const config = commander_1.program.command('config');
config.command('init').action(() => __awaiter(void 0, void 0, void 0, function* () {
    const defaultConfig = {
        env: 'devnet',
        url: 'https://api.devnet.solana.com',
        keypair: `${os_1.default.homedir()}/.config/solana/id.json`,
    };
    const dir = getConfigFileDir();
    if (!fs_1.default.existsSync(getConfigFileDir())) {
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
    fs_1.default.writeFileSync(getConfigFilePath(), JSON.stringify(defaultConfig));
}));
config
    .command('set')
    .argument('<key>', 'the config key e.g. env, url, keypair')
    .argument('<value>')
    .action((key, value) => __awaiter(void 0, void 0, void 0, function* () {
    if (key !== 'env' && key !== 'url' && key !== 'keypair') {
        console.error(`Key must be env, url or keypair`);
        return;
    }
    const config = JSON.parse(fs_1.default.readFileSync(getConfigFilePath(), 'utf8'));
    config[key] = value;
    fs_1.default.writeFileSync(getConfigFilePath(), JSON.stringify(config));
}));
config.command('get').action(() => __awaiter(void 0, void 0, void 0, function* () {
    const config = getConfig();
    console.log(JSON.stringify(config, null, 4));
}));
commander_1.program.parse(process.argv);
