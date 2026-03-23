const fs = require('fs');
const file = '/usr/src/node-red/node_modules/node-dcom/dcom/rpc/security/ntlmauthentication.js';
let code = fs.readFileSync(file, 'utf8');

// Add password length and MD4 check debug
code = code.replace(
  'let target = null;',
  `let target = null;
    console.log("[NTLM-DBG] domain=" + info.domain + " user=" + this.credentials.username + " pwdLen=" + (this.credentials.password ? this.credentials.password.length : "NULL"));
    try { const _h = Crypto.createHash('md4'); _h.update(Buffer.from(this.credentials.password || '', 'utf16le')); console.log("[NTLM-DBG] md4-ok ntHash=" + _h.digest('hex')); } catch(e) { console.log("[NTLM-DBG] md4-FAIL: " + e.message); }`
);

fs.writeFileSync(file, code);

// Verify loads
try { require('node-opc-da'); console.log('Patched OK, module loads'); }
catch(e) { console.log('Load result:', e.message); }
