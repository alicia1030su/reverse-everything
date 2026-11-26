import type { GameServerSpec } from './types.js';

const generatedTypes = `export type Genre = 'fps' | 'rpg';
export interface Vec { x: number; y: number; z?: number }
export interface Account { username: string; salt: string; hash: string; createdAt: string }
export interface Player { id: string; username: string; roomId: string; position: Vec; health: number; score: number; inventory: Record<string, number>; quest: number; connected: boolean; resumeToken?: string | undefined; resumeUntil?: number | undefined; lastAction: number }
export interface Room { id: string; name: string; owner?: string | undefined; players: Map<string, Player>; status: 'lobby' | 'running' | 'ended'; round: number; endsAt?: number; result?: Record<string, unknown> | undefined; lastTick: number; emptySince?: number | undefined }
export interface Database { version: 1; accounts: Account[]; players: Player[]; rooms: Array<{ id: string; name: string; owner?: string | undefined; status: Room['status']; round: number }> }
export interface Envelope { type: string; payload?: Record<string, unknown>; requestId?: string }
export interface RuntimeConfig { gamePort: number; adminPort: number; adminHost: string; genre: Genre; map: { name: string; width: number; height: number }; rules: Record<string, number | boolean | string> }
`;

const generatedAuth = `import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Account } from './types.js';
const scrypt = promisify(scryptCallback);

export class ScryptSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly maxConcurrent = 2, private readonly maxQueued = 16) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active + this.queue.length >= this.maxConcurrent + this.maxQueued) throw new Error('认证请求过多，请稍后重试');
    if (this.active < this.maxConcurrent) { this.active += 1; return this.execute(task); }
    return new Promise<T>((resolve, reject) => this.queue.push(() => { this.active += 1; void this.execute(task).then(resolve, reject); }));
  }
  private async execute<T>(task: () => Promise<T>): Promise<T> {
    try { return await task(); } finally { this.active -= 1; this.next(); }
  }
  private next(): void { const task = this.queue.shift(); if (task) task(); }
}

export class TokenStore {
  private readonly tokens = new Map<string, { username: string; expires: number }>();
  private readonly sweeper: NodeJS.Timeout;
  constructor(private readonly maxTokens = 10_000, private readonly ttlMs = 3_600_000, sweepIntervalMs = 60_000) {
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref();
  }
  issue(username: string): string {
    this.sweep();
    while (this.tokens.size >= this.maxTokens) {
      const oldest = this.tokens.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, { username, expires: Date.now() + this.ttlMs });
    return token;
  }
  validate(token: string, username?: string): boolean {
    const entry = this.tokens.get(token);
    if (!entry) return false;
    if (entry.expires <= Date.now()) { this.tokens.delete(token); return false; }
    return username === undefined || entry.username === username;
  }
  revoke(token: string): void { this.tokens.delete(token); }
  revokeUser(username: string): void { for (const [token, entry] of this.tokens) if (entry.username === username) this.tokens.delete(token); }
  rotate(username: string, previous?: string): string { if (previous) this.revoke(previous); return this.issue(username); }
  get size(): number { return this.tokens.size; }
  dispose(): void { clearInterval(this.sweeper); this.tokens.clear(); }
  private sweep(): void { const now = Date.now(); for (const [token, entry] of this.tokens) if (entry.expires <= now) this.tokens.delete(token); }
}

export class AuthRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  private readonly sweeper: NodeJS.Timeout;
  constructor(private readonly maxAttempts = 10, private readonly windowMs = 60_000, private readonly maxEntries = 10_000, sweepIntervalMs = 60_000) {
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref();
  }
  consume(key: string): boolean {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && this.entries.size >= this.maxEntries) { this.sweep(); if (this.entries.size >= this.maxEntries) return false; }
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.maxAttempts;
  }
  dispose(): void { clearInterval(this.sweeper); this.entries.clear(); }
  private sweep(): void { const now = Date.now(); for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key); }
}

const scryptLimiter = new ScryptSemaphore();
const tokenStore = new TokenStore();
const authRateLimiter = new AuthRateLimiter();
const registering = new Set<string>();
export async function registerAccount(accounts: Account[], username: string, password: string): Promise<Account> {
  if (registering.has(username)) throw new Error('用户名正在注册');
  registering.add(username);
  try {
    const salt = randomBytes(16).toString('hex');
    const hash = (await scryptLimiter.run(() => scrypt(password, salt, 64)) as Buffer).toString('hex');
    if (accounts.some(item => item.username === username)) throw new Error('用户名已存在');
    const account: Account = { username, salt, hash, createdAt: new Date().toISOString() };
    accounts.push(account);
    return account;
  } finally { registering.delete(username); }
}
export async function authenticate(accounts: Account[], username: string, password: string): Promise<Account | undefined> {
  const account = accounts.find(item => item.username === username);
  if (!account) return undefined;
  const actual = await scryptLimiter.run(() => scrypt(password, account.salt, 64)) as Buffer;
  const expected = Buffer.from(account.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? account : undefined;
}
export function issueToken(username: string): string { return tokenStore.issue(username); }
export function validToken(token: string, username?: string): boolean { return tokenStore.validate(token, username); }
export function revokeToken(token: string): void { tokenStore.revoke(token); }
export function revokeUserTokens(username: string): void { tokenStore.revokeUser(username); }
export function rotateToken(username: string, previous?: string): string { return tokenStore.rotate(username, previous); }
export function tokenCount(): number { return tokenStore.size; }
export function disposeAuthResources(): void { tokenStore.dispose(); authRateLimiter.dispose(); }
export { authRateLimiter };
`;

const generatedStorage = `import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './types.js';
export const emptyDatabase = (): Database => ({ version: 1, accounts: [], players: [], rooms: [] });
export async function loadDatabase(file: string): Promise<Database> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Database; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDatabase();
    throw error;
  }
}
export async function saveDatabase(file: string, database: Database): Promise<void> {
  if (file === ':memory:') return;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(database), { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
`;

const generatedEngine = `import { randomBytes, randomUUID } from 'node:crypto';
import type { Database, Envelope, Room, RuntimeConfig, Vec } from './types.js';
import { revokeToken } from './auth.js';
import { saveDatabase } from './storage.js';
export interface Session { id: string; username: string; roomId: string; token: string; send: (value: unknown) => void; lastMessage: number; close?: ((code?: number, reason?: string) => void) | undefined }
export class GameEngine {
  readonly rooms = new Map<string, Room>();
  readonly sessions = new Map<string, Session>();
  readonly database: Database;
  private readonly dataFile: string;
  private saving: Promise<void> | undefined;
  private savePending = false;
  private persistenceFailure: string | undefined;
  constructor(database: Database, dataFile: string, readonly config: RuntimeConfig) {
    this.database = database;
    this.dataFile = dataFile;
    for (const saved of database.rooms) {
      if (!database.players.some(player => player.roomId === saved.id)) continue;
      this.rooms.set(saved.id, { id: saved.id, name: saved.name, owner: saved.owner, players: new Map(), status: saved.status, round: saved.round, lastTick: Date.now() });
    }
    for (const player of database.players) {
      let room = this.rooms.get(player.roomId);
      if (!room) { room = { id: player.roomId, name: '恢复房间', players: new Map(), status: 'lobby', round: 0, lastTick: Date.now() }; this.rooms.set(room.id, room); }
      player.connected = false;
      room.players.set(player.id, player);
    }
    void this.persist();
  }
  get persistenceError(): string | undefined { return this.persistenceFailure; }
  persist(): Promise<void> {
    this.savePending = true;
    if (!this.saving) this.saving = this.drainPersistence();
    return this.saving;
  }
  private async drainPersistence(): Promise<void> {
    try {
      while (this.savePending) {
        this.savePending = false;
        try {
          await saveDatabase(this.dataFile, this.database);
          this.persistenceFailure = undefined;
        } catch (error) {
          this.persistenceFailure = error instanceof Error ? error.message : String(error);
          console.error('持久化失败', error);
        }
      }
    } finally { this.saving = undefined; }
  }
  async flush(timeoutMs = 5_000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const drained = await Promise.race([this.saving?.then(() => true) ?? true, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      return drained && this.persistenceFailure === undefined;
    } finally { if (timer) clearTimeout(timer); }
  }
  private limit(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; }
  private sync(): void {
    this.database.players = [...this.rooms.values()].flatMap(room => [...room.players.values()].map(player => ({ ...player, resumeToken: undefined })));
    this.database.rooms = [...this.rooms.values()].map(room => ({ id: room.id, name: room.name, owner: room.owner, status: room.status, round: room.round }));
    void this.persist();
  }
  private roomList(): unknown[] { return [...this.rooms.values()].map(room => ({ id: room.id, name: room.name, status: room.status, players: room.players.size, round: room.round })); }
  private snapshot(session: Session): void {
    const room = this.rooms.get(session.roomId);
    session.send({ type: 'state', payload: { player: room?.players.get(session.id), room: room ? { id: room.id, name: room.name, status: room.status, round: room.round, endsAt: room.endsAt, result: room.result } : null, players: room ? [...room.players.values()].map(player => ({ id: player.id, username: player.username, position: player.position, health: player.health, score: player.score, inventory: player.inventory, quest: player.quest })) : [], rooms: this.roomList() } });
  }
  attach(session: Session): void {
    this.sessions.set(session.id, session);
    const room = this.rooms.get(session.roomId);
    if (room) {
      const player = room.players.get(session.id);
      if (player) {
        player.connected = true;
        if (!player.resumeToken || (player.resumeUntil ?? 0) < Date.now()) { player.resumeToken = randomBytes(24).toString('base64url'); player.resumeUntil = Date.now() + 120_000; }
      }
      this.broadcast(room, { type: 'presence', payload: { username: session.username, online: true } });
    }
    const current = room?.players.get(session.id);
    session.send({ type: 'welcome', payload: { playerId: session.id, genre: this.config.genre, map: this.config.map, rules: this.config.rules, resumeToken: current?.resumeToken } });
    this.snapshot(session);
  }
  detach(session: Session): void {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    const room = this.rooms.get(session.roomId);
    const player = room?.players.get(session.id);
    if (room && player) {
      player.connected = false;
      if (room.players.size === 0) room.emptySince = Date.now();
      this.broadcast(room, { type: 'presence', payload: { username: session.username, online: false } });
      this.sync();
    }
  }
  resume(token: string): { id: string; username: string; roomId: string; resumeToken: string } | undefined {
    for (const room of this.rooms.values()) for (const player of room.players.values()) {
      if (player.resumeToken !== token || (player.resumeUntil ?? 0) <= Date.now()) continue;
      const existingSession = this.sessions.get(player.id);
      if (player.connected || existingSession) {
        if (!existingSession) return undefined;
        revokeToken(existingSession.token);
        this.sessions.delete(player.id);
        player.connected = false;
        existingSession.close?.(1008, 'resumed elsewhere');
      }
      player.resumeToken = randomBytes(24).toString('base64url');
      player.resumeUntil = Date.now() + 120_000;
      return { id: player.id, username: player.username, roomId: room.id, resumeToken: player.resumeToken };
    }
    return undefined;
  }
  broadcast(room: Room, message: unknown): void { for (const player of room.players.values()) if (player.connected) this.sessions.get(player.id)?.send(message); }
  private error(session: Session, message: string): void { session.send({ type: 'error', payload: { message } }); }
  handle(session: Session, envelope: Envelope): void {
    if (!envelope || typeof envelope.type !== 'string') return;
    const payload = envelope.payload ?? {};
    const respond = (value: unknown): void => session.send({ type: envelope.type + ':result', requestId: envelope.requestId, payload: value });
    try {
      switch (envelope.type) {
        case 'rooms': return respond({ rooms: this.roomList() });
        case 'state': return this.snapshot(session);
        case 'createRoom': {
          if (typeof payload.name !== 'string' || !payload.name.trim()) return this.error(session, '房间名无效');
          if (this.rooms.size >= this.limit(this.config.rules.maxRooms, 100)) return this.error(session, '房间数量已达上限');
          const owned = [...this.rooms.values()].filter(room => room.owner === session.username || [...room.players.values()].some(player => player.username === session.username)).length;
          if (owned >= this.limit(this.config.rules.maxRoomsPerUser, 5)) return this.error(session, '单用户房间数已达上限');
          const id = randomUUID();
          this.rooms.set(id, { id, name: payload.name.trim().slice(0, 40), owner: session.username, players: new Map(), status: 'lobby', round: 0, lastTick: Date.now(), emptySince: Date.now() });
          this.sync(); return respond({ roomId: id });
        }
        case 'join': {
          const room = this.rooms.get(String(payload.roomId));
          if (!room) return this.error(session, '房间不存在');
          if (room.players.size >= this.limit(this.config.rules.maxPlayers, 8)) return this.error(session, '房间已满');
          const old = this.rooms.get(session.roomId);
          old?.players.delete(session.id);
          if (old) { if (old.players.size === 0) old.emptySince = Date.now(); this.broadcast(old, { type: 'stateChanged' }); }
          session.roomId = room.id;
          const previousId = session.id;
          const existing = [...room.players.values()].find(player => player.username === session.username && !player.connected);
          if (existing) { this.sessions.delete(previousId); session.id = existing.id; existing.connected = true; }
          else room.players.set(session.id, { id: session.id, username: session.username, roomId: room.id, position: { x: 1, y: 1 }, health: 100, score: 0, inventory: {}, quest: 0, connected: true, lastAction: Date.now() });
          delete room.emptySince;
          this.sessions.set(session.id, session);
          this.sync(); this.attach(session); return respond({ roomId: room.id });
        }
        case 'start': {
          const room = this.rooms.get(session.roomId);
          if (!room || room.players.size < 2) return this.error(session, '至少需要两名玩家');
          room.status = 'running'; room.round += 1; room.result = undefined; room.endsAt = Date.now() + Number(this.config.rules.roundSeconds ?? 300) * 1000;
          for (const player of room.players.values()) { player.health = 100; player.position = { x: 1 + room.players.size, y: 1 }; }
          this.sync(); this.broadcast(room, { type: 'started', payload: { round: room.round, endsAt: room.endsAt } }); return respond({ started: true });
        }
        case 'move': {
          const room = this.rooms.get(session.roomId);
          const player = room?.players.get(session.id);
          if (!room || !player || room.status !== 'running') return this.error(session, '当前不能移动');
          const candidate = payload.position as { x?: unknown; y?: unknown } | undefined;
          if (!candidate || typeof candidate.x !== 'number' || typeof candidate.y !== 'number') return this.error(session, '坐标无效');
          const position: Vec = { x: candidate.x, y: candidate.y };
          const speed = Number(this.config.rules.movementSpeed ?? 6);
          const distance = Math.hypot(position.x - player.position.x, position.y - player.position.y);
          if (!Number.isFinite(distance) || distance > speed * 2 || Math.abs(position.x) > this.config.map.width || Math.abs(position.y) > this.config.map.height) return this.error(session, '位置越界或速度异常');
          player.position = { x: position.x, y: position.y }; this.broadcast(room, { type: 'moved', payload: { playerId: player.id, position: player.position } }); this.sync(); return respond({ position: player.position });
        }
        case 'action': {
          const room = this.rooms.get(session.roomId);
          const player = room?.players.get(session.id);
          if (!room || !player || room.status !== 'running') return this.error(session, '当前不能执行动作');
          const now = Date.now();
          if (now - player.lastAction < 150) return this.error(session, '动作过于频繁');
          player.lastAction = now;
          if (this.config.genre === 'fps') {
            if (typeof payload.targetId !== 'string') return this.error(session, '缺少目标');
            const target = room.players.get(payload.targetId);
            if (!target || target.id === player.id) return this.error(session, '目标无效');
            const distance = Math.hypot(target.position.x - player.position.x, target.position.y - player.position.y);
            if (distance > 40) return this.error(session, '目标超出攻击距离');
            target.health = Math.max(0, target.health - Number(this.config.rules.damage ?? 25));
            if (target.health === 0) { player.score += 1; target.health = 100; }
          } else {
            const action = String(payload.action ?? 'gather');
            if (action === 'gather') {
              player.inventory.herb = (player.inventory.herb ?? 0) + 1;
              player.quest += 1;
              if (player.quest >= Number(this.config.rules.questTarget ?? 3)) { player.score += 100; player.inventory.reward = 1; }
            } else if (action === 'useHerb') {
              if (!player.inventory.herb) return this.error(session, '没有草药');
              player.inventory.herb -= 1; player.health = Math.min(100, player.health + 20);
            } else return this.error(session, '未知动作');
          }
          this.broadcast(room, { type: 'actionApplied', payload: { playerId: player.id } });
          this.snapshot(session); this.sync(); return respond({ accepted: true });
        }
        case 'end': {
          const room = this.rooms.get(session.roomId);
          if (!room || room.status !== 'running') return this.error(session, '没有进行中的回合');
          room.status = 'ended'; room.result = { round: room.round, endedAt: new Date().toISOString(), scores: [...room.players.values()].map(player => ({ username: player.username, score: player.score, quest: player.quest })) };
          this.sync(); this.broadcast(room, { type: 'ended', payload: room.result }); return respond(room.result);
        }
        case 'leave': {
          const room = this.rooms.get(session.roomId); room?.players.delete(session.id);
          if (room) { if (room.players.size === 0) room.emptySince = Date.now(); this.broadcast(room, { type: 'stateChanged' }); }
          this.sync(); return respond({ left: true });
        }
        default: return this.error(session, '未知消息类型');
      }
    } catch (error) { this.error(session, error instanceof Error ? error.message : '处理失败'); }
  }
  tick(): void {
    const now = Date.now();
    const ttlMs = this.limit(this.config.rules.emptyRoomTtlSeconds, 300) * 1000;
    let reclaimed = false;
    for (const room of this.rooms.values()) {
      if (room.players.size !== 0) continue;
      if (room.emptySince === undefined) room.emptySince = now;
      else if (now - room.emptySince >= ttlMs) { this.rooms.delete(room.id); reclaimed = true; }
    }
    if (reclaimed) this.sync();
    for (const room of this.rooms.values()) {
      if (room.status !== 'running' || !room.endsAt) continue;
      if (now < room.endsAt && now - room.lastTick < 1000) continue;
      room.lastTick = now;
      if (now >= room.endsAt) {
        room.status = 'ended'; room.result = { round: room.round, reason: 'timeout', scores: [...room.players.values()].map(player => ({ username: player.username, score: player.score })) };
        this.broadcast(room, { type: 'ended', payload: room.result }); this.sync();
      } else this.broadcast(room, { type: 'tick', payload: { endsAt: room.endsAt } });
    }
  }
  stats(): Record<string, unknown> { return { genre: this.config.genre, rooms: this.rooms.size, players: [...this.rooms.values()].reduce((sum, room) => sum + room.players.size, 0), accounts: this.database.accounts.length, running: [...this.rooms.values()].filter(room => room.status === 'running').length, persistence: { ok: this.persistenceFailure === undefined, error: this.persistenceFailure ?? null, pendingWrites: this.savePending || this.saving ? 1 : 0 } }; }
}
`;

const generatedAdmin = `import { createServer } from 'node:http';
import { appendFile } from 'node:fs/promises';
import type { GameEngine } from './engine.js';
export async function startAdmin(engine: GameEngine, token: string, port: number, host: string, auditFile: string): Promise<{ close: () => Promise<void> }> {
  if (!token || token.length < 16) throw new Error('ADMIN_TOKEN 必须至少 16 个字符');
  const audit = async (event: string): Promise<void> => { await appendFile(auditFile, JSON.stringify({ at: new Date().toISOString(), event }) + '\\n').catch(() => undefined); };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const authorized = request.headers.authorization === 'Bearer ' + token;
    await audit((authorized ? 'authorized ' : 'denied ') + (request.url ?? '/'));
    if (!authorized) { response.writeHead(401); response.end(JSON.stringify({ error: 'unauthorized' })); return; }
    if (request.url === '/health') { const ok = engine.persistenceError === undefined; if (!ok) response.writeHead(503); response.end(JSON.stringify({ ok, persistence: { ok, error: engine.persistenceError ?? null } })); return; }
    if (request.url === '/stats') { response.end(JSON.stringify(engine.stats())); return; }
    if (request.url === '/audit') { response.end(JSON.stringify(await import('node:fs/promises').then(fs => fs.readFile(auditFile, 'utf8').catch(() => '')))); return; }
    response.writeHead(404); response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
`;

const generatedMain = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { GameEngine, type Session } from './engine.js';
import { authenticate, authRateLimiter, disposeAuthResources, issueToken, registerAccount, validToken } from './auth.js';
import { loadDatabase } from './storage.js';
import { startAdmin } from './admin.js';
import type { Envelope, RuntimeConfig } from './types.js';
const root = process.cwd();
const config = JSON.parse(readFileSync(path.join(root, 'config/default.json'), 'utf8')) as RuntimeConfig;
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken || adminToken.length < 16) throw new Error('ADMIN_TOKEN 必须至少 16 个字符');
const gamePort = Number(process.env.GAME_PORT ?? config.gamePort);
const adminPort = Number(process.env.ADMIN_PORT ?? config.adminPort);
const gameHost = process.env.GAME_HOST ?? '127.0.0.1';
if (!Number.isSafeInteger(gamePort) || !Number.isSafeInteger(adminPort)) throw new Error('端口无效');
const positiveInteger = (value: string | undefined, fallback: number): number => { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; };
const maxConnections = positiveInteger(process.env.MAX_CONNECTIONS, 256);
const loopbackHost = gameHost === '127.0.0.1' || gameHost === '::1' || gameHost === 'localhost';
const defaultAllowedHost = gameHost === '::1' ? '[::1]' : '127.0.0.1';
const allowedHosts = new Set((process.env.ALLOWED_HOSTS ?? (loopbackHost ? defaultAllowedHost : '')).split(',').map(value => value.trim()).filter(Boolean));
if (!loopbackHost && !process.env.ALLOWED_HOSTS) throw new Error('远程监听必须显式配置 ALLOWED_HOSTS');
if (allowedHosts.size === 0) throw new Error('ALLOWED_HOSTS 不能为空');
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean));
const resolveDataPath = (value: string): string => path.isAbsolute(value) ? value : path.join(root, value);
const dataFile = resolveDataPath(process.env.DATA_FILE ?? 'data/game.json');
const auditFile = resolveDataPath(process.env.AUDIT_FILE ?? 'data/admin-audit.jsonl');
const database = await loadDatabase(dataFile);
const engine = new GameEngine(database, dataFile, config);
mkdirSync(path.dirname(auditFile), { recursive: true });
mkdirSync(path.dirname(dataFile), { recursive: true });
const adminHost = process.env.ADMIN_HOST ?? config.adminHost;
const admin = await startAdmin(engine, adminToken, adminPort, adminHost, auditFile);
const wss = new WebSocketServer({ host: gameHost, port: gamePort, maxPayload: 16 * 1024 });
writeFileSync(resolveDataPath(process.env.PID_FILE ?? 'data/game.pid'), String(process.pid));
wss.on('connection', (socket, request) => {
  if (wss.clients.size > maxConnections) { socket.close(1013, 'connection limit'); return; }
  const origin = request.headers.origin;
  const requestHost = String(request.headers.host ?? '');
  const requestHostname = requestHost.startsWith('[') ? requestHost.slice(0, requestHost.indexOf(']') + 1) : requestHost.split(':')[0];
  if (!allowedHosts.has(requestHost) && !allowedHosts.has(requestHostname ?? '')) { socket.close(1008, 'host denied'); return; }
  if (origin !== undefined && !allowedOrigins.has(origin)) { socket.close(1008, 'origin denied'); return; }
  const ip = (request.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  let session: Session | undefined;
  let authenticating = false;
  let count = 0; let windowStart = Date.now();
  const send = (value: unknown): void => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const authTimer = setTimeout(() => { if (!session) socket.close(1008, 'authentication timeout'); }, 10_000);
  authTimer.unref();
  socket.on('message', (raw, binary) => {
    if (binary) { socket.close(1003, 'binary unsupported'); return; }
    const now = Date.now();
    if (now - windowStart > 1000) { count = 0; windowStart = now; }
    if (++count > 60) { socket.close(1008, 'rate limit'); return; }
    let envelope: Envelope;
    try { envelope = JSON.parse(raw.toString()) as Envelope; } catch { socket.close(1007, 'invalid JSON'); return; }
    if (!session) {
      if (envelope.type === 'resume') {
        if (authenticating) { socket.close(1008, 'authentication already in progress'); return; }
        const resumed = engine.resume(String(envelope.payload?.token ?? ''));
        if (!resumed) { send({ type: 'error', payload: { message: 'resume token 无效' } }); return; }
        session = { id: resumed.id, username: resumed.username, roomId: resumed.roomId, token: issueToken(resumed.username), send, lastMessage: now, close: () => socket.close(1008, 'resumed elsewhere') };
        clearTimeout(authTimer); engine.attach(session); return;
      }
      if (envelope.type !== 'authenticate') { send({ type: 'error', payload: { message: '需要认证' } }); return; }
      if (!authRateLimiter.consume(ip)) { send({ type: 'error', payload: { message: '认证请求过于频繁' } }); return; }
      if (authenticating) { socket.close(1008, 'authentication already in progress'); return; }
      authenticating = true;
      void (async () => {
        try {
          const username = String(envelope.payload?.username ?? ''); const password = String(envelope.payload?.password ?? '');
          if (!/^[a-zA-Z0-9_]{3,32}$/.test(username) || password.length < 8 || password.length > 128) { send({ type: 'error', payload: { message: '用户名或密码无效' } }); return; }
          let account;
          if (envelope.payload?.mode === 'register') {
            if (database.accounts.some(item => item.username === username)) { send({ type: 'error', payload: { message: '用户名已存在' } }); return; }
            account = await registerAccount(database.accounts, username, password); void engine.persist();
          } else account = await authenticate(database.accounts, username, password);
          if (socket.readyState !== WebSocket.OPEN || session) return;
          if (!account) { send({ type: 'error', payload: { message: '认证失败' } }); return; }
          const playerId = randomUUID();
          session = { id: playerId, username: account.username, roomId: '', token: issueToken(account.username), send, lastMessage: Date.now(), close: () => socket.close(1008, 'resumed elsewhere') };
          clearTimeout(authTimer); engine.sessions.set(playerId, session);
          send({ type: 'authenticated', payload: { username: account.username, token: session.token, playerId } });
        } catch (error) { send({ type: 'error', payload: { message: error instanceof Error ? error.message : '认证失败' } }); }
        finally { authenticating = false; }
      })(); return;
    }
    if (envelope.type === 'authenticate' && typeof envelope.payload?.token === 'string') {
      if (!validToken(envelope.payload.token, session.username)) { socket.close(1008, 'invalid token'); return; }
      session.token = envelope.payload.token; send({ type: 'authorized' }); return;
    }
    if (!validToken(session.token, session.username)) { socket.close(1008, 'session expired'); return; }
    session.lastMessage = now; engine.handle(session, envelope);
  });
  socket.on('close', () => { clearTimeout(authTimer); if (session) engine.detach(session); });
  socket.on('error', () => undefined);
});
const ticker = setInterval(() => engine.tick(), 500);
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(ticker);
  disposeAuthResources();
  const forceTimer = setTimeout(() => { for (const client of wss.clients) client.terminate(); }, 1_000);
  forceTimer.unref();
  for (const client of wss.clients) client.close(1001, 'server shutdown');
  await new Promise<void>(resolve => wss.close(() => resolve()));
  clearTimeout(forceTimer);
  const flushed = await engine.flush(5_000);
  await admin.close();
  if (!flushed) { console.error('关闭超时：持久化 flush 未在 5 秒内完成'); process.exitCode = 1; }
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
console.log(JSON.stringify({ game: 'ws://' + gameHost + ':' + gamePort, admin: 'http://' + adminHost + ':' + adminPort }));
`;

function lockfile(spec: GameServerSpec): string {
  return JSON.stringify({
    name: spec.name, version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: spec.name, version: '1.0.0', dependencies: { ws: '8.23.0' }, devDependencies: { '@types/node': '22.18.6', '@types/ws': '8.18.2', typescript: '5.9.3' } },
      'node_modules/@types/node': { version: '22.18.6', resolved: 'https://registry.npmjs.org/@types/node/-/node-22.18.6.tgz', integrity: 'sha512-r8uszLPpeIWbNKtvWRt/DbVi5zbqZyj1PTmhRMqBMvDnaz1QpmSKujUtJLrqGZeoM8v72MfYggDceY4K1itzWQ==', dev: true, dependencies: { 'undici-types': '~6.21.0' } },
      'node_modules/@types/ws': { version: '8.18.2', resolved: 'https://registry.npmjs.org/@types/ws/-/ws-8.18.2.tgz', integrity: 'sha512-67MQl+fpWKVTT1NYdnmo3U4sc/xPo/zQBncVnI74qmQa0z/b+1g6iYqNmGCPbxO+zz2aklb08a0oHfegiVd0/w==', dev: true, dependencies: { '@types/node': '*' } },
      'node_modules/typescript': { version: '5.9.3', resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz', integrity: 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==', dev: true, bin: { tsc: 'bin/tsc', tsserver: 'bin/tsserver' } },
      'node_modules/undici-types': { version: '6.21.0', resolved: 'https://registry.npmjs.org/undici-types/-/undici-types-6.21.0.tgz', integrity: 'sha512-iwDZqg0QAGrg9Rav5H4n0M64c3mkR59cJ6wQp+7C4nI0gsmExaedaYLNO44eT4AtBBwjbTiGPMlt2Md0T9H9JQ==', dev: true },
      'node_modules/ws': { version: '8.23.0', resolved: 'https://registry.npmjs.org/ws/-/ws-8.23.0.tgz', integrity: 'sha512-wCkmX8QMOrKjgO8HW2WyDbTSGeqkocxgDzS9iR79rEAexty6/2qzilx3Ag8Tqf9ykop3irLKle0MtVn5qjVnoQ==', peerDependencies: { bufferutil: '^4.0.1', 'utf-8-validate': '>=5.0.2' }, peerDependenciesMeta: { bufferutil: { optional: true }, 'utf-8-validate': { optional: true } } },
    },
  }, null, 2) + '\n';
}

export function projectFiles(spec: GameServerSpec): Map<string, string> {
  const config = { gamePort: spec.ports.value.game, adminPort: spec.ports.value.admin, adminHost: spec.ports.value.adminHost, genre: spec.genre, map: spec.map.value, rules: { maxRooms: 100, maxRoomsPerUser: 5, emptyRoomTtlSeconds: 300, ...spec.rules.value } };
  return new Map<string, string>([
    ['server/src/types.ts', generatedTypes],
    ['server/src/auth.ts', generatedAuth],
    ['server/src/storage.ts', generatedStorage],
    ['server/src/engine.ts', generatedEngine],
    ['server/src/admin.ts', generatedAdmin],
    ['server/src/main.ts', generatedMain],
    ['config/default.json', JSON.stringify(config, null, 2) + '\n'],
    ['database/migrations.json', JSON.stringify({ version: 1, entities: ['accounts', 'players', 'rooms'], migrations: [{ id: '001-initial', description: '账号密码散列与房间/角色 JSON 原子持久化' }] }, null, 2) + '\n'],
    ['package.json', JSON.stringify({ name: spec.name, version: '1.0.0', private: true, type: 'module', engines: { node: '>=22.13.0' }, scripts: { build: 'tsc -p tsconfig.json', start: 'node dist/main.js', test: 'node --test tests/*.test.mjs', healthcheck: 'node scripts/healthcheck.mjs', backup: 'node scripts/backup.mjs', restore: 'node scripts/restore.mjs' }, dependencies: { ws: '8.23.0' }, devDependencies: { '@types/node': '22.18.6', '@types/ws': '8.18.2', typescript: '5.9.3' } }, null, 2) + '\n'],
    ['tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, outDir: 'dist', rootDir: 'server/src', skipLibCheck: true, types: ['node'] }, include: ['server/src'] }, null, 2) + '\n'],
    ['.env.example', `GAME_HOST=127.0.0.1\nGAME_PORT=${spec.ports.value.game}\nADMIN_PORT=${spec.ports.value.admin}\nADMIN_TOKEN=replace-with-at-least-16-random-characters\nALLOWED_HOSTS=127.0.0.1\nALLOWED_ORIGINS=\nMAX_CONNECTIONS=256\nDATA_FILE=data/game.json\nAUDIT_FILE=data/admin-audit.jsonl\n`],
    ['.dockerignore', 'node_modules\ndist\ndata\n.env*\n.git\n.gitignore\ncoverage\ntest-results\nplaywright-report\n'],
    ['Dockerfile', `FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --ignore-scripts --no-audit --no-fund\nCOPY tsconfig.json ./\nCOPY server ./server\nCOPY config ./config\nCOPY scripts ./scripts\nRUN npm run build && npm prune --omit=dev && npm cache clean --force\nRUN mkdir -p /app/data && chown -R node:node /app\nUSER node\nENV NODE_ENV=production\nENV GAME_HOST=0.0.0.0\nEXPOSE ${spec.ports.value.game} ${spec.ports.value.admin}\nCMD ["node", "dist/main.js"]\n`],
    ['docker-compose.yml', `services:\n  game:\n    build: .\n    ports:\n      - "127.0.0.1:\${GAME_PUBLISH_PORT:-${spec.ports.value.game}}:\${GAME_PORT:-${spec.ports.value.game}}"\n      - "127.0.0.1:\${ADMIN_PUBLISH_PORT:-${spec.ports.value.admin}}:\${ADMIN_PORT:-${spec.ports.value.admin}}"\n    environment:\n      ADMIN_TOKEN: \${ADMIN_TOKEN:?ADMIN_TOKEN is required}\n      GAME_PORT: "\${GAME_PORT:-${spec.ports.value.game}}"\n      ADMIN_PORT: "\${ADMIN_PORT:-${spec.ports.value.admin}}"\n      GAME_HOST: 0.0.0.0\n      ADMIN_HOST: 0.0.0.0\n      ALLOWED_HOSTS: "\${ALLOWED_HOSTS:-127.0.0.1}"\n      ALLOWED_ORIGINS: "\${ALLOWED_ORIGINS:-}"\n      MAX_CONNECTIONS: "\${MAX_CONNECTIONS:-256}"\n    healthcheck:\n      test: ["CMD", "node", "scripts/healthcheck.mjs"]\n      interval: 2s\n      timeout: 3s\n      retries: 20\n      start_period: 5s\n    volumes:\n      - game-data:/app/data\nvolumes:\n  game-data:\n`],
    ['BUILD-INFO.json', JSON.stringify({ name: spec.name, genre: spec.genre, revivalLevel: spec.level, generatedBy: '@reverse/game-revival', modules: spec.modules.map(module => module.name), originalClient: 'UNKNOWN' }, null, 2) + '\n'],
    ['GAME-COMPATIBILITY.json', JSON.stringify({ originalClientCompatible: false, status: 'UNKNOWN', protocol: 'revival-websocket-v1', notes: spec.compatibility.value.notes }, null, 2) + '\n'],
    ['README.md', `# ${spec.name}\n\n由 Game Revival 生成的独立 ${spec.genre.toUpperCase()} 多人游戏服务器。不是原版客户端或协议兼容实现。\n\n## 启动\n\n\`\`\`sh\nnpm ci\nnpm run build\nADMIN_TOKEN="$(openssl rand -hex 24)" GAME_PORT=${spec.ports.value.game} ADMIN_PORT=${spec.ports.value.admin} npm start\n\`\`\`\n\n- 游戏 WebSocket：端口 ${spec.ports.value.game}\n- 管理 HTTP：http://${spec.ports.value.adminHost}:${spec.ports.value.admin}（Bearer ADMIN_TOKEN）\n- 地图：${spec.map.value.name} (${spec.map.value.width}×${spec.map.value.height})\n- 模块：${spec.modules.map(module => module.name).join(', ')}\n\n安全默认值：仅监听 127.0.0.1；WS 连接必须匹配 ALLOWED_HOSTS（默认 127.0.0.1），浏览器来源必须显式加入 ALLOWED_ORIGINS。远程监听时必须设置 GAME_HOST 与 ALLOWED_HOSTS。可用 MAX_CONNECTIONS 限制总连接数；认证还有每 IP 速率、scrypt 并发和 token 数量上限。\n\n协议：连接后发送 \`authenticate\`（mode=register/login, username, password）；注册至少 8 位密码。随后 \`join\`、\`start\`、\`move\`、\`action\`、\`end\`。断线 120 秒内使用 welcome 后自动生成的 resume token 恢复；resume token 单次有效并会轮换，旧 socket 与旧登录 token 立即失效。RPG 使用 gather/useHerb 动作；FPS action 使用 targetId。\n\n## 运维\n\n\`npm run healthcheck\`、\`npm run backup\`、\`npm run restore -- data/backup.json\`。管理 API：\`/health\`、\`/stats\`、\`/audit\`，必须 Bearer 认证，审计追加至 \`data/admin-audit.jsonl\`。\n\n## 证据边界\n\n原始客户端兼容性：UNKNOWN。生成服务为新的服务端权威设计；规格与兼容性文件记录观察、推断和未知。\n`],
    ['admin-web/index.html', `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${spec.name} 管理后台</title><h1>${spec.name} 管理后台</h1><p>管理 API 需要 Authorization: Bearer ADMIN_TOKEN，默认仅监听 127.0.0.1。</p><button id="stats">读取统计</button><pre id="out"></pre><script>document.querySelector('#stats').onclick=async()=>{const token=prompt('ADMIN_TOKEN');const r=await fetch('/stats',{headers:{Authorization:'Bearer '+token}});document.querySelector('#out').textContent=JSON.stringify(await r.json(),null,2)}</script></html>\n`],
    ['scripts/start.mjs', "import { spawn } from 'node:child_process';\nif (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 16) throw new Error('ADMIN_TOKEN 必须至少 16 个字符');\nconst child = spawn(process.execPath, ['dist/main.js'], { stdio: 'inherit' });\nprocess.on('SIGTERM', () => child.kill('SIGTERM'));\n"],
    ['scripts/stop.mjs', "import { readFileSync } from 'node:fs';\nconst file = process.env.PID_FILE ?? 'data/game.pid';\ntry { const pid = Number(readFileSync(file, 'utf8')); process.kill(pid, 'SIGTERM'); } catch (error) { console.error(error.message); process.exitCode = 1; }\n"],
    ['scripts/healthcheck.mjs', `const port = process.env.ADMIN_PORT ?? '${spec.ports.value.admin}';\nconst host = process.env.ADMIN_HOST ?? '${spec.ports.value.adminHost}';\nif (!process.env.ADMIN_TOKEN) process.exit(2);\nconst response = await fetch('http://' + host + ':' + port + '/health', { headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN }, signal: AbortSignal.timeout(4000) });\nif (!response.ok || !(await response.json()).ok) process.exit(1);\n`],
    ['scripts/backup.mjs', "import { copyFile, mkdir } from 'node:fs/promises';\nawait mkdir('data', { recursive: true });\nawait copyFile(process.env.DATA_FILE ?? 'data/game.json', process.argv[2] ?? 'data/backup.json');\n"],
    ['scripts/restore.mjs', "import { copyFile } from 'node:fs/promises';\nif (!process.argv[2]) throw new Error('用法: npm run restore -- <backup-file>');\nawait copyFile(process.argv[2], process.env.DATA_FILE ?? 'data/game.json');\n"],
    ['scripts/start.sh', '#!/bin/sh\nexec node scripts/start.mjs\n'],
    ['scripts/stop.sh', '#!/bin/sh\nexec node scripts/stop.mjs\n'],
    ['scripts/healthcheck.sh', '#!/bin/sh\nexec node scripts/healthcheck.mjs\n'],
    ['scripts/backup.sh', '#!/bin/sh\nexec node scripts/backup.mjs "$@"\n'],
    ['scripts/restore.sh', '#!/bin/sh\nexec node scripts/restore.mjs "$@"\n'],
    ['tests/server.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { GameEngine } from '../dist/engine.js';\nimport { emptyDatabase } from '../dist/storage.js';\nimport config from '../config/default.json' with { type: 'json' };\ntest('房间隔离与角色状态', () => {\n  const engine = new GameEngine(emptyDatabase(), ':memory:', config);\n  const room = { id: 'r', name: 'test', players: new Map(), status: 'lobby', round: 0, lastTick: Date.now() };\n  room.players.set('a', { id: 'a', username: 'alice', roomId: 'r', position: { x: 0, y: 0 }, health: 100, score: 0, inventory: { herb: 2 }, quest: 1, connected: true, lastAction: 0 });\n  engine.rooms.set('r', room);\n  assert.equal(engine.rooms.get('r').players.get('a').inventory.herb, 2);\n  assert.equal(engine.rooms.has('other'), false);\n});\n"],
    ['package-lock.json', lockfile(spec)],
  ]);
}
