module.exports = function(RED) {
	const opcda = require('@tier0/node-opc-da');
	const { OPCServer } = opcda;
    const { ComServer, Session, Clsid } = opcda.dcom;
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
	    
	function OPCDARead(config) {
        RED.nodes.createNode(this,config);
		let node = this;
				
		let server = RED.nodes.getNode(config.server);
		let serverHandles, clientHandles;
		const groupItems = Array.isArray(config.groupitems) ? config.groupitems : [];
		
		node.opcServer = null;
		node.comServer = null;
		node.comSession = null;
		node.comObject = null;

		node.opcSyncIO = null;
		node.opcItemMgr = null;

		node.opcGroup = null;

		node.isConnected = false;
		node.isReading = false;

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
				case "timeout":
					node.status({fill:"red",shape:"ring",text:"Timeout"});
					break;
				case "connecting":
					node.status({fill:"yellow",shape:"ring",text:"Connecting"});
					break;
				case "error":
					node.status({fill:"red",shape:"ring",text:"Error"});
					break;
				case "noitem":
					node.status({fill:"yellow",shape:"ring",text:"No Item"});
					break;
				case "badquality":
					node.status({fill:"red",shape:"ring",text:"Bad Quality"});
					break;
				case "goodquality":
					node.status({fill:"blue",shape:"ring",text:"Good Quality"});
					break;
				case "ready":
					node.status({fill:"green",shape:"ring",text:"Ready"});
					break;
				case "reading":
					node.status({fill:"blue",shape:"ring",text:"Reading"});
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
					node.status({fill:"yellow",shape:"ring",text:"Mismatch Data"});
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
					node._diagStep = 'comServer.init';
					await node.comServer.init();

					node._diagStep = 'comServer.createInstance';
					node.comObject = await node.comServer.createInstance();

					node._diagStep = 'opcServer.init';
					node.opcServer = new OPCServer();
					await node.opcServer.init(node.comObject);

					serverHandles = [];
					clientHandles = [];

					node._diagStep = 'addGroup';
					node.opcGroup = await node.opcServer.addGroup(config.id, null);
					node._diagStep = 'getItemManager';
					node.opcItemMgr = await node.opcGroup.getItemManager();
					node._diagStep = 'getSyncIO';
					node.opcSyncIO = await node.opcGroup.getSyncIO();

					let clientHandle = 1;
					const itemsList = groupItems.map(itemID => ({
						itemID,
						clientHandle: clientHandle++,
					}));
					const addedItems = await node.opcItemMgr.add(itemsList);
					for (let i = 0; i < addedItems.length; i++) {
						const addedItem = addedItems[i];
						const item = itemsList[i];
						if (addedItem[0] !== 0) {
							node.warn(`Error adding item '${item.itemID}'`);
						} else {
							serverHandles.push(addedItem[1].serverHandle);
							clientHandles[item.clientHandle] = item.itemID;
						}
					}
				}, timeout, `OPCDA init at ${node._diagStep || 'start'}`);

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
				node.error(`[OPCDA-DIAG] Failed at step: ${node._diagStep || 'unknown'}`);
				node.error(`[OPCDA-DIAG] Error: ${messageOf(error)}`);
				await node.destroy();
				throw error;
			}
		}
	
		node.destroy = async function(){
			node.isConnected = false;
			node.isReading = false;
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
			serverHandles = [];
			clientHandles = [];

			const cleanupTimeout = 5000;
			if (refs.opcServer && refs.opcGroup &&
				typeof refs.opcServer.removeGroup === 'function') {
				await cleanupStep(node, 'remove OPC group',
					() => refs.opcServer.removeGroup(refs.opcGroup, true), cleanupTimeout);
			}
			if (refs.opcSyncIO) {
				await cleanupStep(node, 'release SyncIO',
					() => refs.opcSyncIO.end(), cleanupTimeout);
			}
			if (refs.opcItemMgr) {
				await cleanupStep(node, 'release ItemManager',
					() => refs.opcItemMgr.end(), cleanupTimeout);
			}
			if (refs.opcGroup) {
				await cleanupStep(node, 'release OPC group',
					() => refs.opcGroup.end(), cleanupTimeout);
			}
			if (refs.opcServer) {
				await cleanupStep(node, 'release OPC server',
					() => refs.opcServer.end(), cleanupTimeout);
			}
			if (refs.comObject && typeof refs.comObject.release === 'function') {
				await cleanupStep(node, 'release root COM object',
					() => refs.comObject.release(), cleanupTimeout);
			}
			if (refs.comSession && typeof refs.comSession.destroySession === 'function') {
				await cleanupStep(node, 'destroy DCOM session',
					() => refs.comSession.destroySession(refs.comSession), cleanupTimeout);
			}
			if (refs.comServer) {
				await cleanupStep(node, 'close DCOM transport',
					() => refs.comServer.closeStub(), cleanupTimeout);
			}
		}

		let oldValues = [];
		node.readGroup = async function readGroup(cache){
			var dataSource = cache ? opcda.constants.opc.dataSource.CACHE : opcda.constants.opc.dataSource.DEVICE;

			let valuesTmp = [];
			node.isReading = true;
			node.updateStatus('reading');
			try {
				const valueSets = await node.opcSyncIO.read(dataSource, serverHandles);
					
				var datas = [];
				
				let changed = false;
				let isGood = true;

				for(let i in valueSets){
					
					if(config.datachange){
						if(!changed){
							if(oldValues.length != valueSets.length || valueSets[i].value != oldValues[i]){
								changed = true;
							}
						}
						
						valuesTmp[i] = valueSets[i].value;
						oldValues[i] = valueSets[i].value;			
					}
					
					var quality;
					
					if(valueSets[i].quality >= 0 && valueSets[i].quality < 64){
						quality = "BAD";
						isGood = false;
					}
					else if(valueSets[i].quality >= 64 && valueSets[i].quality < 192){
						quality = "UNCERTAIN";
						isGood = false;
					}
					else if(valueSets[i].quality >= 192 && valueSets[i].quality <= 219){
						quality = "GOOD";
					}
					else{
						quality = "UNKNOWN";
						isGood = false;
					}
					
					var data = {
						itemID: clientHandles[valueSets[i].clientHandle],
						errorCode: valueSets[i].errorCode,
						quality: quality,
						timestamp: valueSets[i].timestamp,
						value: valueSets[i].value,
					}
					
					datas.push(data);
				}
				
				if(isGood){
					if(groupItems.length == datas.length){
						node.updateStatus('goodquality');
					}

					if(groupItems.length != datas.length){
						node.updateStatus('mismatch');
					}

					if(groupItems.length < 1){
						node.updateStatus('noitem');
					}

					if(config.datachange){
						oldValues = valuesTmp;
						if(changed){
							var msg = { payload: datas };
							node.send(msg);						
						}		
					}

					else{
						var msg = { payload: datas };
						node.send(msg);		
					}	
				}
				else{
					node.updateStatus('badquality');
				}
				node.reconnectController.markHealthy();
			} catch(e) {
				node.isConnected = false;
				node.updateStatus("error");
				node.reconnectController.reconnect(e, 'read');
			} finally {
				node.isReading = false;
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

		node.on('input', function(){
			if(node.isConnected && !node.isReading){
				void node.readGroup(config.cache);
			}
        });	

		node.on('close', function(done){
			node.reconnectController.stop();
			node.status({});
			node.destroy().then(done).catch(function(error){
				node.error('OPCDA close error: ' + messageOf(error));
				done();
			});
		});
		
    }
	
    RED.nodes.registerType("tier0-opcda-read",OPCDARead);
}
