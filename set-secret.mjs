import { spawn } from 'child_process';

const secret = process.argv[2];
const name = process.argv[3];
if (!secret || !name) { console.error('Usage: node set-secret.mjs <value> <name>'); process.exit(1); }

const child = spawn('npx', ['wrangler', 'secret', 'put', name], {
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: true,
});

child.stdin.write(Buffer.from(secret, 'utf8'));
child.stdin.end();

child.on('exit', (code) => {
  console.log('exit code:', code);
});
