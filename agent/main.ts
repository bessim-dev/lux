import { runCli } from './cli';

if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write(`lux requires Node.js 22 or newer; this is ${process.versions.node}.\n`);
  process.exit(1);
}

const result = await runCli(process.argv.slice(2), { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) }, process.env);
// 'serving': the stdio server keeps the process alive until the client closes stdin.
if (result !== 'serving') process.exitCode = result;
