import {KnownBlock, MessageAttachment, WebClient} from "@slack/web-api";

export default class SlackMessenger {
    private client: WebClient;

    public constructor(token: string) {
        this.client = new WebClient(token);
    }

    public async message(text: string, channel: string, attachments?: MessageAttachment[], iconEmoji?: string, username?: string) {
        await this.client.chat.postMessage({
            text,
            attachments,
            channel: channel,
            icon_emoji: iconEmoji,
            username: username,
        });
    }
}