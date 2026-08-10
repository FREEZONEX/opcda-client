'use strict';

const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;
const DEFAULT_RECONNECT_BASE_MS = 3000;
const DEFAULT_RECONNECT_MAX_MS = 60000;
const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_RESOURCE_COOLDOWN_MS = 5 * 60 * 1000;
const REMOTE_NO_MEMORY = 0x1C00001B;
const WINDOWS_SHARING_BUFFER_EXCEEDED = 0x80070024;
const WINDOWS_MAX_THREADS_REACHED = 0x800700A4;

const REMOTE_RESOURCE_ERROR_CODES = new Set([
	REMOTE_NO_MEMORY,
	WINDOWS_SHARING_BUFFER_EXCEEDED,
	WINDOWS_MAX_THREADS_REACHED,
]);

const ERROR_CODE_NAMES = new Map([
	[REMOTE_NO_MEMORY, 'RPC_S_FAULT_REMOTE_NO_MEMORY'],
	[WINDOWS_SHARING_BUFFER_EXCEEDED, 'ERROR_SHARING_BUFFER_EXCEEDED'],
	[WINDOWS_MAX_THREADS_REACHED, 'ERROR_MAX_THRDS_REACHED'],
]);

const PERMANENT_ERROR_CODES = new Set([
	0x00000005, // Access denied
	0x80070005, // E_ACCESSDENIED
	0x00000061, // Invalid CLSID syntax
	0x80040154, // Class not registered
	0xC0040010, // Invalid server configuration
]);

function errorCodeOf(error) {
	const candidates = [error, error && error.code, error && error.status, error && error.hresult];

	for (const candidate of candidates) {
		if (typeof candidate === 'number' && Number.isFinite(candidate)) {
			return candidate >>> 0;
		}
		if (typeof candidate !== 'string') continue;

		const value = candidate.trim();
		if (/^-?\d+$/.test(value)) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed >>> 0;
		}

		if (/^0x[0-9a-f]+$/i.test(value)) {
			return Number.parseInt(value, 16) >>> 0;
		}
	}

	// Error messages may contain diagnostic hexadecimal values such as an RPC
	// PDU type. Only extract embedded numbers when they are explicitly labelled
	// as an HRESULT/RPC status/fault rather than accepting any 0x... substring.
	const message = error && error.message;
	if (typeof message === 'string') {
		const wrappedNumber = message.match(/^(?:Error:\s*)*(0x[0-9a-f]+|-?\d+)$/i);
		if (wrappedNumber) {
			return wrappedNumber[1].toLowerCase().startsWith('0x') ?
				Number.parseInt(wrappedNumber[1], 16) >>> 0 :
				Number(wrappedNumber[1]) >>> 0;
		}
		const labelled = message.match(
			/(?:HRESULT|RPC(?:\s+status)?|fault(?:\s+status)?|error\s+code)\s*[:=]?\s*(0x[0-9a-f]+|-?\d+)/i,
		);
		if (labelled) {
			return labelled[1].toLowerCase().startsWith('0x') ?
				Number.parseInt(labelled[1], 16) >>> 0 :
				Number(labelled[1]) >>> 0;
		}
	}

	return null;
}

function qualityName(quality) {
	if (!Number.isFinite(quality)) return 'UNKNOWN';
	switch (Number(quality) & 0xC0) {
		case 0x00: return 'BAD';
		case 0x40: return 'UNCERTAIN';
		case 0xC0: return 'GOOD';
		default: return 'UNKNOWN';
	}
}

function messageOf(error) {
	if (error && error.message) return error.message;
	if (error == null) return 'Unknown error';
	return String(error);
}

function errorCodeName(code) {
	return ERROR_CODE_NAMES.get(code) || null;
}

function isTransportFatal(error) {
	if (!error) return false;
	if (error.transportFatal === true) return true;

	const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
	if (code.startsWith('DCOM_')) return true;
	if (new Set([
		'ECONNABORTED',
		'ECONNREFUSED',
		'ECONNRESET',
		'EHOSTUNREACH',
		'ENETDOWN',
		'ENETUNREACH',
		'EPIPE',
		'ETIMEDOUT',
	]).has(code)) return true;

	return /(?:connection|transport).*(?:timeout|timed out|closed|reset|disconnected)|(?:timeout|timed out).*(?:connection|transport)|unexpected (?:rpc )?pdu|concurrent receive/i.test(messageOf(error).replace(/\s+/g, ' '));
}

function withTimeout(action, timeoutMs, label) {
	const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ?
		timeoutMs : DEFAULT_CLEANUP_TIMEOUT_MS;

	let timer;
	return Promise.race([
		Promise.resolve().then(action),
		new Promise((_, reject) => {
			timer = setTimeout(
				() => {
					const error = new Error(`${label} timed out after ${timeout}ms`);
					error.code = 'OPCDA_OPERATION_TIMEOUT';
					error.transportFatal = true;
					reject(error);
				},
				timeout,
			);
		}),
	]).finally(() => clearTimeout(timer));
}

function runTimedStep(target, step, action, timeoutMs, operation) {
	if (target) target._diagStep = step;
	const label = `${operation || 'OPCDA initialization'} at ${step}`;
	return withTimeout(action, timeoutMs, label);
}

async function forceCleanup(logger, refs, label, timeoutMs) {
	const prefix = label || 'DCOM';
	let success = true;

	// Close the active byte stream first. This cancels a pending receive and
	// prevents any later cleanup code from sending RPCs over a poisoned stream.
	if (refs && refs.comServer && typeof refs.comServer.closeStub === 'function') {
		success = await cleanupStep(
			logger,
			`close ${prefix} transport`,
			() => refs.comServer.closeStub(),
			timeoutMs,
		) && success;
	}

	if (refs && refs.comSession &&
		typeof refs.comSession.destroySession === 'function') {
		success = await cleanupStep(
			logger,
			`discard ${prefix} session locally`,
			() => refs.comSession.destroySession(
				refs.comSession,
				{skipRemoteRelease: true},
			),
			timeoutMs,
		) && success;
	}

	return success;
}

async function cleanupStep(logger, label, action, timeoutMs) {
	if (typeof action !== 'function') return true;
	try {
		await withTimeout(action, timeoutMs, label);
		return true;
	} catch (error) {
		const log = logger && (logger.warn || logger.error);
		if (typeof log === 'function') {
			log.call(logger, `OPCDA cleanup: ${label}: ${messageOf(error)}`);
		}
		return false;
	}
}

function createReconnectController(options) {
	const {
		node,
		connect,
		destroy,
		baseDelayMs = DEFAULT_RECONNECT_BASE_MS,
		maxDelayMs = DEFAULT_RECONNECT_MAX_MS,
		maxFailures = DEFAULT_MAX_FAILURES,
		resourceFailureLimit = 3,
		resourceCooldownMs = DEFAULT_RESOURCE_COOLDOWN_MS,
		scheduleTimer = setTimeout,
		cancelTimer = clearTimeout,
	} = options;

	let timer = null;
	let cleanupPromise = null;
	let running = false;
	let closing = false;
	let consecutiveFailures = 0;
	let resourceFailures = 0;
	let resourceCooldownActive = false;

	function clearTimer() {
		if (timer) {
			cancelTimer(timer);
			timer = null;
		}
	}

	function ensureCleanup(error, reason) {
		if (!cleanupPromise) {
			cleanupPromise = Promise.resolve()
				.then(() => destroy(error, reason))
				.catch(error => {
					node.warn(`OPCDA cleanup before reconnect failed: ${messageOf(error)}`);
				});
		}
		return cleanupPromise;
	}

	async function cleanupBeforeConnect() {
		const pendingCleanup = cleanupPromise;
		cleanupPromise = null;
		if (pendingCleanup) {
			await pendingCleanup;
		} else {
			await destroy();
		}
	}

	function setStoppedStatus() {
		if (typeof node.updateStatus === 'function') {
			node.updateStatus('stopped');
		}
	}

	function reportFailure(error, reason) {
		const code = errorCodeOf(error);
		const name = errorCodeName(code);
		const codeText = code == null ? '' :
			` [0x${code.toString(16)}${name ? ` ${name}` : ''}]`;
		node.error(`OPCDA ${reason} failed${codeText}: ${messageOf(error)}`);
		return code;
	}

	function scheduleRun(delay) {
		timer = scheduleTimer(() => {
			timer = null;
			return run();
		}, delay);
	}

	function enterResourceCooldown() {
		resourceCooldownActive = true;
		if (typeof node.updateStatus === 'function') {
			node.updateStatus('cooldown');
		}
		node.warn(
			`OPCDA remote resource exhaustion detected ${resourceFailures} times; ` +
			`cooling down for ${resourceCooldownMs}ms before one reconnect probe.`,
		);
		scheduleRun(resourceCooldownMs);
		return true;
	}

	function scheduleAfterFailure(error, reason) {
		if (closing || timer) return false;

		const code = reportFailure(error, reason);
		consecutiveFailures += 1;
		const resourceFailure = REMOTE_RESOURCE_ERROR_CODES.has(code);
		if (resourceFailure) {
			resourceFailures += 1;
			node.warn(
				`OPCDA remote resource failure ${resourceFailures}/${resourceFailureLimit} ` +
				`[0x${code.toString(16)} ${errorCodeName(code)}].`,
			);
		} else if (!resourceCooldownActive) {
			// The threshold applies to consecutive resource failures. Once a
			// cooldown has started, any failed probe must enter cooldown again.
			resourceFailures = 0;
		}
		void ensureCleanup(error, reason);

		if (PERMANENT_ERROR_CODES.has(code)) {
			node.error('OPCDA reconnect stopped: permanent configuration or permission error.');
			setStoppedStatus();
			return false;
		}

		if (resourceCooldownActive || resourceFailures >= resourceFailureLimit) {
			return enterResourceCooldown();
		}

		if (consecutiveFailures >= maxFailures) {
			node.error(
				`OPCDA reconnect stopped after ${consecutiveFailures} consecutive failures.`,
			);
			setStoppedStatus();
			return false;
		}

		const delay = Math.min(
			baseDelayMs * (2 ** Math.max(0, consecutiveFailures - 1)),
			maxDelayMs,
		);
		if (typeof node.updateStatus === 'function') {
			node.updateStatus('reconnecting');
		}
		node.warn(`OPCDA reconnect ${consecutiveFailures}/${maxFailures} scheduled in ${delay}ms.`);
		scheduleRun(delay);
		return true;
	}

	async function run() {
		if (closing || running) return false;
		clearTimer();
		running = true;
		try {
			await cleanupBeforeConnect();
			if (closing) return false;
			await connect();
			return true;
		} catch (error) {
			scheduleAfterFailure(error, 'connect');
			return false;
		} finally {
			running = false;
		}
	}

	function reconnect(error, reason = 'operation') {
		if (closing || running || timer) return false;
		return scheduleAfterFailure(error, reason);
	}

	function markHealthy() {
		clearTimer();
		consecutiveFailures = 0;
		resourceFailures = 0;
		resourceCooldownActive = false;
	}

	function stop() {
		closing = true;
		clearTimer();
	}

	return {
		start: run,
		reconnect,
		markHealthy,
		stop,
		isClosing: () => closing,
		isRunning: () => running,
		isCoolingDown: () => resourceCooldownActive && timer != null,
		getFailureCount: () => consecutiveFailures,
		getResourceFailureCount: () => resourceFailures,
	};
}

module.exports = {
	DEFAULT_CLEANUP_TIMEOUT_MS,
	DEFAULT_RESOURCE_COOLDOWN_MS,
	REMOTE_NO_MEMORY,
	WINDOWS_SHARING_BUFFER_EXCEEDED,
	WINDOWS_MAX_THREADS_REACHED,
	REMOTE_RESOURCE_ERROR_CODES,
	PERMANENT_ERROR_CODES,
	errorCodeOf,
	errorCodeName,
	messageOf,
	isTransportFatal,
	qualityName,
	withTimeout,
	runTimedStep,
	cleanupStep,
	forceCleanup,
	createReconnectController,
};
