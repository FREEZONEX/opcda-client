'use strict';

const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;
const DEFAULT_RECONNECT_BASE_MS = 3000;
const DEFAULT_RECONNECT_MAX_MS = 60000;
const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_RESOURCE_COOLDOWN_MS = 5 * 60 * 1000;
const REMOTE_NO_MEMORY = 0x1C00001B;

const PERMANENT_ERROR_CODES = new Set([
	0x00000005, // Access denied
	0x80070005, // E_ACCESSDENIED
	0x00000061, // Invalid CLSID syntax
	0x80040154, // Class not registered
	0xC0040010, // Invalid server configuration
]);

function errorCodeOf(error) {
	const candidates = [
		error,
		error && error.code,
		error && error.status,
		error && error.hresult,
		error && error.message,
	];

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

		const hex = value.match(/0x[0-9a-f]+/i);
		if (hex) return Number.parseInt(hex[0], 16) >>> 0;
	}

	return null;
}

function messageOf(error) {
	if (error && error.message) return error.message;
	if (error == null) return 'Unknown error';
	return String(error);
}

function withTimeout(action, timeoutMs, label) {
	const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ?
		timeoutMs : DEFAULT_CLEANUP_TIMEOUT_MS;

	let timer;
	return Promise.race([
		Promise.resolve().then(action),
		new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${label} timed out after ${timeout}ms`)),
				timeout,
			);
		}),
	]).finally(() => clearTimeout(timer));
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

	function ensureCleanup() {
		if (!cleanupPromise) {
			cleanupPromise = Promise.resolve()
				.then(destroy)
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
		const codeText = code == null ? '' : ` [0x${code.toString(16)}]`;
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
		if (code === REMOTE_NO_MEMORY) {
			resourceFailures += 1;
		}
		void ensureCleanup();

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
	PERMANENT_ERROR_CODES,
	errorCodeOf,
	messageOf,
	withTimeout,
	cleanupStep,
	createReconnectController,
};
