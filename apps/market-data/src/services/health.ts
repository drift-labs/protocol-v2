import { logger } from '@backend/common';
import { Redis } from '@backend/redis';
import { Express, Request, Response } from 'express';
import { HealthStatus, updateHealthStatus } from './metrics';
import { Scheduler } from './scheduler';

const express = require('express');

export function createHealthServer(scheduler: ReturnType<typeof Scheduler>): Express {
	const { get } = Redis();
	const app: Express = express();
	const port = process.env.PORT || 3000;

	app.get('/health', (_, res) => {
		updateHealthStatus(HealthStatus.Ok);

		return res.status(200).json({
			status: 'OK',
			timestamp: new Date().toISOString(),
		});
	});

	app.get('/api/tasks', (_, res: Response) => {
		try {
			const tasks = scheduler.getTasks();
			res.json(tasks);
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error listing tasks: ${message}`);
			res.status(500).json({ error: 'Failed to list tasks' });
		}
	});

	app.post('/api/tasks/:name/run', async (req: Request, res: Response) => {
		try {
			await scheduler.runTask(req.params.name, req.body);
			res.json({ success: true, message: `Task ${req.params.name} triggered` });
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error running task: ${message}`);
			res.status(500).json({ error: message });
		}
	});

	app.post('/api/tasks/:name/stop', (req: Request, res: Response) => {
		try {
			scheduler.stopTask(req.params.name);
			res.json({ success: true, message: `Task ${req.params.name} stopped` });
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error stopping task: ${message}`);
			res.status(500).json({ error: message });
		}
	});

	app.post('/api/tasks/:name/start', (req: Request, res: Response) => {
		try {
			scheduler.startTask(req.params.name);
			res.json({ success: true, message: `Task ${req.params.name} started` });
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error starting task: ${message}`);
			res.status(500).json({ error: message });
		}
	});

	app.get('/api/data/:key', async (req: Request, res: Response) => {
		try {
			const data = await get(req.params.key);
			if (data) {
				res.json(data);
			} else {
				res.status(404).json({ error: 'Data not found' });
			}
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error retrieving data: ${message}`);
			res.status(500).json({ error: 'Failed to retrieve data' });
		}
	});

	app.listen(port, () => {
		logger.info(`Health check server listening on port ${port}`);
	});

	return app;
}
