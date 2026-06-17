import { logger } from '@backend/common';
import { Express } from 'express';

const express = require('express');

export function createHealthServer(): Express {
	const app: Express = express();
	const port = process.env.PORT || 3000;

	app.get('/health', (_, res) => {
		return res.status(200).json({
			status: 'OK',
			timestamp: new Date().toISOString(),
		});
	});

	app.listen(port, () => {
		logger.info(`Health check server listening on port ${port}`);
	});

	return app;
}
