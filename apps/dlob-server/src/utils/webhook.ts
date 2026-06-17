import axios from 'axios';
require('dotenv').config();
import { logger } from './logger';

// enum for webhook type (slack, telegram, ...)
export enum WebhookType {
	Slack = 'slack',
	Discord = 'discord',
	Telegram = 'telegram',
}

export async function webhookMessage(
	message: string,
	webhookUrl?: string,
	prefix?: string,
	webhookType?: WebhookType
): Promise<void> {
	if (process.env.WEBHOOK_TYPE) {
		webhookType = process.env.WEBHOOK_TYPE as WebhookType;
	}
	if (!webhookType) {
		webhookType = WebhookType.Discord;
	}
	if (webhookUrl || process.env.WEBHOOK_URL) {
		const webhook = webhookUrl || process.env.WEBHOOK_URL;
		const fullMessage = prefix ? prefix + message : message;
		if (fullMessage && webhook) {
			try {
				let data;
				switch (webhookType) {
					case WebhookType.Slack:
						data = {
							text: fullMessage,
						};
						break;
					case WebhookType.Discord:
						data = {
							content: fullMessage,
						};
						break;
					case WebhookType.Telegram:
						data = {
							text: fullMessage,
						};
						break;
					default:
						logger.error(`webhookMessage: unknown webhookType: ${webhookType}`);
						return;
				}

				await axios.post(webhook, data);
			} catch (err) {
				logger.error('webhook error', err);
			}
		}
	}
}
