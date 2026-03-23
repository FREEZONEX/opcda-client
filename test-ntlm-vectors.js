// MS-NLMP Appendix A test vectors for NTLMv2
// Reference: https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-nlmp/
const Crypto = require('crypto');

// Force legacy provider for MD4
process.env.NODE_OPTIONS = '--openssl-legacy-provider';

const Responses = require('/usr/src/node-red/node_modules/node-dcom/dcom/rpc/security/responses.js');

const r = new Responses();

// MS-NLMP test vectors
const User = 'User';
const UserDom = 'Domain';
const Passwd = 'Password';
const ServerChallenge = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef];
const ClientChallenge = [0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa];
const Time = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

// Expected values from MS-NLMP spec
const EXPECTED_NT_HASH = 'a4f49c406510bdcab6824ee7c30fd852';
const EXPECTED_NTLMv2_HASH = '0c868a403bfd7a93a3001ef22ef02e3f';

// Test 1: NT Hash (MD4 of UTF-16LE password)
console.log('=== Test 1: NT Hash ===');
const ntHash = r.ntlmHash(Passwd);
const ntHashHex = Buffer.from(ntHash).toString('hex');
console.log('Computed:', ntHashHex);
console.log('Expected:', EXPECTED_NT_HASH);
console.log('Match:', ntHashHex === EXPECTED_NT_HASH ? 'PASS' : 'FAIL');

// Test 2: NTLMv2 Hash
console.log('\n=== Test 2: NTLMv2 Hash ===');
const ntlmv2Hash = r.ntlmv2Hash(UserDom, User, Passwd);
const ntlmv2HashHex = Buffer.from(ntlmv2Hash).toString('hex');
console.log('Computed:', ntlmv2HashHex);
console.log('Expected:', EXPECTED_NTLMv2_HASH);
console.log('Match:', ntlmv2HashHex === EXPECTED_NTLMv2_HASH ? 'PASS' : 'FAIL');

// Test 3: LMv2 Response
console.log('\n=== Test 3: LMv2 Response ===');
const lmv2 = r.getLMv2Response(UserDom, User, Passwd, ServerChallenge, ClientChallenge);
const lmv2Hex = Buffer.from(lmv2).toString('hex');
console.log('Computed:', lmv2Hex);
// Expected from MS-NLMP: d6e6152ea25d03b7c6ba6629c2d6aaf0aaaaaaaaaaaaaaaa
const EXPECTED_LMv2 = 'd6e6152ea25d03b7c6ba6629c2d6aaf0aaaaaaaaaaaaaaaa';
console.log('Expected:', EXPECTED_LMv2);
console.log('Match:', lmv2Hex === EXPECTED_LMv2 ? 'PASS' : 'FAIL');

// Test 4: hmacMD5 argument order verification
console.log('\n=== Test 4: HMAC-MD5 argument order ===');
const testHmac = r.hmacMD5([0x01, 0x02, 0x03], [0x04, 0x05, 0x06]);
console.log('hmacMD5([1,2,3], [4,5,6]) =', Buffer.from(testHmac).toString('hex'));
// Verify: HMAC-MD5(key=040506, data=010203) 
const verifyHmac = Crypto.createHmac('md5', Buffer.from([0x04, 0x05, 0x06]));
verifyHmac.update(Buffer.from([0x01, 0x02, 0x03]));
console.log('Crypto.HMAC(key=040506, data=010203) =', verifyHmac.digest('hex'));

// Test 5: NTLMv2 Response with known blob
console.log('\n=== Test 5: NTLMv2 Response ===');
// Build a minimal target info for testing
const targetInfo = [
    0x02, 0x00, 0x0c, 0x00,  // MsvAvNbDomainName, len=12
    0x44, 0x00, 0x6f, 0x00, 0x6d, 0x00, 0x61, 0x00, 0x69, 0x00, 0x6e, 0x00,  // "Domain" in UTF-16LE
    0x01, 0x00, 0x0c, 0x00,  // MsvAvNbComputerName, len=12
    0x53, 0x00, 0x65, 0x00, 0x72, 0x00, 0x76, 0x00, 0x65, 0x00, 0x72, 0x00,  // "Server" in UTF-16LE
    0x00, 0x00, 0x00, 0x00   // MsvAvEOL
];

// Test blob creation
const blob = r.createBlob(targetInfo, ClientChallenge);
console.log('Blob length:', blob.length);
console.log('Blob header (first 8):', Buffer.from(blob.slice(0, 8)).toString('hex'));
console.log('Blob timestamp (next 8):', Buffer.from(blob.slice(8, 16)).toString('hex'));
console.log('Blob clientNonce (next 8):', Buffer.from(blob.slice(16, 24)).toString('hex'));

// Verify blob structure
console.log('\nBlob structure check:');
console.log('Byte 0-1 (signature):', blob[0] === 1 && blob[1] === 1 ? 'PASS (0x0101)' : 'FAIL');
console.log('Byte 2-7 (zeros):', blob.slice(2, 8).every(b => b === 0) ? 'PASS' : 'FAIL');
console.log('Byte 16-23 (client nonce):', Buffer.from(blob.slice(16, 24)).toString('hex') === 'aaaaaaaaaaaaaaaa' ? 'PASS' : 'FAIL');
console.log('Byte 24-27 (Z4):', blob.slice(24, 28).every(b => b === 0) ? 'PASS' : 'FAIL');

// Verify the full NTLMv2 response computation
const retval = r.getNTLMv2Response(UserDom, User, Passwd, targetInfo, ServerChallenge, ClientChallenge);
console.log('\nNTLMv2Response length:', retval[0].length);
console.log('NTProofStr:', Buffer.from(retval[0].slice(0, 16)).toString('hex'));

// Test session base key
const ntProofStr = retval[0].slice(0, 16);
const hashForSession = r.ntlmv2Hash(UserDom, User, Passwd);
const sessionBaseKey = r.hmacMD5(ntProofStr, hashForSession);
console.log('SessionBaseKey:', Buffer.from(sessionBaseKey).toString('hex'));

// Now test with actual credentials
console.log('\n\n=== Test with actual credentials ===');
const actualNtHash = r.ntlmHash('Supos@1304');
console.log('NT Hash (Supos@1304):', Buffer.from(actualNtHash).toString('hex'));
const actualV2Hash = r.ntlmv2Hash('DESKTOP-BBD7VBL', 'Administrator', 'Supos@1304');
console.log('NTLMv2 Hash:', Buffer.from(actualV2Hash).toString('hex'));
