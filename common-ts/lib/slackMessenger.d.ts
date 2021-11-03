import { MessageAttachment } from '@slack/web-api';
export declare class SlackMessenger {
    private client;
    constructor(token: string);
    message(text: string, channel: string, attachments?: MessageAttachment[], iconEmoji?: string, username?: string): Promise<void>;
}
