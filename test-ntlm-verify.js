const Crypto = require('crypto');

// Verify DES update() vs final() behavior in this Node.js version
console.log('=== Node.js version:', process.version, '===');
console.log('=== OpenSSL version:', process.versions.openssl, '===\n');

// Test 1: DES-ECB update() behavior
console.log('--- Test 1: DES-ECB update vs final ---');
const key1 = Buffer.from('0123456789ABCDEF', 'hex');
const data1 = Buffer.from('4E6F772069732074', 'hex');
const des1 = Crypto.createCipheriv('des-ecb', key1, '');
const update1 = des1.update(data1);
const final1 = des1.final();
console.log('update() returned', update1.length, 'bytes:', update1.toString('hex'));
console.log('final()  returned', final1.length, 'bytes:', final1.toString('hex'));
console.log('Expected update=3fa40e8a984d4815 (8 bytes)\n');

// Test 2: Verify NT hash
console.log('--- Test 2: NT Hash of Supos@1304 ---');
const md4 = Crypto.createHash('md4');
md4.update(Buffer.from('Supos@1304', 'utf16le'));
const ntHash = md4.digest();
console.log('NT Hash:', ntHash.toString('hex'));
console.log('Length:', ntHash.length, '\n');

// Test 3: NTLM2 Session Response with known values
console.log('--- Test 3: Full NTLM2 Session Response ---');
const Responses = require('node-opc-da/node_modules/node-dcom/dcom/rpc/security/responses.js');
const r = new Responses();

const fakeChallenge = Buffer.from('0123456789abcdef', 'hex');
const fakeClientNonce = Buffer.from('ffffff0011223344', 'hex');
const testResponse = r.getNTLM2SessionResponse('Password', fakeChallenge, fakeClientNonce);
console.log('Response type:', typeof testResponse, testResponse.constructor.name);
console.log('Response length:', testResponse.length);
console.log('Response hex:', testResponse.toString('hex'));

// Independent verification of the same computation
const ntHash2 = Crypto.createHash('md4').update(Buffer.from('Password', 'utf16le')).digest();
console.log('\nIndependent NT hash:', ntHash2.toString('hex'));
const sessionNonce = Buffer.concat([fakeChallenge, fakeClientNonce]);
const sessionHash = Crypto.createHash('md5').update(sessionNonce).digest().slice(0, 8);
console.log('Session hash:', sessionHash.toString('hex'));

// Manual DES with NT hash
function createDESKey(bytes, offset) {
    let keyBytes = bytes.slice(offset, 7 + offset);
    let material = Buffer.alloc(8);
    material[0] = keyBytes[0];
    material[1] = ((keyBytes[0] << 7) & 0xff | ((keyBytes[1] & 0xff) >>> 1));
    material[2] = ((keyBytes[1] << 6) & 0xff | ((keyBytes[2] & 0xff) >>> 2));
    material[3] = ((keyBytes[2] << 5) & 0xff | ((keyBytes[3] & 0xff) >>> 3));
    material[4] = ((keyBytes[3] << 4) & 0xff | ((keyBytes[4] & 0xff) >>> 4));
    material[5] = ((keyBytes[4] << 3) & 0xff | ((keyBytes[5] & 0xff) >>> 5));
    material[6] = ((keyBytes[5] << 2) & 0xff | ((keyBytes[6] & 0xff) >>> 6));
    material[7] = ((keyBytes[6] << 1));
    // odd parity
    for (let i = 0; i < 8; i++) {
        let b = material[i];
        let needsParity = (((b >>> 7) ^ (b >>> 6) ^ (b >>> 5) ^ (b >>> 4) ^ (b >>> 3) ^ (b >>> 2) ^ (b >>> 1)) & 0x01) == 0;
        if (needsParity) material[i] |= 0x01;
        else material[i] &= 0xfe;
    }
    return material;
}

const padded = Buffer.concat([ntHash2, Buffer.alloc(5)]);
let manualResult = Buffer.alloc(0);
for (let off of [0, 7, 14]) {
    const k = createDESKey(padded, off);
    const d = Crypto.createCipheriv('des-ecb', k, '');
    const enc = d.update(sessionHash);
    d.final();
    manualResult = Buffer.concat([manualResult, enc]);
}
console.log('Manual response:', manualResult.toString('hex'));
console.log('Match:', testResponse.toString('hex') === manualResult.toString('hex') ? 'YES' : 'NO');
