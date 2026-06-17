import { FastifyReply, FastifyRequest } from 'fastify';

export const futureDateValidation = async (request: FastifyRequest, reply: FastifyReply) => {
	const isValidDate = (year: number, month: number, day?: number): boolean => {
		if (day === undefined) {
			return month >= 1 && month <= 12;
		}
		const date = new Date(year, month - 1, day);

		return (
			date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
		);
	};

	const isFutureDate = (year: number, month: number, day?: number): boolean => {
		const inputDate = new Date(year, month - 1, day || 1);
		const currentDate = new Date();

		if (day === undefined) {
			return (
				inputDate.getFullYear() > currentDate.getFullYear() ||
				(inputDate.getFullYear() === currentDate.getFullYear() &&
					inputDate.getMonth() > currentDate.getMonth())
			);
		}

		currentDate.setHours(23, 59, 59, 999);
		return inputDate > currentDate;
	};

	if (request.url) {
		const { year, month, day } = request.params as {
			year: string;
			month: string;
			day?: string;
		};

		const yearNum = parseInt(year);
		const monthNum = parseInt(month);
		const dayNum = day ? parseInt(day) : undefined;

		if (yearNum && monthNum) {
			if (!isValidDate(yearNum, monthNum, dayNum)) {
				reply.code(400).send({ error: 'ValidationError', message: 'Invalid date' });
				return;
			}

			if (isFutureDate(yearNum, monthNum, dayNum)) {
				reply.code(400).send({
					error: 'ValidationError',
					message: 'The date cannot be in the future',
				});
				return;
			}
		}
	}
};
