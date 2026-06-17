import { logger } from '@backend/common';
import { CronJob } from 'cron';
import { ScheduledTask, TaskOptions } from '../types';

export const Scheduler = () => {
	const tasks: Map<string, ScheduledTask> = new Map();

	const scheduleTask = (
		name: string,
		schedule: string,
		handler: (data?: Record<string, any>) => Promise<void>,
		options: TaskOptions = {}
	) => {
		if (tasks.has(name)) {
			throw new Error(`Task with name "${name}" already exists`);
		}

		const wrappedHandler = async () => {
			const task = tasks.get(name);
			if (!task) return;

			if (task.isRunning) {
				logger.warn(`Task "${name}" is already running, skipping execution`);
				return;
			}

			task.isRunning = true;
			task.lastRun = new Date();

			try {
				logger.info(`Starting task: ${name}`);
				const startTime = Date.now();

				await handler(task.data);

				const duration = Date.now() - startTime;
				logger.info(`Completed task: ${name} in ${duration}ms`);
			} catch (error) {
				const { message } = error as Error;
				logger.error(`Error in task "${name}": ${message}`);
			} finally {
				const updatedTask = tasks.get(name);
				if (updatedTask) {
					updatedTask.isRunning = false;
				}
			}
		};

		const job = new CronJob(
			schedule,
			() => {
				wrappedHandler();
			},
			null,
			true,
			'UTC'
		);

		const nextRun = job.nextDate().toJSDate();

		tasks.set(name, {
			name,
			schedule,
			handler,
			data: options.data || {},
			isRunning: false,
			job,
			nextRun,
		});

		logger.info(
			`Scheduled task "${name}" with schedule: ${schedule}, next run: ${nextRun.toISOString()}`
		);

		if (options.runImmediately) {
			runTask(name).catch((error) => {
				logger.error(`Error running task "${name}" immediately: ${error.message}`);
			});
		}
	};

	const getTasks = () => {
		return Array.from(tasks.values()).map((task) => ({
			name: task.name,
			schedule: task.schedule,
			isRunning: task.isRunning,
			lastRun: task.lastRun,
			nextRun: task.nextRun,
		}));
	};

	const runTask = async (name: string, data?: Record<string, any>) => {
		const task = tasks.get(name);
		if (!task) {
			throw new Error(`No task found with name: ${name}`);
		}

		const mergedData = { ...task.data, ...(data || {}) };

		logger.info(`Manually running task: ${name}`);
		await task.handler(mergedData);
	};

	const hasTask = (name: string) => {
		return tasks.has(name);
	};

	const stopTask = (name: string) => {
		const task = tasks.get(name);
		if (!task) {
			throw new Error(`No task found with name: ${name}`);
		}

		task.job.stop();
		logger.info(`Stopped task: ${name}`);
		return true;
	};

	const startTask = (name: string) => {
		const task = tasks.get(name);
		if (!task) {
			throw new Error(`No task found with name: ${name}`);
		}
		task.job.start();
		task.nextRun = task.job.nextDate().toJSDate();
		logger.info(`Started task: ${name}, next run: ${task.nextRun?.toISOString()}`);
		return true;
	};

	const removeTask = (name: string) => {
		const task = tasks.get(name);
		if (!task) {
			throw new Error(`No task found with name: ${name}`);
		}

		task.job.stop();
		tasks.delete(name);
		logger.info(`Removed task: ${name}`);
	};

	const stopAll = () => {
		let stoppedCount = 0;
		for (const [name, task] of tasks.entries()) {
			task.job.stop();
			logger.info(`Stopped task: ${name}`);
			stoppedCount++;
		}
		return stoppedCount;
	};

	return {
		scheduleTask,
		runTask,
		getTasks,
		hasTask,
		stopTask,
		startTask,
		removeTask,
		stopAll,
	};
};
