const opcda = require('node-opc-da');
const { OPCServer } = opcda;
const { ComServer, Session, Clsid } = opcda.dcom;

const config = {
    address: '192.168.31.75',
    domain: 'DESKTOP-BBD7VBL',
    username: 'Administrator',
    password: 'Supos@1304',
    clsid: '7BC0CC8E-482C-47CA-ABDC-0FE7F9C6E729',
    timeout: 10000
};

async function test() {
    console.log('=== OPC DA Connection Test ===');
    console.log('Address:', config.address);
    console.log('Domain:', config.domain);
    console.log('Username:', config.username);
    console.log('CLSID:', config.clsid);
    console.log('');

    try {
        console.log('[1] Creating session...');
        var session = new Session();
        session = session.createSession(config.domain, config.username, config.password);
        session.setGlobalSocketTimeout(config.timeout);
        console.log('[1] Session created OK');

        console.log('[2] Creating ComServer...');
        var comServer = new ComServer(new Clsid(config.clsid), config.address, session);
        console.log('[2] ComServer created, calling init()...');
        
        await comServer.init();
        console.log('[2] ComServer.init() OK!');

        console.log('[3] Creating COM instance...');
        var comObject = await comServer.createInstance();
        console.log('[3] COM instance created OK!');

        console.log('[4] Creating OPC Server...');
        var opcServer = new OPCServer();
        await opcServer.init(comObject);
        console.log('[4] OPC Server connected!');

        console.log('[5] Getting browser...');
        var browser = await opcServer.getBrowser();
        var items = await browser.browseAllFlat();
        console.log('[5] Found', items.length, 'items');
        items.slice(0, 10).forEach(i => console.log('   ', i));

        await browser.end();
        await opcServer.end();
        await comServer.closeStub();
        console.log('\n=== SUCCESS ===');
    } catch (e) {
        console.log('\n=== FAILED ===');
        console.log('Error type:', typeof e);
        console.log('Error value:', e);
        if (e instanceof Error) {
            console.log('Message:', e.message);
            console.log('Stack:', e.stack);
        }
        if (typeof e === 'number') {
            console.log('Hex:', '0x' + (e >>> 0).toString(16));
        }
    }
}

test();
