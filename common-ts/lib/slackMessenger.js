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
exports.SlackMessenger = void 0;
const web_api_1 = require("@slack/web-api");
class SlackMessenger {
    constructor(token) {
        this.client = new web_api_1.WebClient(token);
    }
    message(text, channel, attachments, iconEmoji, username) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.client.chat.postMessage({
                text,
                attachments,
                channel: channel,
                icon_emoji: iconEmoji,
                username: username,
            });
        });
    }
}
exports.SlackMessenger = SlackMessenger;
