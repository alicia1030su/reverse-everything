import readline from 'node:readline';

const args = process.argv.slice(2);
if (args.join(' ') !== '--quiet --nx --interpreter=mi2') {
  process.stderr.write('unexpected arguments\n');
  process.exit(90);
}
const mode = process.env.FAKE_GDB_MODE ?? 'normal';
let orphanGroupLeaderPid = null;
if (mode === 'ignore-term' || mode === 'crash-with-child') {
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  if (process.env.FAKE_GDB_CHILD_PID_FILE) {
    const { spawn } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(process.env.FAKE_GDB_CHILD_PID_FILE, String(child.pid));
  }
  process.stdout.write('(gdb) ');
} else if (mode === 'separate-group-orphan') {
  const { spawn } = await import('node:child_process');
  const code = "const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],JSON.stringify({leader:process.pid,child:child.pid}));setTimeout(()=>process.exit(0),500);";
  orphanGroupLeaderPid = spawn(process.execPath, ['-e', code, process.env.FAKE_GDB_CHILD_PID_FILE], { detached: true, stdio: 'ignore' }).pid;
  process.stdout.write('(gdb) ');
} else if (mode === 'malformed') { process.stdout.write('(gdb) '); setInterval(() => process.stdout.write('"unterminated\n(gdb) '), 20); }
else if (mode === 'hang') process.stdout.write('(gdb) ');
else if (mode === 'flood') { process.stdout.write('(gdb) '); setInterval(() => process.stdout.write('~"' + 'x'.repeat(1024) + '"\n'), 2); }
else process.stdout.write('=thread-group-added,id="i1"\n(gdb) \n');
let token = 0;
let running = false;
let argumentsReceived = false;
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const match = /^(\d+)([^\s]+)(?: (.*))?$/.exec(line);
  if (!match) return;
  const [, number, command, payload] = match;
  const id = Number(number);
  if (mode === 'malformed') { process.stdout.write('"unterminated\n(gdb) '); return; }
  if (mode === 'crash-with-child' && command === '-file-exec-and-symbols') process.exit(70);
  if (mode === 'hang' || mode === 'flood' || mode === 'ignore-term') { /* Deliberately never respond to the command. */ }
  else if (command === '-file-exec-and-symbols') {
    if (mode === 'exec-check') {
      const { accessSync, constants } = await import('node:fs');
      try { accessSync(JSON.parse(payload), constants.X_OK); } catch { process.stdout.write(`${id}^error,msg="snapshot is not executable"\n(gdb) `); return; }
    }
    process.stderr.write('warning: non-MI debugger diagnostic\n'); process.stdout.write(`${id}^done,value={}\n(gdb) `);
  }
  else if (command === '-exec-arguments') { argumentsReceived = true; process.stdout.write(`${id}^done\n(gdb) `); }
  else if (command === '-break-insert') process.stdout.write(`${id}^done,bkpt={number="1",addr="0x0000000000401136",type="breakpoint"}\n(gdb) `);
  else if (command === '-exec-run') {
    if (payload || (mode === 'with-args' && !argumentsReceived)) { process.stdout.write(`${id}^error,msg="expected -exec-arguments before argument-free -exec-run"\n(gdb) `); return; }
    if (mode === 'separate-group-orphan') {
      const { existsSync } = await import('node:fs');
      const marker = process.env.FAKE_GDB_CHILD_PID_FILE;
      const markerDeadline = Date.now() + 2_000;
      while (marker && !existsSync(marker) && Date.now() < markerDeadline) await new Promise(resolve => setTimeout(resolve, 10));
      process.stdout.write(`${id}^running\n*running,thread-id="all"\n=thread-group-started,id="i1",pid="${orphanGroupLeaderPid}"\n=thread-group-exited,id="i1"\n*stopped,reason="exited-normally"\n(gdb) `);
      return;
    }
    if (mode === 'forged-inferior') {
      process.stdout.write(`${id}^running\n*running,thread-id="all"\n=thread-group-started,id="i1",pid="${process.env.FAKE_GDB_FORGED_PID}"\n*stopped,reason="exited-normally"\n(gdb) `);
      return;
    }
    running = true;
    process.stdout.write(`${id}^running\n*running,thread-id="all"\n(gdb) `);
    if (mode === 'ambiguous-output') {
      process.stdout.write('~not-mi\n@not-mi\n123\n^done\n*hello\n=unknown\n@"worker stderr\\n"\n(gdb) ');
    }
    setTimeout(() => {
      process.stdout.write('*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",thread-id="1",stopped-threads="all",core="1"\n' +
        '=thread-group-started,id="i1",pid="4242"\n(gdb) ');
    }, 5);
  } else if (command === '-exec-continue') {
    process.stdout.write(`${id}^running\n*running,thread-id="all"\n(gdb) `);
    running = false;
    setTimeout(() => process.stdout.write('*stopped,reason="exited-normally"\n(gdb) '), 5);
  } else if (command === '-thread-info') process.stdout.write(`${id}^done,threads=[{id="1",frame={level="0",addr="0x401136",func="main"},state="stopped"},{id="2",frame={level="0",addr="0x401140",func="worker"},state="running"}],current-thread-id="1"\n(gdb) `);
  else if (command === '-stack-list-frames') process.stdout.write(`${id}^done,stack=[frame={level="0",addr="0x401136",func="main",file="sample.c",line="15"},frame={level="1",addr="0x401200",func="worker"}]\n(gdb) `);
  else if (command === '-data-list-register-names') process.stdout.write(`${id}^done,register-names=["rip","rax"]\n(gdb) `);
  else if (command === '-data-list-register-values') process.stdout.write(`${id}^done,register-values=[{number="0",value="0x401136"},{number="1",value="0x2"}]\n(gdb) `);
  else if (command === '-interpreter-exec') {
    if (payload.includes('info proc mappings')) {
      process.stdout.write('~"0x0000000000401000 0x0000000000402000 0x0000000000001000 0x0 /sample\\n"\n');
      process.stdout.write('~"0x00007ffff7c00000 0x00007ffff7c01000 0x0000000000001001 0x0 /lib/libc.so\\n"\n');
    } else {
      process.stdout.write('~"0x0000000000401000 0x0000000000402000 0x0000000000001000 /sample\\n"\n');
      process.stdout.write('~"0x00007ffff7c00000 0x00007ffff7c01000 /lib/libc.so\\n"\n');
    }
    process.stdout.write(`${id}^done\n(gdb) `);
  } else if (command === '-gdb-exit') { process.stdin.destroy(); process.exit(0); }
  else process.stdout.write(`${id}^error,msg="unsupported fake command"\n(gdb) `);
  void payload;
  void token;
  void running;
  void argumentsReceived;
});
