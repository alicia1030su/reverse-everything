import { spawn, spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

function runCapture(command, args, timeoutMs = 30_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 1_000_000 });
  if (result.error) throw new Error(`Unable to run ${command}: ${result.error.message}`);
  return result;
}

function javaExecutable(home) {
  return path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

async function resolveJava(installDir, launchSupport) {
  const configuredHome = process.env.JAVA_HOME;
  const initial = configuredHome ? javaExecutable(path.resolve(configuredHome)) : process.platform === 'win32' ? 'java.exe' : 'java';
  if (configuredHome && !await isFile(initial)) throw new Error(`Configured JAVA_HOME does not contain ${initial}`);
  const probe = runCapture(initial, ['-version'], 15_000);
  if (probe.status !== 0) throw new Error(`Java runtime is not executable: ${(probe.stderr || probe.stdout).trim().slice(0, 1000)}`);
  const resolved = runCapture(initial, ['-cp', launchSupport, 'LaunchSupport', installDir, '-jdk_home']);
  if (resolved.status !== 0) throw new Error(`Ghidra LaunchSupport could not locate a JDK 25: ${(resolved.stderr || resolved.stdout).trim().slice(0, 1000)}`);
  const candidates = resolved.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse();
  const home = candidates.find(candidate => path.isAbsolute(candidate));
  if (!home || !await isFile(javaExecutable(home))) throw new Error('Ghidra LaunchSupport did not return a valid JDK home; set JAVA_HOME to a full JDK 25');
  const version = runCapture(javaExecutable(home), ['-version'], 15_000);
  const match = `${version.stdout}\n${version.stderr}`.match(/version\s+"(\d+)/);
  const major = match ? Number(match[1]) : 0;
  if (major < 25) throw new Error(`Ghidra 12.2 requires JDK 25 or newer; selected JDK major version is ${major || 'unknown'}`);
  return javaExecutable(home);
}

function javaOptions(value) {
  if (!value) return [];
  return (value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(token => token.replace(/^(["'])(.*)\1$/, '$2'));
}

function launchSettings(java, installDir, launchSupport) {
  const vmargs = runCapture(java, ['-cp', launchSupport, 'LaunchSupport', installDir, '-vmargs']);
  if (vmargs.status !== 0) throw new Error(`Ghidra LaunchSupport could not read VM arguments: ${(vmargs.stderr || vmargs.stdout).trim().slice(0, 1000)}`);
  const envvars = runCapture(java, ['-cp', launchSupport, 'LaunchSupport', installDir, '-envvars']);
  if (envvars.status !== 0) throw new Error(`Ghidra LaunchSupport could not read environment variables: ${(envvars.stderr || envvars.stdout).trim().slice(0, 1000)}`);
  const env = { ...process.env };
  for (const line of envvars.stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator), value = line.slice(separator + 1);
    if (!env[key]) env[key] = value;
  }
  const maxMemory = process.env.GHIDRA_HEADLESS_MAXMEM || process.env.GHIDRA_MAXMEM || '2G';
  if (!/^\d+[GgMmKk]$/.test(maxMemory)) throw new Error('GHIDRA_HEADLESS_MAXMEM/GHIDRA_MAXMEM must match digits followed by G, M or K');
  return {
    env,
    args: [
      ...vmargs.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
      ...(process.platform === 'win32' && process.env.USERPROFILE ? [`-Duser.home=${process.env.USERPROFILE}`] : []),
      `-Xmx${maxMemory}`,
      '-XX:ParallelGCThreads=2',
      '-XX:CICompilerCount=2',
      ...javaOptions(process.env.GHIDRA_JAVA_OPTIONS),
      ...javaOptions(process.env.GHIDRA_HEADLESS_JAVA_OPTIONS),
    ],
  };
}

async function main() {
  const installDir = process.env.RE_GHIDRA_INSTALL_DIR;
  if (!installDir) throw new Error('RE_GHIDRA_INSTALL_DIR must point to an authorized Ghidra installation');
  const root = path.resolve(installDir);
  if (root.includes('!')) throw new Error('Ghidra installation paths containing ! are not supported by the official launcher');
  const support = path.join(root, 'support');
  const officialLauncher = path.join(support, process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless');
  const applicationProperties = path.join(root, 'Ghidra', 'application.properties');
  const utilityJar = path.join(root, 'Ghidra', 'Framework', 'Utility', 'lib', 'Utility.jar');
  const launchSupport = path.join(support, 'LaunchSupport.jar');
  for (const required of [officialLauncher, applicationProperties, utilityJar, launchSupport]) {
    if (!await isFile(required)) throw new Error(`Incomplete Ghidra installation: missing ${required}`);
  }
  const java = await resolveJava(root, launchSupport);
  const settings = launchSettings(java, root, launchSupport);
  const args = [...settings.args, '-cp', utilityJar, 'ghidra.Ghidra', 'ghidra.app.util.headless.AnalyzeHeadless', ...process.argv.slice(2)];
  const child = spawn(java, args, { stdio: 'inherit', shell: false, windowsHide: true, env: settings.env });
  const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const onSigint = () => forward('SIGINT');
  const onSigterm = () => forward('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  child.once('error', error => { console.error(`Unable to start Ghidra Java process: ${error.message}`); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
