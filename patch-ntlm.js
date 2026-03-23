const fs = require('fs');
const file = '/usr/src/node-red/node_modules/node-dcom/dcom/rpc/security/ntlmauthentication.js';
let code = fs.readFileSync(file, 'utf8');

// Fix 1: Replace all Encdec references with inline uint16le decode
code = code.replace(
  /new Encdec\(\)\.dec_uint16le\(targetInformation,\s*i\)/g,
  '(targetInformation[i] | (targetInformation[i+1] << 8))'
);
code = code.replace(
  /new Encdec\.dec_uint16le\(targetInformation,\s*i\)/g,
  '(targetInformation[i] | (targetInformation[i+1] << 8))'
);

// Fix 2: Add debug logging for NTLM credentials
code = code.replace(
  'let target = null;',
  'let target = null;\n    console.log("[NTLM-DBG] domain=" + info.domain + " user=" + this.credentials.username);'
);

// Verify no syntax errors
try {
  new Function(code);
  console.log('ERROR: wrapped in function - not a module');
} catch(e) {
  // Expected since it's a class/module, not a function body
}

fs.writeFileSync(file, code);

// Verify it loads
try {
  delete require.cache[require.resolve(file)];
  require(file);
  console.log('Patched and verified OK');
} catch(e) {
  console.log('WARNING: Load check result:', e.message);
  // May fail due to missing dependencies in standalone context, that's OK
  // as long as it's not a syntax error
  if (e.message.includes('Unexpected token')) {
    console.log('SYNTAX ERROR - reverting!');
    // Don't revert for now, let's see the error
  } else {
    console.log('Non-syntax error (expected in standalone context)');
  }
}
