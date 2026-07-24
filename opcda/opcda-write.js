module.exports = function(RED) {
	const opcda = require('@tier0/node-opc-da');
	const { OPCServer } = opcda;
    const { ComServer, Session, Clsid, ComString} = opcda.dcom;
	const {
		cleanupStep,
		createReconnectController,
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
					await node.comServer.init();
					node.comObject = await node.comServer.createInstance();
					node.opcServer = new OPCServer();
					await node.opcServer.init(node.comObject);
					serverHandles = {};
					clientHandle = 0;
					node.opcGroup = await node.opcServer.addGroup(config.id, null);
					node.opcItemMgr = await node.opcGroup.getItemManager();
					node.opcSyncIO = await node.opcGroup.getSyncIO();
				}, timeout, 'OPCDA write init');

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
				await node.destroy();
				throw error;
			}
		}
	
		node.destroy = async function(){
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

			const cleanupTimeout = 5000;
			if (refs.opcServer && refs.opcGroup &&
				typeof refs.opcServer.removeGroup === 'function') {
				await cleanupStep(node, 'remove OPC write group',
					() => refs.opcServer.removeGroup(refs.opcGroup, true), cleanupTimeout);
			}
			if (refs.opcSyncIO) {
				await cleanupStep(node, 'release write SyncIO',
					() => refs.opcSyncIO.end(), cleanupTimeout);
			}
			if (refs.opcItemMgr) {
				await cleanupStep(node, 'release write ItemManager',
					() => refs.opcItemMgr.end(), cleanupTimeout);
			}
			if (refs.opcGroup) {
				await cleanupStep(node, 'release OPC write group',
					() => refs.opcGroup.end(), cleanupTimeout);
			}
			if (refs.opcServer) {
				await cleanupStep(node, 'release OPC write server',
					() => refs.opcServer.end(), cleanupTimeout);
			}
			if (refs.comObject && typeof refs.comObject.release === 'function') {
				await cleanupStep(node, 'release write root COM object',
					() => refs.comObject.release(), cleanupTimeout);
			}
			if (refs.comSession && typeof refs.comSession.destroySession === 'function') {
				await cleanupStep(node, 'destroy write DCOM session',
					() => refs.comSession.destroySession(refs.comSession), cleanupTimeout);
			}
			if (refs.comServer) {
				await cleanupStep(node, 'close write DCOM transport',
					() => refs.comServer.closeStub(), cleanupTimeout);
			}
		}
		
		async function writeGroup(itemValues){
			
			try{
				node.isWriting = true;
				node.updateStatus("writing");
				
				var objects = [];
				for(const itemValue of itemValues){
					if(!(itemValue.itemID in serverHandles)){
						clientHandle++;
						var item = [{itemID: itemValue.itemID, clientHandle: clientHandle}];
						var addedItem = await node.opcItemMgr.add(item);

						if ((addedItem[0])[0] !== 0) {
							node.warn(`Error adding item '${item[0].itemID}'`);
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

				await node.opcSyncIO.write(objects);
				
				var msg = { payload: true };
				node.send(msg);	
				
				node.updateStatus("ready");
				node.reconnectController.markHealthy();
			}
			catch(e){
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
			node.destroy().then(done).catch(function(error){
				node.error('OPCDA write close error: ' + messageOf(error));
				done();
			});
		});
    }
	
    RED.nodes.registerType("tier0-opcda-write",OPCDAWrite);
}
