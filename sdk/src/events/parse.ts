import { Program, Event } from '@coral-xyz/anchor';

const driftProgramId = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
const driftProgramStart = `Program ${driftProgramId} invoke`;
const PROGRAM_LOG = 'Program log: ';
const PROGRAM_DATA = 'Program data: ';
const PROGRAM_LOG_START_INDEX = PROGRAM_LOG.length;
const PROGRAM_DATA_START_INDEX = PROGRAM_DATA.length;

export function parseLogs(
	program: Program,
	slot: number,
	logs: string[]
): Event[] {
	const events = [];
	const execution = new ExecutionContext();
	for (const log of logs) {
		const [event, newProgram, didPop] = handleLog(execution, log, program);
		if (event) {
			events.push(event);
		}
		if (newProgram) {
			execution.push(newProgram);
		}
		if (didPop) {
			execution.pop();
		}
	}
	return events;
}

function handleLog(
	execution: ExecutionContext,
	log: string,
	program: Program
): [Event | null, string | null, boolean] {
	// Executing program is drift program.
	if (execution.stack.length > 0 && execution.program() === driftProgramId) {
		return handleProgramLog(log, program);
	}
	// Executing program is not drift program.
	else {
		return [null, ...handleSystemLog(log)];
	}
}

// Handles logs from *drift* program.
function handleProgramLog(
	log: string,
	program: Program
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
		return [null, ...handleSystemLog(log)];
	}
}

// Handles logs when the current program being executing is *not* drift.
function handleSystemLog(log: string): [string | null, boolean] {
	// System component.
	const logStart = log.split(':')[0];

	// Did the program finish executing?
	if (logStart.match(/^Program (.*) success/g) !== null) {
		return [null, true];
		// Recursive call.
	} else if (logStart.startsWith(driftProgramStart)) {
		return [driftProgramId, false];
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
}
