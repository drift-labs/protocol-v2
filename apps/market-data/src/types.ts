import { CronJob } from 'cron';

export interface ScheduledTask {
	name: string;
	schedule: string;
	handler: (data?: Record<string, any>) => Promise<void>;
	data?: Record<string, any>;
	isRunning: boolean;
	lastRun?: Date;
	nextRun?: Date;
	job: CronJob;
}

export interface TaskOptions {
	data?: Record<string, any>;
	runImmediately?: boolean;
}
