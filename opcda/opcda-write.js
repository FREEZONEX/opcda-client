module.exports = function(RED) {
	const opcda = require('@tier0/node-opc-da');
	const { OPCServer } = opcda;
    const { ComServer, Session, Clsid, ComString} = opcda.dcom;
	const {
		cleanupStep,
		createReconnectController,
		forceCleanup,
		isTransportFatal,
		messageOf,
		withTimeout,
	} = require('./lifecycle');
	
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
		0x00000061 : "Clsid syntax is invalid"
	};
	
	const itemTypes = {
		"double" : opcda.dcom.Types.DOUBLE,
		"short" : opcda.dcom.Types.SHORT,
		"integer" : opcda.dcom.Types.INTEGER,
		"float" : opcda.dcom.Types.FLOAT,
		"byte" : opcda.dcom.Types.BYTE,
		"long" : opcda.dcom.Types.LONG,
		"boolean" : opcda.dcom.Types.BOOLEAN,
		"uuid" : opcda.dcom.Types.UUID,
		"string" : opcda.dcom.Types.COMSTRING,
		"char" : opcda.dcom.Types.CHARACTER,
		"date" : opcda.dcom.Types.DATE,
		"currency" : opcda.dcom.Types.CURRENCY,
		"array" : opcda.dcom.Types.ARRAY
	};

	function writeInputError(message, details) {
		const error = new Error(message);
		error.code = 'OPCDA_WRITE_INPUT';
		error.reconnect = false;
		if (details) error.details = details;
		return error;
	}

	function resultCode(value) {
		const raw = value && typeof value.getValue === 'function' ? value.getValue() : value;
		const code = Number(raw);
		return Number.isFinite(code) ? code : NaN;
	}
    
	function OPCDAWrite(config) {
        RED.nodes.createNode(this,config);
        let node = this;
			
		let server = RED.nodes.getNode(config.server);

		node.opcItemMgr = null;
		node.opcSyncIO = null;
		node.opcGroup = null;
		node.opcServer = null;
		node.comServer = null;
		node.comSession = null;
		node.comObject = null;

		let clientHandle = 0;

		let serverHandles = {};
		
		node.isConnected = false;
		node.isWriting = false;
		node.isConnecting = false;
		
		if(!server){
			node.error("Please select a server.");
			return;
		}

		if (!server.credentials) {
            node.error("Failed to load credentials!");
			return;
        }	
		
		node.updateStatus = function(status){
			switch(status){
				case "disconnected":
					node.status({fill:"red",shape:"ring",text:"Disconnected"});
					break;
				case "connecting":
					node.status({fill:"yellow",shape:"ring",text:"Connecting"});
					break;
				case "ready":
					node.status({fill:"green",shape:"ring",text:"Ready"});
					break;
				case "writing":
					node.status({fill:"blue",shape:"ring",text:"Writing"});
					break;
				case "error":
					node.status({fill:"red",shape:"ring",text:"Error"});
					break;
				case "reconnecting":
					node.status({fill:"yellow",shape:"ring",text:"Reconnecting"});
					break;
				case "cooldown":
					node.status({fill:"yellow",shape:"dot",text:"Resource cooldown"});
					break;
				case "stopped":
					node.status({fill:"red",shape:"dot",text:"Reconnect stopped"});
					break;
				case "mismatch":
					node.status({fill:"yellow",shape:"ring",text:"Mismatch"});
					break;
				default:
					node.status({fill:"grey",shape:"ring",text:"Unknown"});
					break;
			}
		}	

		node.init = async function(){
			if (node.isConnected) return;

			const configuredTimeout = Number.parseInt(server.config.timeout, 10);
			const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ?
				configuredTimeout : 15000;
			node._diagStep = 'start';
			node.isConnecting = true;
			node.updateStatus('connecting');

			try {
				node.comSession = new Session().createSession(
					server.config.domain,
					server.credentials.username,
					server.credentials.password,
				);
				node.comSession.setGlobalSocketTimeout(timeout);

				await withTimeout(async () => {
					node.comServer = new ComServer(
						new Clsid(server.config.clsid),
						server.config.address,
						node.comSession,
					);
					node._diagStep = 'comServer.init';
					await node.comServer.init();
					node._diagStep = 'comServer.createInstance';
					node.comObject = await node.comServer.createInstance();
					node._diagStep = 'opcServer.init';
					node.opcServer = new OPCServer();
					await node.opcServer.init(node.comObject);
					serverHandles = {};
					clientHandle = 0;
					node.opcGroup = await node.opcServer.addGroup(config.id, null);
					node.opcItemMgr = await node.opcGroup.getItemManager();
					node.opcSyncIO = await node.opcGroup.getSyncIO();
				}, timeout, 'OPCDA write initialization');

				node.isConnected = true;
				node.updateStatus('ready');
				if (node.comServer && typeof node.comServer.once === 'function') {
					node.comServer.once('disconnected', () => {
						node.isConnected = false;
						node.updateStatus('disconnected');
						node.reconnectController.reconnect(
							new Error('DCOM transport disconnected'),
							'disconnect',
						);
					});
				}
			} catch (error) {
				const closing = node.reconnectController && node.reconnectController.isClosing();
				if (!closing) {
					node.error(`[OPCDA-DIAG] Write initialization failed at: ${node._diagStep}`);
				}
				await node.destroy(error);
				throw error;
			} finally {
				node.isConnecting = false;
			}
		}
	
		node.destroy = async function(error){
			node.isConnected = false;
			node.isWriting = false;
			const refs = {
				opcSyncIO: node.opcSyncIO,
				opcItemMgr: node.opcItemMgr,
				opcGroup: node.opcGroup,
				opcServer: node.opcServer,
				comServer: node.comServer,
				comSession: node.comSession,
				comObject: node.comObject,
			};
			node.opcSyncIO = null;
			node.opcItemMgr = null;
			node.opcGroup = null;
			node.opcServer = null;
			node.comServer = null;
			node.comSession = null;
			node.comObject = null;
			serverHandles = {};
			clientHandle = 0;
			if (!Object.values(refs).some(Boolean)) return;

			const cleanupTimeout = 5000;
			if (isTransportFatal(error)) {
				node.warn(
					`OPCDA cleanup: transport is unusable (${messageOf(error)}); ` +
					`closing it without remote COM release calls.`,
				);
				await forceCleanup(node, refs, 'OPC write', cleanupTimeout);
				return;
			}

			const gracefulStep = async function(label, action) {
				const completed = await cleanupStep(node, label, action, cleanupTimeout);
				if (!completed) {
					node.warn(
						'OPCDA cleanup: graceful release did not complete; ' +
						'forcing local transport teardown.',
					);
					await forceCleanup(node, refs, 'OPC write', cleanupTimeout);
				}
				return completed;
			};

			if (refs.opcServer && refs.opcGroup &&
				typeof refs.opcServer.removeGroup === 'function') {
				if (!await gracefulStep(
					'remove OPC write group',
					() => refs.opcServer.removeGroup(refs.opcGroup, true),
				)) return;
			}
			if (refs.opcSyncIO) {
				if (!await gracefulStep(
					'release write SyncIO',
					() => refs.opcSyncIO.end(),
				)) return;
			}
			if (refs.opcItemMgr) {
				if (!await gracefulStep(
					'release write ItemManager',
					() => refs.opcItemMgr.end(),
				)) return;
			}
			if (refs.opcGroup) {
				if (!await gracefulStep(
					'release OPC write group',
					() => refs.opcGroup.end(),
				)) return;
			}
			if (refs.opcServer) {
				if (!await gracefulStep(
					'release OPC write server',
					() => refs.opcServer.end(),
				)) return;
			}
			if (refs.comObject && typeof refs.comObject.release === 'function') {
				if (!await gracefulStep(
					'release write root COM object',
					() => refs.comObject.release(),
				)) return;
			}
			if (refs.comSession && typeof refs.comSession.destroySession === 'function') {
				if (!await gracefulStep(
					'destroy write DCOM session',
					() => refs.comSession.destroySession(refs.comSession),
				)) return;
			}
			if (refs.comServer) {
				await gracefulStep(
					'close write DCOM transport',
					() => refs.comServer.closeStub(),
				);
			}
		}
		
		async function writeGroup(itemValues){
			
			try{
				if (!Array.isArray(itemValues) || itemValues.length === 0) {
					throw writeInputError('msg.payload must be a non-empty array of OPC write items.');
				}
				node.isWriting = true;
				node.updateStatus("writing");
				
				var objects = [];
				const addFailures = [];
				for(const itemValue of itemValues){
					if (!itemValue || typeof itemValue !== 'object') {
						throw writeInputError('Each OPC write item must be an object.');
					}
					if (typeof itemValue.itemID !== 'string' || itemValue.itemID.trim() === '') {
						throw writeInputError('Each OPC write item must contain a non-empty itemID.');
					}
					if (!Object.prototype.hasOwnProperty.call(itemTypes, itemValue.type)) {
						throw writeInputError(
							`Unsupported OPC write type '${itemValue.type}' for '${itemValue.itemID}'.`,
						);
					}
					if(!(itemValue.itemID in serverHandles)){
						clientHandle++;
						var item = [{itemID: itemValue.itemID, clientHandle: clientHandle}];
						var addedItem = await node.opcItemMgr.add(item);

						if ((addedItem[0])[0] !== 0) {
							node.warn(`Error adding item '${item[0].itemID}'`);
							addFailures.push({itemID: itemValue.itemID, errorCode: (addedItem[0])[0]});
							continue;
						} 

						else {
							serverHandles[itemValue.itemID] = (addedItem[0])[1].serverHandle;
						}
					}

					var object = {
						value: itemValue.type == 'string' ? new ComString(itemValue.value, null) : itemValue.value,
						handle: serverHandles[itemValue.itemID],
						type: itemTypes[itemValue.type]
					};
					
					objects.push(object);
				}
				if (addFailures.length > 0) {
					throw writeInputError('One or more OPC items could not be added.', addFailures);
				}

				const configuredTimeout = Number.parseInt(server.config.timeout, 10);
				const writeTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ?
					configuredTimeout : 15000;
				const writeResults = await withTimeout(
					() => node.opcSyncIO.write(objects),
					writeTimeout,
					'OPCDA write',
				);
				const writeFailures = (writeResults || [])
					.map((value, index) => ({
						itemID: itemValues[index] && itemValues[index].itemID,
						errorCode: resultCode(value),
					}))
					.filter(result => !Number.isFinite(result.errorCode) || result.errorCode !== 0);
				if (!Array.isArray(writeResults) || writeResults.length !== objects.length ||
					writeFailures.length > 0) {
					throw writeInputError('OPC DA server rejected one or more write values.', writeFailures);
				}
				
				var msg = { payload: true };
				node.send(msg);	
				
				node.updateStatus("ready");
				node.reconnectController.markHealthy();
			}
			catch(e){
				if (node.reconnectController.isClosing()) return;
				if (e && e.reconnect === false) {
					node.warn(`OPCDA write failed without reconnect: ${messageOf(e)}`);
					node.updateStatus(node.isConnected ? 'ready' : 'disconnected');
					node.send({payload: false, error: messageOf(e), details: e.details});
					return;
				}
				node.isConnected = false;
				node.updateStatus('error');
				node.reconnectController.reconnect(e, 'write');

				var msg = { payload: false };
				node.send(msg);	
			}
			finally{
				node.isWriting = false;
			}
		}

		node.reconnectController = createReconnectController({
			node,
			connect: node.init,
			destroy: node.destroy,
			resourceCooldownMs: (() => {
				const minutes = Number(server.config.reconnectinterval);
				return (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60 * 1000;
			})(),
		});
		void node.reconnectController.start();
		
		node.on('input', function(msg){
			if(node.isConnected && !node.isWriting){
				void writeGroup(msg.payload);
			}
        });	
	
		node.on('close', function(done){
			node.reconnectController.stop();
			node.status({});
			const closeError = (node.isWriting || node.isConnecting) ? Object.assign(
				new Error('Node-RED is closing during an active OPC DA operation.'),
				{code: 'DCOM_NODE_CLOSING', transportFatal: true},
			) : undefined;
			node.destroy(closeError).then(done).catch(function(error){
				node.error('OPCDA write close error: ' + messageOf(error));
				done();
			});
		});
    }
	
    RED.nodes.registerType("tier0-opcda-write",OPCDAWrite);
}
