import { handleHealthCheck } from './core/metrics';

export const setupEndpoints = (core: Core) => {
	const app = core.app;

	app.get('/health', async (req, res, next) => {
		handleHealthCheck(core)(req, res, next);
	});
};
