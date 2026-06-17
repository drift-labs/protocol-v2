import { CronJob } from 'cron';
import { Scheduler } from '../src/services/scheduler';

jest.mock('@backend/common', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	},
}));

jest.mock('cron', () => {
	return {
		CronJob: jest.fn().mockImplementation((cronTime, onTick, onComplete, start, timezone) => {
			const mockDate = new Date();

			return {
				cronTime,
				onTick,
				start: jest.fn(),
				stop: jest.fn(),
				nextDate: jest.fn().mockReturnValue({
					toJSDate: () => mockDate,
				}),
			};
		}),
	};
});

describe('Scheduler', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	describe('scheduleTask', () => {
		it('should schedule a new task correctly', () => {
			const scheduler = Scheduler();
			const handler = jest.fn().mockResolvedValue(undefined);

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler);

			const mockCronJob = CronJob as any;
			expect(mockCronJob).toHaveBeenCalledWith(
				'*/5 * * * *',
				expect.any(Function),
				null,
				true,
				'UTC'
			);
		});

		it('should throw error if task with same name already exists', () => {
			const scheduler = Scheduler();
			const handler = jest.fn().mockResolvedValue(undefined);

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler);

			expect(() => {
				scheduler.scheduleTask('test-task', '*/10 * * * *', handler);
			}).toThrow('Task with name "test-task" already exists');
		});

		it('should run task immediately if runImmediately option is set', async () => {
			const scheduler = Scheduler();
			const handler = jest.fn().mockResolvedValue(undefined);

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler, { runImmediately: true });

			await Promise.resolve();

			expect(handler).toHaveBeenCalled();
		});

		it('should provide data to the handler if specified', async () => {
			const scheduler = Scheduler();
			const handler = jest.fn().mockResolvedValue(undefined);
			const taskData = { key: 'value' };

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler, {
				data: taskData,
				runImmediately: true,
			});

			await Promise.resolve();

			expect(handler).toHaveBeenCalledWith(taskData);
		});
	});

	describe('getTasks', () => {
		it('should return all scheduled tasks', () => {
			const scheduler = Scheduler();
			const handler = jest.fn().mockResolvedValue(undefined);

			scheduler.scheduleTask('task1', '*/5 * * * *', handler);
			scheduler.scheduleTask('task2', '*/10 * * * *', handler);

			const tasks = scheduler.getTasks();

			expect(tasks).toHaveLength(2);
			expect(tasks[0].name).toBe('task1');
			expect(tasks[1].name).toBe('task2');
			expect(tasks[0].schedule).toBe('*/5 * * * *');
			expect(tasks[1].schedule).toBe('*/10 * * * *');
		});
	});

	describe('runTask', () => {
		it('should run a specified task with its data', async () => {
			const scheduler = Scheduler();
			const handler = jest.fn().mockResolvedValue(undefined);
			const taskData = { key: 'value' };

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler, { data: taskData });

			await scheduler.runTask('test-task');

			expect(handler).toHaveBeenCalledWith(taskData);
		});

		it('should merge additional data with task data', async () => {
			const scheduler = Scheduler();
			const handler = jest.fn().mockResolvedValue(undefined);
			const taskData = { key1: 'value1' };
			const additionalData = { key2: 'value2' };

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler, { data: taskData });

			await scheduler.runTask('test-task', additionalData);

			expect(handler).toHaveBeenCalledWith({
				key1: 'value1',
				key2: 'value2',
			});
		});

		it('should throw error if task does not exist', async () => {
			const scheduler = Scheduler();

			await expect(scheduler.runTask('non-existent-task')).rejects.toThrow(
				'No task found with name: non-existent-task'
			);
		});
	});

	describe('task execution', () => {
		it('should handle successful task execution correctly', async () => {
			const scheduler = Scheduler();
			const handler = jest.fn().mockResolvedValue(undefined);

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler);

			const mockCronJob = CronJob as any;
			const executionFn = mockCronJob.mock.calls[0][1];

			executionFn();

			await Promise.resolve();

			expect(handler).toHaveBeenCalled();
		});

		it('should handle errors in task execution', async () => {
			const scheduler = Scheduler();
			const error = new Error('Task failed');
			const handler = jest.fn().mockRejectedValue(error);

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler);

			const mockCronJob = CronJob as any;
			const executionFn = mockCronJob.mock.calls[0][1];

			executionFn();

			await Promise.resolve();

			expect(handler).toHaveBeenCalled();
		});
	});

	describe('hasTask', () => {
		it('should return true if task exists', () => {
			const scheduler = Scheduler();
			const handler = jest.fn();

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler);

			expect(scheduler.hasTask('test-task')).toBe(true);
		});

		it('should return false if task does not exist', () => {
			const scheduler = Scheduler();

			expect(scheduler.hasTask('non-existent-task')).toBe(false);
		});
	});

	describe('stopTask', () => {
		it('should stop a specific task and return true', () => {
			const scheduler = Scheduler();
			const handler = jest.fn();

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler);
			const result = scheduler.stopTask('test-task');

			expect(result).toBe(true);
		});

		it('should throw error if task does not exist', () => {
			const scheduler = Scheduler();

			expect(() => {
				scheduler.stopTask('non-existent-task');
			}).toThrow('No task found with name: non-existent-task');
		});
	});

	describe('startTask', () => {
		it('should start a specific task and return true', () => {
			const scheduler = Scheduler();
			const handler = jest.fn();

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler);
			const result = scheduler.startTask('test-task');

			expect(result).toBe(true);
		});

		it('should throw error if task does not exist', () => {
			const scheduler = Scheduler();

			expect(() => {
				scheduler.startTask('non-existent-task');
			}).toThrow('No task found with name: non-existent-task');
		});
	});

	describe('removeTask', () => {
		it('should remove a specific task', () => {
			const scheduler = Scheduler();
			const handler = jest.fn();

			scheduler.scheduleTask('test-task', '*/5 * * * *', handler);
			scheduler.removeTask('test-task');

			expect(scheduler.hasTask('test-task')).toBe(false);
		});

		it('should throw error if task does not exist', () => {
			const scheduler = Scheduler();

			expect(() => {
				scheduler.removeTask('non-existent-task');
			}).toThrow('No task found with name: non-existent-task');
		});
	});

	describe('stopAll', () => {
		it('should stop all tasks and return the count of stopped tasks', () => {
			const scheduler = Scheduler();
			const handler = jest.fn();

			scheduler.scheduleTask('task1', '*/5 * * * *', handler);
			scheduler.scheduleTask('task2', '*/10 * * * *', handler);

			const result = scheduler.stopAll();

			expect(result).toBe(2);
		});
	});
});
