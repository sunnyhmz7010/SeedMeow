import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkUpdate, describeConfig, runApp } from '../src/index.js';
import { Monitor } from '../src/monitor.js';
import { StateStore } from '../src/state.js';

const VERSION = createRequire(import.meta.url)('../package.json').version;
test('启动配置摘要包含所有配置项', () => {
  assert.equal(describeConfig({
    meowNickname: 'tester',
    checkIntervalMs: 5000,
    healthCheckMs: 3600000,
    matchScope: 'all',
    keywords: ['VPS', '优惠'],
    keywordGroups: [['香港', 'VPS']],
    regexPatterns: [/年付/iu],
    pushCategory: new Set(['trade']),
    blockedKeywords: ['求购'],
    categories: new Set(['trade', 'daily']),
    pushExisting: false,
    showLinkUrl: false
  }), `版本 v${VERSION}，MeoW 昵称 tester，轮询间隔 5 秒，匹配范围 all，监控版块 trade,daily，规则 4 条（关键词：VPS,优惠 | 组合词：香港+VPS | 正则：年付 | 版块匹配：trade），屏蔽词：求购，版块过滤：trade,daily，首次推送已有 否，显示链接 否，自检间隔 60 分钟`);
});
const quiet = { info() {}, warn() {}, error() {} };
const env = {
  NODESEEK_MEOW_NICKNAME: 'ns-user',
  NODESEEK_KEYWORDS: 'VPS',
  NODESEEK_HEALTH_CHECK_MINUTES: '0',
  SB_MEOW_NICKNAME: 'sb-user',
  SB_KEYWORDS: 'VPS',
  SB_HEALTH_CHECK_MINUTES: '0'
};
const item = {
  id: 'same-id',
  title: 'VPS 补货',
  summary: '年付 100 元',
  link: 'https://example.com/post',
  category: 'trade',
  creator: 'alice',
  pubDate: '2026-11-07T00:00:00Z'
};

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'seedmeow-app-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function onceMonitor(options) {
  const monitor = new Monitor(options);
  monitor.run = (signal) => monitor.poll(signal);
  return monitor;
}

function options(dir, overrides = {}) {
  return {
    env,
    logger: quiet,
    sourceLoggerFactory: () => quiet,
    registerSignals: false,
    stateFactory: (source) => new StateStore(path.join(dir, source.id, 'state.json')),
    fetchItemsFactory: () => async () => [item],
    pusherFactory: () => ({ async pushHealthCheck() {}, async push() {} }),
    monitorFactory: onceMonitor,
    checkUpdateFn: async () => null,
    ...overrides
  };
}

test('启动配置摘要读取当前包版本', async (t) => {
  const dir = await workspace(t);
  const summaries = [];
  await runApp(options(dir, {
    pusherFactory: () => ({ async pushHealthCheck(value) { summaries.push(value); } })
  }));
  assert.equal(summaries.length, 2);
  assert.ok(summaries.every((s) => s.version === VERSION && s.configSummary.includes('版本 v' + VERSION)));
  assert.match(summaries[0].configSummary, /轮询间隔 5 秒/);
  assert.match(summaries[1].configSummary, /轮询间隔 60 秒/);
  assert.ok(summaries.every((s) => s.rssOk));
});

test('首次运行分别建立基线，随后只推送新帖并隔离相同 ID', async (t) => {
  const dir = await workspace(t);
  const pushed = [];
  const pusherFactory = (config, source) => ({
    async pushHealthCheck() {},
    async push(post) { pushed.push([source.id, post.id]); }
  });
  await runApp(options(dir, { pusherFactory }));
  assert.deepEqual(pushed, []);
  for (const source of ['nodeseek', 'sb']) {
    const state = JSON.parse(await readFile(path.join(dir, source, 'state.json'), 'utf8'));
    assert.deepEqual(state, { processedIds: ['same-id'], pendingItems: [] });
  }

  const second = options(dir, {
    pusherFactory,
    fetchItemsFactory: () => async () => [item, { ...item, id: 'new-id' }]
  });
  await runApp(second);
  assert.deepEqual(pushed.sort(), [['nodeseek', 'new-id'], ['sb', 'new-id']]);
  await runApp(second);
  assert.equal(pushed.length, 2);
});

test('NodeSeek 启动自检及请求失败时烧饼仍能处理帖子', { timeout: 3000 }, async (t) => {
  const dir = await workspace(t);
  const controller = new AbortController();
  const pushed = [];
  const health = [];
  await runApp(options(dir, {
    env: { ...env, NODESEEK_PUSH_EXISTING: 'true', SB_PUSH_EXISTING: 'true' },
    signal: controller.signal,
    monitorFactory: (value) => new Monitor({ ...value, config: { ...value.config, checkIntervalMs: 1 } }),
    fetchItemsFactory: (source) => async () => {
      if (source.id === 'nodeseek') throw new Error('NS offline');
      return [item];
    },
    pusherFactory: (config, source) => ({
      async pushHealthCheck(value) { health.push([source.id, value.rssOk]); },
      async push(post) { pushed.push([source.id, post.id]); controller.abort(); }
    })
  }));
  assert.deepEqual(pushed, [['sb', 'same-id']]);
  assert.ok(health.some(([source, ok]) => source === 'nodeseek' && !ok));
  await assert.rejects(readFile(path.join(dir, 'nodeseek', 'state.json')), { code: 'ENOENT' });
});

test('启动 MeoW 失败不退出，帖子失败持久化并在重启后独立补推', async (t) => {
  const dir = await workspace(t);
  const pushed = [];
  await runApp(options(dir, {
    env: { ...env, NODESEEK_PUSH_EXISTING: 'true', SB_PUSH_EXISTING: 'true' },
    pusherFactory: (config, source) => ({
      async pushHealthCheck() { if (source.id === 'nodeseek') throw new Error('MeoW down'); },
      async push(post) {
        if (source.id === 'nodeseek') throw new Error('MeoW down');
        pushed.push([source.id, post.id]);
      }
    })
  }));
  const before = JSON.parse(await readFile(path.join(dir, 'nodeseek', 'state.json'), 'utf8'));
  assert.deepEqual(before.pendingItems, [item]);
  assert.deepEqual(before.processedIds, []);
  assert.deepEqual(pushed, [['sb', 'same-id']]);

  await runApp(options(dir, {
    fetchItemsFactory: () => async () => [],
    pusherFactory: (config, source) => ({
      async pushHealthCheck() {},
      async push(post) { pushed.push([source.id, post.id]); }
    })
  }));
  const after = JSON.parse(await readFile(path.join(dir, 'nodeseek', 'state.json'), 'utf8'));
  assert.deepEqual(after, { processedIds: ['same-id'], pendingItems: [] });
  assert.deepEqual(pushed, [['sb', 'same-id'], ['nodeseek', 'same-id']]);
});

test('任一状态损坏时在所有网络请求之前拒绝启动', async (t) => {
  const dir = await workspace(t);
  await mkdir(path.join(dir, 'sb'));
  await writeFile(path.join(dir, 'sb', 'state.json'), '{broken', 'utf8');
  const requests = [];
  await assert.rejects(runApp(options(dir, {
    fetchItemsFactory: () => async () => { requests.push('feed'); return []; },
    checkUpdateFn: async () => { requests.push('update'); return null; },
    pusherFactory: () => ({ async pushHealthCheck() { requests.push('push'); } })
  })), /状态文件格式错误/);
  assert.deepEqual(requests, []);
});

test('退出等待当前推送的状态落盘，并停止处理剩余帖子', async (t) => {
  const dir = await workspace(t);
  const controller = new AbortController();
  const saving = Promise.withResolvers();
  const release = Promise.withResolvers();
  const state = new StateStore(path.join(dir, 'nodeseek', 'state.json'));
  const save = state.save.bind(state);
  state.save = async () => { saving.resolve(); await release.promise; await save(); };
  const pushed = [];
  let finished = false;
  const task = runApp(options(dir, {
    env: { ...env, SOURCES: 'nodeseek', NODESEEK_PUSH_EXISTING: 'true' },
    signal: controller.signal,
    stateFactory: () => state,
    monitorFactory: (value) => new Monitor(value),
    fetchItemsFactory: () => async () => [item, { ...item, id: 'later-id' }],
    pusherFactory: () => ({
      async pushHealthCheck() {},
      async push(post) { pushed.push(post.id); controller.abort(); }
    })
  })).then(() => { finished = true; });
  await saving.promise;
  assert.equal(finished, false);
  release.resolve();
  await task;
  assert.deepEqual(pushed, ['same-id']);
  const saved = JSON.parse(await readFile(state.filePath, 'utf8'));
  assert.deepEqual(saved.processedIds, ['same-id']);
});

test('自检不会重叠，退出等待正在进行的自检并移除信号监听', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dir = await workspace(t);
  const monitoring = Promise.withResolvers();
  const checking = Promise.withResolvers();
  const release = Promise.withResolvers();
  const beforeTerm = process.listenerCount('SIGTERM');
  const beforeInt = process.listenerCount('SIGINT');
  let calls = 0;
  let finished = false;
  const task = runApp(options(dir, {
    env: { ...env, SOURCES: 'nodeseek', NODESEEK_HEALTH_CHECK_MINUTES: '1' },
    registerSignals: true,
    fetchItemsFactory: () => async () => {
      calls += 1;
      if (calls > 1) { checking.resolve(); await release.promise; }
      return [];
    },
    monitorFactory: () => ({
      async initialize() {},
      async run(signal) {
        monitoring.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      }
    })
  })).then(() => { finished = true; });
  await monitoring.promise;
  t.mock.timers.tick(60000);
  await checking.promise;
  t.mock.timers.tick(120000);
  assert.equal(calls, 2);
  process.emit('SIGTERM');
  await Promise.resolve();
  assert.equal(finished, false);
  release.resolve();
  await task;
  t.mock.timers.tick(120000);
  assert.equal(calls, 2);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
});

test('状态写入失败结束整个应用，并等待另一来源停止', async (t) => {
  const dir = await workspace(t);
  const stopped = [];
  await assert.rejects(runApp(options(dir, {
    monitorFactory: (value) => {
      const monitor = new Monitor(value);
      if (value.config.meowNickname === 'sb-user') {
        monitor.run = async (signal) => {
          await writeFile(path.join(dir, 'sb'), 'blocking file');
          await monitor.poll(signal);
        };
      } else {
        monitor.run = async (signal) => {
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          stopped.push('nodeseek');
        };
      }
      return monitor;
    }
  })), { code: 'STATE_STORE_ERROR' });
  assert.deepEqual(stopped, ['nodeseek']);
});

test('更新检查使用 SeedMeow 仓库且正确比较版本，网络失败只记录警告', async () => {
  const warnings = [];
  const logger = { ...quiet, warn: (message) => warnings.push(message) };
  let requestedUrl;
  const newer = await checkUpdate(logger, VERSION, async (url) => {
    requestedUrl = url;
    return Response.json({ tag_name: 'v9.0.0', html_url: 'https://example.com/release' });
  });
  assert.equal(requestedUrl, 'https://api.github.com/repos/sunnyhmz7010/SeedMeow/releases/latest');
  assert.deepEqual(newer, { latestVersion: '9.0.0', url: 'https://example.com/release' });
  assert.equal(await checkUpdate(logger, VERSION, async () => new Response('', { status: 503 })), null);
  assert.match(warnings[0], /503/);
  assert.equal(await checkUpdate(logger, VERSION, async () => Response.json({ tag_name: 'invalid' })), null);
  assert.equal(await checkUpdate(logger, VERSION, async () => { throw new Error('offline'); }), null);
  assert.equal(warnings.length, 3);
});
