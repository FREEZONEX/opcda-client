'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
	REMOTE_NO_MEMORY,
	WINDOWS_SHARING_BUFFER_EXCEEDED,
	WINDOWS_MAX_THREADS_REACHED,
	createReconnectController,
	errorCodeOf,
	errorCodeName,
	forceCleanup,
	isTransportFatal,
	qualityName,
	runTimedStep,
	withTimeout,
} = require('../opcda/lifecycle');

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function fakeTimers() {
	const queue = [];
	return {
		schedule(callback, delay) {
			const entry = {callback, delay, cancelled: false};
			queue.push(entry);
			return entry;
		},
		cancel(entry) {
			entry.cancelled = true;
		},
		nextDelay() {
			const entry = queue.find(item => !item.cancelled);
			return entry && entry.delay;
		},
		pendingCount() {
			return queue.filter(item => !item.cancelled).length;
		},
		async fireNext() {
			let entry;
			do {
				entry = queue.shift();
			} while (entry && entry.cancelled);
			assert.ok(entry, 'expected a pending timer');
			await entry.callback();
		},
	};
}

test('errorCodeOf normalizes numeric, decimal and hexadecimal RPC errors', () => {
	assert.equal(errorCodeOf(REMOTE_NO_MEMORY), REMOTE_NO_MEMORY);
	assert.equal(errorCodeOf(new Error(String(REMOTE_NO_MEMORY))), REMOTE_NO_MEMORY);
	assert.equal(errorCodeOf(new Error('HRESULT 0x1c00001b')), REMOTE_NO_MEMORY);
	assert.equal(
		errorCodeOf(new Error(String(WINDOWS_SHARING_BUFFER_EXCEEDED))),
		WINDOWS_SHARING_BUFFER_EXCEEDED,
	);
	assert.equal(
		errorCodeOf(new Error(String(WINDOWS_MAX_THREADS_REACHED))),
		WINDOWS_MAX_THREADS_REACHED,
	);
	assert.equal(errorCodeOf({code: -2147024891}), 0x80070005);
	assert.equal(errorCodeOf(new Error('connection timeout')), null);
	assert.equal(errorCodeName(REMOTE_NO_MEMORY), 'RPC_S_FAULT_REMOTE_NO_MEMORY');
	assert.equal(
		errorCodeName(WINDOWS_SHARING_BUFFER_EXCEEDED),
		'ERROR_SHARING_BUFFER_EXCEEDED',
	);
	assert.equal(errorCodeName(WINDOWS_MAX_THREADS_REACHED), 'ERROR_MAX_THRDS_REACHED');
});

test('errorCodeOf does not mistake an RPC PDU type for an HRESULT', () => {
	const error = new Error('Received unexpected RPC PDU (type=0x0b, callId=7)');
	error.code = 'DCOM_PROTOCOL_ERROR';
	assert.equal(errorCodeOf(error), null);
});

test('OPC quality classification uses the category mask', () => {
	assert.equal(qualityName(0x00), 'BAD');
	assert.equal(qualityName(0x40), 'UNCERTAIN');
	assert.equal(qualityName(0xC0), 'GOOD');
	assert.equal(qualityName(0xDC), 'GOOD');
	assert.equal(qualityName(0xFF), 'GOOD');
	assert.equal(qualityName(NaN), 'UNKNOWN');
});

test('transport failures are distinguished from OPC application errors', () => {
	assert.equal(isTransportFatal({code: 'DCOM_CONNECTION_TIMEOUT'}), true);
	assert.equal(isTransportFatal({code: 'ECONNRESET'}), true);
	assert.equal(isTransportFatal(new Error('Received unexpected PDU from server.')), true);
	assert.equal(isTransportFatal(new Error('HRESULT 0x1c00001b')), false);
	assert.equal(isTransportFatal({code: 0x80070005}), false);
});

test('operation timeout carries a fatal marker for cancellable teardown', async () => {
	await assert.rejects(withTimeout(
		() => new Promise(() => {}),
		5,
		'OPCDA read',
	), error => {
		assert.equal(error.code, 'OPCDA_OPERATION_TIMEOUT');
		assert.equal(error.transportFatal, true);
		assert.match(error.message, /OPCDA read timed out after 5ms/);
		return true;
	});
});

test('timed initialization steps report the active step', async () => {
	const target = {_diagStep: 'start'};
	assert.equal(await runTimedStep(
		target,
		'comServer.init',
		async () => 'connected',
		50,
	), 'connected');
	assert.equal(target._diagStep, 'comServer.init');

	await assert.rejects(runTimedStep(
		target,
		'getSyncIO',
		() => new Promise(() => {}),
		5,
	), error => {
		assert.equal(target._diagStep, 'getSyncIO');
		assert.match(error.message, /OPCDA initialization at getSyncIO timed out after 5ms/);
		return true;
	});
});

test('forced cleanup closes the transport before local-only session discard', async () => {
	const calls = [];
	const refs = {
		comServer: {
			closeStub: async () => { calls.push('close transport'); },
		},
		comSession: {
			destroySession: async (session, options) => {
				assert.equal(session, refs.comSession);
				assert.deepEqual(options, {skipRemoteRelease: true});
				calls.push('discard session');
			},
		},
	};

	assert.equal(await forceCleanup(null, refs, 'test', 50), true);
	assert.deepEqual(calls, ['close transport', 'discard session']);
});

test('reconnect cleanup receives the original failure and reason', async () => {
	const failure = Object.assign(new Error('connection timeout'), {
		transportFatal: true,
	});
	let cleanupArgs;
	const controller = createReconnectController({
		node: {error: () => {}, warn: () => {}, updateStatus: () => {}},
		connect: async () => {},
		destroy: async (...args) => { cleanupArgs = args; },
		baseDelayMs: 100,
	});

	controller.reconnect(failure, 'read');
	await wait(0);
	assert.equal(cleanupArgs[0], failure);
	assert.equal(cleanupArgs[1], 'read');
	controller.stop();
});

test('Windows thread-limit faults cool down after three failures and probe once per interval', async () => {
	const errors = [];
	const warnings = [];
	const statuses = [];
	const timers = fakeTimers();
	let connectCount = 0;
	let destroyCount = 0;
	let connectShouldFail = true;
	const node = {
		error: message => errors.push(message),
		warn: message => warnings.push(message),
		updateStatus: status => statuses.push(status),
	};
	const controller = createReconnectController({
		node,
		connect: async () => {
			connectCount += 1;
			if (connectShouldFail) {
				throw new Error(String(WINDOWS_MAX_THREADS_REACHED));
			}
		},
		destroy: async () => { destroyCount += 1; },
		baseDelayMs: 3000,
		maxDelayMs: 60000,
		maxFailures: 10,
		resourceFailureLimit: 3,
		resourceCooldownMs: 300000,
		scheduleTimer: timers.schedule,
		cancelTimer: timers.cancel,
	});

	assert.equal(controller.reconnect(
		new Error(String(WINDOWS_MAX_THREADS_REACHED)),
		'connect',
	), true);
	await wait(0);
	assert.equal(timers.nextDelay(), 3000);
	await timers.fireNext();
	assert.equal(timers.nextDelay(), 6000);
	await timers.fireNext();
	assert.equal(controller.getFailureCount(), 3);
	assert.equal(controller.getResourceFailureCount(), 3);
	assert.equal(controller.isCoolingDown(), true);
	assert.equal(connectCount, 2);
	assert.equal(destroyCount, 3);
	assert.equal(statuses.at(-1), 'cooldown');
	assert.equal(timers.nextDelay(), 300000);
	assert.match(warnings.at(-1), /cooling down for 300000ms/);

	await timers.fireNext();
	assert.equal(connectCount, 3);
	assert.equal(timers.pendingCount(), 1);
	assert.equal(timers.nextDelay(), 300000);
	assert.equal(controller.getFailureCount(), 4);
	assert.equal(controller.isCoolingDown(), true);

	connectShouldFail = false;
	await timers.fireNext();
	assert.equal(connectCount, 4);
	assert.equal(timers.pendingCount(), 0);
	assert.equal(controller.getFailureCount(), 4);

	controller.markHealthy();
	assert.equal(controller.getFailureCount(), 0);
	assert.equal(controller.getResourceFailureCount(), 0);
	assert.equal(errors.length, 4);
	assert.match(errors[0], /0x800700a4 ERROR_MAX_THRDS_REACHED/);
	controller.stop();
});

test('a non-resource failure resets the consecutive resource-failure streak', async () => {
	const timers = fakeTimers();
	const connectErrors = [
		new Error('connection timeout'),
		new Error(String(WINDOWS_MAX_THREADS_REACHED)),
	];
	const controller = createReconnectController({
		node: {error: () => {}, warn: () => {}, updateStatus: () => {}},
		connect: async () => { throw connectErrors.shift(); },
		destroy: async () => {},
		baseDelayMs: 1,
		resourceFailureLimit: 3,
		scheduleTimer: timers.schedule,
		cancelTimer: timers.cancel,
	});

	controller.reconnect(new Error(String(REMOTE_NO_MEMORY)), 'read');
	await wait(0);
	assert.equal(controller.getResourceFailureCount(), 1);

	await timers.fireNext();
	assert.equal(controller.getResourceFailureCount(), 0);
	await timers.fireNext();
	assert.equal(controller.getResourceFailureCount(), 1);
	assert.equal(controller.isCoolingDown(), false);
	controller.stop();
});

test('a healthy read resets the consecutive failure counter', async () => {
	const node = {
		error: () => {},
		warn: () => {},
		updateStatus: () => {},
	};
	const controller = createReconnectController({
		node,
		connect: async () => {},
		destroy: async () => {},
		baseDelayMs: 1,
		maxFailures: 3,
	});

	controller.reconnect(new Error('connection timeout'), 'read');
	await wait(10);
	assert.equal(controller.getFailureCount(), 1);
	controller.markHealthy();
	assert.equal(controller.getFailureCount(), 0);
	controller.stop();
});

test('access-denied and invalid-CLSID errors stop permanently without a timer', async () => {
	for (const code of [0x00000005, 0x80070005, 0x00000061, 0x80040154]) {
		const statuses = [];
		const timers = fakeTimers();
		let destroyCount = 0;
		const controller = createReconnectController({
			node: {
				error: () => {},
				warn: () => {},
				updateStatus: status => statuses.push(status),
			},
			connect: async () => {},
			destroy: async () => { destroyCount += 1; },
			scheduleTimer: timers.schedule,
			cancelTimer: timers.cancel,
		});

		assert.equal(controller.reconnect({code}, 'connect'), false);
		await wait(0);
		assert.equal(timers.pendingCount(), 0);
		assert.equal(statuses.at(-1), 'stopped');
		assert.equal(destroyCount, 1);
		controller.stop();
	}
});
