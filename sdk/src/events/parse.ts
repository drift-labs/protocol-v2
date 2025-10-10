import { Program, Event } from '@coral-xyz/anchor';
import { CuUsageEvent } from './types';

const driftProgramId = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
const PROGRAM_LOG = 'Program log: ';
const PROGRAM_INSTRUCTION = 'Program log: Instruction: ';
const PROGRAM_DATA = 'Program data: ';
const PROGRAM_LOG_START_INDEX = PROGRAM_LOG.length;
const PROGRAM_DATA_START_INDEX = PROGRAM_DATA.length;
const PROGRAM_INSTRUCTION_START_INDEX = PROGRAM_INSTRUCTION.length;

export function parseLogs(
	program: Program,
	logs: string[],
	programId = driftProgramId
): Event[] {
	const { events } = parseLogsWithRaw(program, logs, programId);
	return events;
}

export function parseLogsWithRaw(
	program: Program,
	logs: string[],
	programId = driftProgramId
): { events: Event[]; rawLogs: string[] } {
	const events = [];
	const rawLogs = [];
	const execution = new ExecutionContext();
	for (const log of logs) {
		if (log.startsWith('Log truncated')) {
			break;
		}

		const [event, newProgram, didPop] = handleLog(
			execution,
			log,
			program,
			programId
		);
		if (event) {
			events.push(event);
			rawLogs.push(log);
		}
		if (newProgram) {
			execution.push(newProgram);
		}
		if (didPop) {
			execution.pop();
		}
	}
	return { events, rawLogs };
}

function handleLog(
	execution: ExecutionContext,
	log: string,
	program: Program,
	programId = driftProgramId
): [Event | null, string | null, boolean] {
	// Executing program is drift program.
	if (execution.stack.length > 0 && execution.program() === programId) {
		return handleProgramLog(log, program, programId);
	}
	// Executing program is not drift program.
	else {
		return [null, ...handleSystemLog(log, programId)];
	}
}

// Handles logs from *drift* program.
function handleProgramLog(
	log: string,
	program: Program,
	programId = driftProgramId
): [Event | null, string | null, boolean] {
	// This is a `msg!` log or a `sol_log_data` log.
	if (log.startsWith(PROGRAM_LOG)) {
		const logStr = log.slice(PROGRAM_LOG_START_INDEX);
		const event = program.coder.events.decode(logStr);
		return [event, null, false];
	} else if (log.startsWith(PROGRAM_DATA)) {
		const logStr = log.slice(PROGRAM_DATA_START_INDEX);
		const event = program.coder.events.decode(logStr);
		return [event, null, false];
	} else {
		return [null, ...handleSystemLog(log, programId)];
	}
}

// Handles logs when the current program being executing is *not* drift.
function handleSystemLog(
	log: string,
	programId = driftProgramId
): [string | null, boolean] {
	// System component.
	const logStart = log.split(':')[0];
	const programStart = `Program ${programId} invoke`;

	// Did the program finish executing?
	if (logStart.match(/^Program (.*) success/g) !== null) {
		return [null, true];
		// Recursive call.
	} else if (logStart.startsWith(programStart)) {
		return [programId, false];
	}
	// CPI call.
	else if (logStart.includes('invoke')) {
		return ['cpi', false]; // Any string will do.
	} else {
		return [null, false];
	}
}

// Stack frame execution context, allowing one to track what program is
// executing for a given log.
class ExecutionContext {
	stack: string[] = [];
	ixStack: string[] = [];

	program(): string {
		if (!this.stack.length) {
			throw new Error('Expected the stack to have elements');
		}
		return this.stack[this.stack.length - 1];
	}

	push(newProgram: string) {
		this.stack.push(newProgram);
	}

	pop() {
		if (!this.stack.length) {
			throw new Error('Expected the stack to have elements');
		}
		this.stack.pop();
	}

	ix(): string {
		if (!this.ixStack.length) {
			throw new Error('Expected the ix stack to have elements');
		}
		return this.ixStack[this.ixStack.length - 1];
	}

	pushIx(newIx: string) {
		this.ixStack.push(newIx);
	}

	popIx() {
		this.ixStack.pop();
	}
}

export function parseLogsForCuUsage(
	logs: string[],
	programId = driftProgramId
): Event<CuUsageEvent>[] {
	const cuUsageEvents: Event<CuUsageEvent>[] = [];

	const execution = new ExecutionContext();
	for (const log of logs) {
		if (log.startsWith('Log truncated')) {
			break;
		}

		const [newProgram, newIx, didPopProgram, didPopIx] = handleLogForCuUsage(
			execution,
			log,
			programId
		);
		if (newProgram) {
			execution.push(newProgram);
		}
		if (newIx) {
			execution.pushIx(newIx);
		}
		if (didPopProgram) {
			execution.pop();
		}
		if (didPopIx !== null) {
			cuUsageEvents.push({
				name: 'CuUsage',
				data: {
					instruction: execution.ix(),
					cuUsage: didPopIx!,
				},
			} as any);
			execution.popIx();
		}
	}
	return cuUsageEvents;
}

function handleLogForCuUsage(
	execution: ExecutionContext,
	log: string,
	programId = driftProgramId
): [string | null, string | null, boolean, number | null] {
	if (execution.stack.length > 0 && execution.program() === programId) {
		return handleProgramLogForCuUsage(log, programId);
	} else {
		return handleSystemLogForCuUsage(log, programId);
	}
}

function handleProgramLogForCuUsage(
	log: string,
	programId = driftProgramId
): [string | null, string | null, boolean, number | null] {
	if (log.startsWith(PROGRAM_INSTRUCTION)) {
		const ixStr = log.slice(PROGRAM_INSTRUCTION_START_INDEX);
		return [null, ixStr, false, null];
	} else {
		return handleSystemLogForCuUsage(log, programId);
	}
}

function handleSystemLogForCuUsage(
	log: string,
	programId = driftProgramId
): [string | null, string | null, boolean, number | null] {
	// System component.
	const logStart = log.split(':')[0];
	const programStart = `Program ${programId} invoke`;

	// Did the program finish executing?
	if (logStart.match(/^Program (.*) success/g) !== null) {
		return [null, null, true, null];
		// Recursive call.
	} else if (logStart.startsWith(programStart)) {
		return [programId, null, false, null];
		// Consumed CU log.
	} else if (log.startsWith(`Program ${programId} consumed `)) {
		// Extract CU usage, e.g. 'Program ... consumed 29242 of 199700 compute units'
		// We need to extract the consumed value (29242)
		const matches = log.match(/consumed (\d+) of \d+ compute units/);
		if (matches) {
			return [null, null, false, Number(matches[1])];
		}
		return [null, null, false, null];
	}
	// CPI call.
	else if (logStart.includes('invoke')) {
		return ['cpi', null, false, null]; // Any string will do.
	} else {
		return [null, null, false, null];
	}
}
