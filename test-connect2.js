const opcda = require('node-opc-da');
const { OPCServer } = opcda;
const { ComServer, Session, Clsid } = opcda.dcom;

async function test(domain) {
    console.log('\n--- Testing with domain="' + domain + '" ---');
    try {
        var session = new Session();
        session = session.createSession(domain, 'Administrator', 'Supos@1304');
        session.setGlobalSocketTimeout(10000);

        var comServer = new ComServer(
            new Clsid('7BC0CC8E-482C-47CA-ABDC-0FE7F9C6E729'),
            '192.168.31.75', session);
        
        await comServer.init();
        console.log('SUCCESS with domain="' + domain + '"');
        await comServer.closeStub();
    } catch (e) {
        var code = typeof e === 'number' ? '0x' + (e >>> 0).toString(16) : (e.message || String(e));
        console.log('FAILED:', code);
    }
}

(async () => {
    await test('DESKTOP-BBD7VBL');
    await test('.');
    await test('');
    await test('WORKGROUP');
})();
