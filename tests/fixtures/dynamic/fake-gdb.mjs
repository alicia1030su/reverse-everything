import readline from 'node:readline';

const args = process.argv.slice(2);
if (args.join(' ') !== '--quiet --nx --interpreter=mi2') {
  process.stderr.write('unexpected arguments\n');
  process.exit(90);
}
const mode = process.env.FAKE_GDB_MODE ?? 'normal';
if (mode === 'malformed') { process.stdout.write('(gdb) '); setInterval(() => process.stdout.write('"unterminated\n(gdb) '), 20); }
else if (mode === 'hang') process.stdout.write('(gdb) ');
else if (mode === 'flood') { process.stdout.write('(gdb) '); setInterval(() => process.stdout.write('~"' + 'x'.repeat(1024) + '"\n'), 2); }
else process.stdout.write('=thread-group-added,id="i1"\n(gdb) \n');
let token = 0;
let running = false;
let argumentsReceived = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const match = /^(\d+)([^\s]+)(?: (.*))?$/.exec(line);
  if (!match) return;
  const [, number, command, payload] = match;
  const id = Number(number);
  if (mode === 'malformed') { process.stdout.write('"unterminated\n(gdb) '); return; }
  if (mode === 'hang' || mode === 'flood') { /* Deliberately never respond to the command. */ }
  else if (command === '-file-exec-and-symbolic') { process.stderr.write('warning: non-MI debugger diagnostic\n'); process.stdout.write(`${id}^done,value={}\n(gdb) `); }
  else if (command === '-exec-arguments') { argumentsReceived = true; process.stdout.write(`${id}^done\n(gdb) `); }
  else if (command === '-break-insert') process.stdout.write(`${id}^done,bkpt={number="1",addr="0x0000000000401136",type="breakpoint"}\n(gdb) `);
  else if (command === '-exec-run') {
    if (payload || (mode === 'with-args' && !argumentsReceived)) { process.stdout.write(`${id}^error,msg="expected -exec-arguments before argument-free -exec-run"\n(gdb) `); return; }
    running = true;
    process.stdout.write(`${id}^running\n*running,thread-id="all"\n(gdb) `);
    setTimeout(() => {
      process.stdout.write('*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",thread-id="1",stopped-threads="all",core="1"\n' +
        '=thread-group-started,id="i1",pid="4242"\n(gdb) ');
    }, 5);
  } else if (command === '-exec-continue') {
    process.stdout.write(`${id}^running\n*running,thread-id="all"\n(gdb) `);
    running = false;
    setTimeout(() => process.stdout.write('*stopped,reason="exited-normally"\n(gdb) '), 5);
  } else if (command === '-thread-info') process.stdout.write(`${id}^done,threads=[current-thread-id="1",threads=[{id="1",frame={level="0",addr="0x401136",func="main"},state="stopped"},{id="2",frame={level="0",addr="0x401140",func="worker"},state="running"}]]\n(gdb) `);
  else if (command === '-stack-list-frames') process.stdout.write(`${id}^done,stack=[frame={level="0",addr="0x401136",func="main",file="sample.c",line="15"},frame={level="1",addr="0x401200",func="worker"}]\n(gdb) `);
  else if (command === '-data-list-register-values') process.stdout.write(`${id}^done,register-values=[{number="0",name="rip",value="0x401136"},{number="1",name="rax",value="0x2"}]\n(gdb) `);
  else if (command === '-interpreter-exec') {
    process.stdout.write('~"0x0000000000401000 0x0000000000402000 0x0000000000001000 /sample\\n"\n');
    process.stdout.write('~"0x00007ffff7c00000 0x00007ffff7c01000 /lib/libc.so\\n"\n');
    process.stdout.write(`${id}^done\n(gdb) `);
  } else if (command === '-gdb-exit') { process.stdin.destroy(); process.exit(0); }
  else process.stdout.write(`${id}^error,msg="unsupported fake command"\n(gdb) `);
  void payload;
  void token;
  void running;
  void argumentsReceived;
});
