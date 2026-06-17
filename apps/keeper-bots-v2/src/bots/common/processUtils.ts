import { ChildProcess, fork, SendHandle, Serializable } from 'child_process';

export const spawnChildWithRetry = (
	relativePath: string,
	childArgs: string[],
	processName: string,
	onMessage: (msg: Serializable, sendHandle: SendHandle) => void,
	logPrefix = ''
): ChildProcess => {
	const child = fork(relativePath, childArgs);

	child.on('message', onMessage);

	child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
		console.log(
			`${logPrefix} Child process: ${processName} exited with code ${code}, signal: ${signal}`
		);
	});

	child.on('error', (err: Error) => {
		console.error(
			`${logPrefix} Child process: ${processName} had an error:\n`,
			err
		);
		if (err.message.includes('Channel closed')) {
			console.error(`Exiting`);
			process.exit(2);
		} else {
			console.log(`${logPrefix} Restarting child process: ${processName}`);
			spawnChildWithRetry(relativePath, childArgs, processName, onMessage);
		}
	});

	return child;
};
