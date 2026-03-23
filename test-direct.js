const opcda = require('/usr/src/node-red/node_modules/node-opc-da/src/index.js');
const dcom = require('node-dcom');
const { ComServer, Session, Clsid } = dcom;

const address = '192.168.31.75';
const domain = 'DESKTOP-BBD7VBL';
const username = 'Administrator';
const password = 'Supos@1304';
const clsidStr = '7BC0CC8E-482C-47CA-ABDC-0FE7F9C6E729';

async function main() {
    console.log('=== OPC DA Direct Connection Test ===');

    let comSession, comServer;
    try {
        comSession = new Session();
        comSession = comSession.createSession(domain, username, password);
        comSession.setGlobalSocketTimeout(15000);
        console.log('Session: domain=' + comSession.getDomain() + ' user=' + comSession.getUserName());

        comServer = new ComServer(new Clsid(clsidStr), address, comSession);
        console.log('Connecting...');
        await comServer.init();
        console.log('Connected!');

        const comObject = await comServer.createInstance();
        console.log('Instance created');

        const server = new opcda.OPCServer();
        await server.init(comObject);
        console.log('OPCServer initialized');

        const status = await server.getStatus();
        console.log('Server Status:', JSON.stringify(status, null, 2));

        const browser = await server.getBrowser();
        console.log('Got browser');

        const items = await browser.browse();
        console.log('Items found:', items.length);
        if (items.length > 0) {
            console.log('First 5 items:', items.slice(0, 5));
        }

        console.log('\n=== SUCCESS ===');
    } catch (err) {
        console.error('ERROR:', err.message || err);
        console.error('Stack:', err.stack);
    }
    process.exit(0);
}

main();
