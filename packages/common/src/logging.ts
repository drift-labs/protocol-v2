import * as winston from 'winston';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const APP_NAME = process.env.APP_NAME || null;
const APP_STAGE = process.env.APP_STAGE || null;

export class WinstonSlackLogger {
	private logger: winston.Logger;
	private messageQueue: Map<string, number> = new Map();
	private batchTimer: NodeJS.Timeout | null = null;

	constructor() {
		const consoleFormat = winston.format.printf(({ level, message, timestamp }) => {
			return `${timestamp} [${level}]: ${message}`;
		});

		this.logger = winston.createLogger({
			level: 'info',
			format: winston.format.combine(
				winston.format.timestamp(),
				winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] })
			),
			transports: [
				new winston.transports.Console({
					format: winston.format.combine(
						winston.format.colorize(),
						winston.format.timestamp(),
						consoleFormat
					),
				}),
			],
		});
	}

	private async flushMessages() {
		if (this.messageQueue.size === 0) return;

		const messages = Array.from(this.messageQueue.entries()).map(([msg, count]) =>
			count > 1 ? `${msg} (x${count})` : msg
		);

		this.messageQueue.clear();
		this.batchTimer = null;

		const text =
			messages.length === 1
				? messages[0]
				: `Batched ${messages.length} unique messages:\n${messages.join('\n')}`;

		await this.sendToSlack(text);
	}

	private queueMessage(message: string) {
		const currentCount = this.messageQueue.get(message) || 0;
		this.messageQueue.set(message, currentCount + 1);

		// Skip the deferred Slack flush under jest: the timer would fire ~5s later,
		// after the test that logged has torn down, which trips jest's "Cannot log
		// after tests are done" and fails an otherwise-green run with exit 1. There's
		// no SLACK_WEBHOOK_URL in tests anyway, so the flush would be a no-op.
		if (!this.batchTimer && !process.env.JEST_WORKER_ID) {
			this.batchTimer = setTimeout(() => this.flushMessages(), 5000);
			// A fire-and-forget Slack batch flush must never keep the process alive.
			this.batchTimer.unref?.();
		}

		if (this.messageQueue.size >= 10) {
			this.flushMessages();
		}
	}

	private async sendToSlack(message: string) {
		if (!SLACK_WEBHOOK_URL) {
			console.warn('SLACK_WEBHOOK_URL not set. Cannot send message to Slack.');
			return;
		}
		try {
			await fetch(SLACK_WEBHOOK_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: message }),
			});
		} catch (error) {
			// Do nothing
		}
	}

	info(message: string) {
		this.logger.info(message);
	}

	async warn(message: string, sendToSlack = false) {
		this.logger.warn(message);
		if (sendToSlack) {
			this.queueMessage(`[${APP_STAGE}][${APP_NAME}][WARN]: ${message}`);
		}
	}

	async error(message: string) {
		this.logger.error(message);
		this.queueMessage(`[${APP_STAGE}][${APP_NAME}][ERROR]: ${message}`);
	}

	async flush() {
		await this.flushMessages();
	}
}

export const logger = new WinstonSlackLogger();
