#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { HostBroker, createPolicy } from './broker.mjs';
import { createToken } from './broker-protocol.mjs';
import identity from '../package.json' with {type:'json'};

export const defaultImage = `macos-computer-use-mcp:${identity.version}`;

/**
 * The container gets no bind mounts, host environment, capabilities or writable
 * root filesystem. Its only route to the desktop is the broker URL; the token is
 * forwarded by name so it never appears in the docker command line.
 */
export function dockerRunArguments({ image = defaultImage, port, name, network, brokerHost = 'host.docker.internal' }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('A broker port is required');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw Error('Invalid container name');
  return ['run', '--rm', '-i', '--init', '--name', name,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', 'node', '--pids-limit', '256', '--memory', '1g',
    ...(network ? ['--network', network] : []),
    '--env', `CU_BROKER_URL=tcp://${brokerHost}:${port}`, '--env', 'CU_BROKER_TOKEN',
    image];
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const log = text => process.stderr.write(`[container-host] ${text}\n`);
  const docker = process.env.CU_DOCKER ?? 'docker';
  const token = createToken();
  const broker = new HostBroker({
    token, port: Number(process.env.CU_BROKER_PORT ?? 0),
    policy: createPolicy({ deny: (process.env.CU_BROKER_DENY_METHODS ?? '').split(',').filter(Boolean) }), log
  });
  const { port } = await broker.listen();
  const name = `cu-mcp-${randomBytes(6).toString('hex')}`;
  const args = dockerRunArguments({ image: process.env.CU_CONTAINER_IMAGE, port, name, network: process.env.CU_CONTAINER_NETWORK });
  // stdout stays the MCP stream: docker inherits it and this process writes only to stderr.
  const child = spawn(docker, args, { stdio: 'inherit', env: { ...process.env, CU_BROKER_TOKEN: token } });
  let stopping;
  const shutdown = code => stopping ??= broker.close().finally(() => process.exit(code));
  child.on('error', error => { log(`could not start ${docker}: ${error.message}`); void shutdown(1); });
  child.on('exit', (code, signal) => { if (code) log(`container exited (${signal ?? code})`); void shutdown(code ?? 1); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => {
    child.kill(signal);
    setTimeout(() => { spawnSync(docker, ['kill', name], { stdio: 'ignore' }); void shutdown(1); }, 3000).unref();
  });
}
