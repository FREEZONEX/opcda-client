const fs = require('fs');
const file = '/usr/src/node-red/node_modules/node-dcom/dcom/rpc/security/ntlmauthentication.js';
let code = fs.readFileSync(file, 'utf8');
code = code.replace(
  'let target = null;',
  'let target = null;\n    console.log("[NTLM-DBG] domain=" + info.domain + " user=" + this.credentials.username);'
);
code = code.replace(
  "if (target == '') {",
  "console.log('[NTLM-DBG] target=' + target);\n      if (target == '') {"
);
fs.writeFileSync(file, code);
console.log('Patched.');
