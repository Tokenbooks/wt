const fs = require('node:fs');
const path = require('node:path');

console.log('Linking CLI...');

try {
  const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');

  if (!fs.existsSync(cliPath)) {
    throw new Error(
      `CLI file not found at ${cliPath}. Make sure to run 'tsc' first.`,
    );
  }

  // Make executable
  fs.chmodSync(cliPath, '755');

  // Add shebang if not present
  let content = fs.readFileSync(cliPath, 'utf8');
  if (!content.startsWith('#!/usr/bin/env node')) {
    content = '#!/usr/bin/env node\n' + content;
    fs.writeFileSync(cliPath, content);
  }

  console.log('CLI prepared at', cliPath);
} catch (error) {
  console.error('CLI linking failed:', error.message);
  process.exit(1);
}
