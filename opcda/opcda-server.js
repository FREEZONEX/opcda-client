module.exports = function(RED) {
	const opcda = require('@tier0/node-opc-da');
    const { OPCServer } = opcda;
    const { ComServer, Session, Clsid } = opcda.dcom;
	const {
		cleanupStep,
		errorCodeOf,
		forceCleanup,
		isTransportFatal,
		messageOf,
		withTimeout,
	} = require('./lifecycle');
	const activeBrowses = new Set();
	
	const errorCode = {
		0x80040154 : "Clsid is not found.",
		0x00000005 : "Access denied. Username and/or password might be wrong.",
		0xC0040006 : "The Items AccessRights do not allow the operation.",
		0xC0040004 : "The server cannot convert the data between the specified format/ requested data type and the canonical data type.",
		0xC004000C : "Duplicate name not allowed.",
		0xC0040010 : "The server's configuration file is an invalid format.",
		0xC0040009 : "The filter string was not valid",
		0xC0040001 : "The value of the handle is invalid. Note: a client should never pass an invalid handle to a server. If this error occurs, it is due to a programming error in the client or possibly in the server.",
		0xC0040008 : "The item ID doesn't conform to the server's syntax.",
		0xC0040203 : "The passed property ID is not valid for the item.",
		0xC0040011 : "Requested Object (e.g. a public group) was not found.",
		0xC0040005 : "The requested operation cannot be done on a public group.",
		0xC004000B : "The value was out of range.",
		0xC0040007 : "The item ID is not defined in the server address space (on add or validate) or no longer exists in the server address space (for read or write).",
		0xC004000A : "The item's access path is not known to the server.",
		0x0004000E : "A value passed to WRITE was accepted but the output was clamped.",
		0x0004000F : "The operation cannot be performed because the object is being referenced.",
		0x0004000D : "The server does not support the requested data rate but will use the closest available rate.",
		0x00000061 : "Clsid syntax is invalid",
		0x80004002 : "No such interface (E_NOINTERFACE).",
		2147500034 : "No such interface (E_NOINTERFACE).",
		0x1C00001B : "RPC server out of memory/resources (nca_s_fault_remote_no_memory)."
	};

	function formatBrowseError(err) {
		const code = errorCodeOf(err);
		if (code != null && errorCode[code] !== undefined) {
			return `${errorCode[code]} [0x${code.toString(16)}]`;
		}
		if (code != null) {
			return `HRESULT 0x${code.toString(16)} (${code})`;
		}
		return messageOf(err);
	}

	/**
	 * Merge query params with deployed opcda-server config node so Browse works when
	 * the password field is empty in the editor (Node-RED never fills stored passwords).
	 */
	function resolveBrowseParams(query) {
		const params = Object.assign({}, query);
		if (params.password === "__PWRD__" || params.password === "__PASSWORD__") {
			delete params.password;
		}
		const id = params.id;
		if (id) {
			const srv = RED.nodes.getNode(id);
			if (srv && srv.credentials) {
				if (srv.domain != null && String(srv.domain).trim() !== "") {
					params.domain = String(srv.domain).trim();
				}
				if (srv.address) params.address = srv.address;
				if (srv.clsid) params.clsid = srv.clsid;
				if (srv.timeout != null && srv.timeout !== "") params.timeout = srv.timeout;
				if (srv.credentials.username) params.username = srv.credentials.username;
				if (srv.credentials.password) params.password = srv.credentials.password;
			} else if (id) {
				RED.log.warn("OPC DA browse: config node id not in runtime (Deploy flows?) — using form/query fields only.");
			}
		}
		params.domain = params.domain != null && String(params.domain).trim() !== "" ?
			String(params.domain).trim() : "";
		params.username = String(params.username || "").trim();
		params.password = String(params.password || "");
		if (params.password === "__PWRD__" || params.password === "__PASSWORD__") {
			params.password = "";
		}
		const t = Number(params.timeout);
		params.timeout = Number.isFinite(t) && t > 0 ? t : 15000;
		return params;
	}

	RED.httpAdmin.post('/opcda/browse', RED.auth.needsPermission('node-opc-da.list'), function (req, res) {
		async function browseItems() {
			const params = resolveBrowseParams(req.body || {});
			const browseKey = params.id || [params.address, params.clsid, params.username].join('|');
			if (activeBrowses.has(browseKey)) {
				res.status(409).send({error: 'An OPC DA browse is already running for this server.'});
				return;
			}
			activeBrowses.add(browseKey);
			let session = null;
			let comServer = null;
			let comObject = null;
			let opcServer = null;
			let opcBrowser = null;
			let responseStatus = 200;
			let responseBody;
			let browseError = null;
			try {
				if (!params.address || !params.clsid) {
					res.status(400).send({error: "Missing address or clsid."});
					return;
				}
				if (!params.username || !params.password) {
					res.status(400).send({
						error: "Missing username or password. Deploy flows first (Browse uses stored credentials from the opcda-server node). If the URL showed password=__PWRD__, that is not a real password — deploy or re-type the password in the server config."
					});
					return;
				}

				const itemList = await withTimeout(async () => {
					session = new Session().createSession(
						params.domain,
						params.username,
						params.password,
					);
					session.setGlobalSocketTimeout(params.timeout);
					comServer = new ComServer(new Clsid(params.clsid), params.address, session);
					await comServer.init();
					comObject = await comServer.createInstance();
					opcServer = new opcda.OPCServer();
					await opcServer.init(comObject);
					opcBrowser = await opcServer.getBrowser();
					return opcBrowser.browseAllFlat();
				}, params.timeout, 'OPCDA browse');
				responseBody = {items: itemList};
			} catch (e) {
				browseError = e;
				const msg = formatBrowseError(e);
				RED.log.error(`OPC DA browse: ${msg}`);
				if (e && e.stack) RED.log.error(e.stack);
				responseStatus = 500;
				responseBody = {error: msg};
			} finally {
				const cleanupTimeout = Math.min(Math.max(params.timeout, 1000), 10000);
				const refs = {comServer, comSession: session};
				if (isTransportFatal(browseError)) {
					await forceCleanup(RED.log, refs, 'Browse', cleanupTimeout);
				} else {
					let graceful = true;
					const gracefulStep = async (label, action) => {
						if (!graceful) return false;
						graceful = await cleanupStep(RED.log, label, action, cleanupTimeout);
						if (!graceful) await forceCleanup(RED.log, refs, 'Browse', cleanupTimeout);
						return graceful;
					};
					if (opcBrowser) await gracefulStep('release Browse enumerator', () => opcBrowser.end());
					if (opcServer) await gracefulStep('release Browse OPC server', () => opcServer.end());
					if (comObject && typeof comObject.release === 'function') {
						await gracefulStep('release Browse COM object', () => comObject.release());
					}
					if (session && typeof session.destroySession === 'function') {
						await gracefulStep('destroy Browse DCOM session', () => session.destroySession(session));
					}
					if (comServer) await gracefulStep('close Browse DCOM transport', () => comServer.closeStub());
				}
				activeBrowses.delete(browseKey);
			}
			if (!res.headersSent) res.status(responseStatus).send(responseBody);
		}

		browseItems();
	});

    function OPCDAServer(config) {
        RED.nodes.createNode(this,config);
        const node = this;
		
		node.config = config;
		node.address = config.address;
		node.domain = config.domain;
		node.clsid = config.clsid;
		node.timeout = config.timeout;
		node.reconnectinterval = config.reconnectinterval;

		
		node.on('close', function(done){
			done();
		});
	}
	
    RED.nodes.registerType("tier0-opcda-server", OPCDAServer, {
		credentials: {
			username: {type:"text"},
			password: {type:"password"}
		}
    });
}
