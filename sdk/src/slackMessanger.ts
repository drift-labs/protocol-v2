import {WebClient} from "@slack/web-api";

export default class SlackMessenger {
    private client: WebClient;

    public constructor(token: string) {
        this.client = new WebClient(token);
    }

    public async message(text: string, channel: string, iconEmoji?: string, username?: string) {
        await this.client.chat.postMessage({
            text: 'gang gang',
            channel: "dev",
            icon_emoji: ":thughawk:",
            username: "thughawk",
        });
    }
}