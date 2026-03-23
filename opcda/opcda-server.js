module.exports = function(RED) {
	const opcda = require('@tier0/node-opc-da');
    const { OPCServer } = opcda;
    const { ComServer, Session, Clsid } = opcda.dcom;
	
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
		2147500034 : "No such interface (E_NOINTERFACE)."
	};

	function formatBrowseError(err) {
		if (typeof err === "number") {
			const u = err >>> 0;
			if (errorCode[err] !== undefined) return errorCode[err];
			if (errorCode[u] !== undefined) return errorCode[u];
			return "HRESULT 0x" + u.toString(16) + " (" + err + ")";
		}
		if (err && err.message) {
			const asNum = Number(err.message);
			if (!Number.isNaN(asNum) && String(asNum) === String(err.message).trim()) {
				return formatBrowseError(asNum);
			}
			return err.message;
		}
		return String(err || "Unknown error.");
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

	RED.httpAdmin.get('/opcda/browse', RED.auth.needsPermission('node-opc-da.list'), function (req, res) {
		async function browseItems() {
			const params = resolveBrowseParams(req.query);
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

				var session = new Session();
				session = session.createSession(params.domain, params.username, params.password);
				session.setGlobalSocketTimeout(params.timeout);

				var comServer = new ComServer(new Clsid(params.clsid), params.address, session);
				await comServer.init();

				var comObject = await comServer.createInstance();

				var opcServer = new opcda.OPCServer();
				await opcServer.init(comObject);

				var opcBrowser = await opcServer.getBrowser();
				var itemList = await opcBrowser.browseAllFlat();

				opcBrowser.end()
					.then(() => opcServer.end())
					.then(() => comServer.closeStub())
					.catch(e => RED.log.error(`Error closing browse session: ${e}`));

				res.status(200).send({items: itemList});
			} catch (e) {
				const msg = formatBrowseError(e);
				RED.log.error(`OPC DA browse: ${msg}`);
				if (e && e.stack) RED.log.error(e.stack);
				res.status(500).send({error: msg});
			}
		}

		browseItems();
	});

    function OPCDAServer(config) {
        RED.nodes.createNode(this,config);
        const node = this;
		
		node.config = config;

		
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
