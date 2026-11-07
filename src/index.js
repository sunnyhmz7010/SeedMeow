import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { parseConfig } from './config.js';
import { matchItem } from './matcher.js';
import { createMeowClient } from './meow.js';
import { Monitor } from './monitor.js';
import { StateStore } from './state.js';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;
const RELEASE_URL = 'https://api.github.com/repos/sunnyhmz7010/SeedMeow/releases/latest';

export function createLogger(name = 'SeedMeow') {
  const write = (level, message) => console[level](`[${new Date().toISOString()}] [${name}] ${message}`);
  return {
    info: (message) => write('log', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message)
  };
}

function compareSemver(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

export async function checkUpdate(logger, currentVersion, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(RELEASE_URL, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      logger.warn(`更新检查失败：HTTP ${response.status}`);
      return null;
    }
    const release = await response.json();
    const latestVersion = release.tag_name?.replace(/^v/, '');
    if (!latestVersion || !/^\d+\.\d+\.\d+$/.test(latestVersion)) {
      logger.warn('更新检查失败：Release 标签不是有效版本号');
      return null;
    }
    if (compareSemver(latestVersion, currentVersion) > 0) {
      logger.info(`发现新版本 v${latestVersion}（当前 v${currentVersion}），请访问 ${release.html_url} 查看更新`);
      return { latestVersion, url: release.html_url };
    }
    logger.info(`当前已是最新版本 v${currentVersion}`);
    return null;
  } catch (error) {
    logger.warn(`更新检查失败：${error.message}`);
    return null;
  }
}

export function describeConfig(config) {
  const categories = config.categories ? [...config.categories].join(',') : 'all';
  const rules = [];
  if (config.keywords.length) rules.push(`关键词：${config.keywords.join(',')}`);
  if (config.keywordGroups.length) rules.push(`组合词：${config.keywordGroups.map((g) => g.join('+')).join(',')}`);
  if (config.regexPatterns.length) rules.push(`正则：${config.regexPatterns.map((r) => r.source).join(',')}`);
  if (config.pushCategory) {
    const label = config.pushCategory === 'all' ? 'all' : [...config.pushCategory].join(',');
    rules.push(`版块匹配：${label}`);
  }
  const parts = [
    `版本 v${VERSION}`,
    `MeoW 昵称 ${config.meowNickname}`,
    `轮询间隔 ${config.checkIntervalMs / 1000} 秒`,
    `匹配范围 ${config.matchScope}`,
    `监控版块 ${categories}`,
    `规则 ${rules.length} 条（${rules.join(' | ')}）`
  ];
  if (config.blockedKeywords.length) parts.push(`屏蔽词：${config.blockedKeywords.join(',')}`);
  if (config.categories) parts.push(`版块过滤：${[...config.categories].join(',')}`);
  parts.push(`首次推送已有 ${config.pushExisting ? '是' : '否'}`);
  parts.push(`显示链接 ${config.showLinkUrl ? '是' : '否'}`);
  if (config.healthCheckMs) parts.push(`自检间隔 ${config.healthCheckMs / 60000} 分钟`);
  return parts.join('，');
}

async function runSource({ source, config, monitor, pusher, logger, fetchItems }, signal, startupUpdate, checkUpdateFn) {
  if (signal.aborted) return;
  let healthCheckTimer;
  let healthCheckTask;
  const stopTimer = () => clearInterval(healthCheckTimer);

  async function healthCheck(startup) {
    let rssOk = true;
    try {
      await fetchItems();
      logger.info('自检订阅源连接正常');
    } catch (error) {
      rssOk = false;
      logger.warn(`自检订阅源连接失败：${error.message}`);
    }
    if (signal.aborted) return;

    const updateInfo = startup ? await startupUpdate : await checkUpdateFn(logger, VERSION);
    if (signal.aborted) return;
    try {
      await pusher.pushHealthCheck({
        rssOk,
        version: VERSION,
        updateInfo,
        configSummary: startup ? describeConfig(config) : ''
      });
      logger.info(startup ? '启动信息已推送至 MeoW' : '自检 MeoW 推送正常');
    } catch (error) {
      logger.error(`${startup ? '启动' : '自检'} MeoW 推送失败，继续监控：${error.message}`);
    }
  }

  await healthCheck(true);
  if (signal.aborted) return;

  if (config.healthCheckMs) {
    healthCheckTimer = setInterval(() => {
      if (signal.aborted || healthCheckTask) return;
      // 同一来源的自检不重叠；退出时等待已开始的自检完成。
      healthCheckTask = healthCheck(false)
        .catch((error) => logger.error(`自检失败：${error.message}`))
        .finally(() => { healthCheckTask = undefined; });
    }, config.healthCheckMs);
  }
  signal.addEventListener('abort', stopTimer, { once: true });
  logger.info('监控已启动');
  try {
    await monitor.run(signal);
  } finally {
    stopTimer();
    signal.removeEventListener('abort', stopTimer);
    await healthCheckTask;
  }
}

export async function runApp({
  env = process.env,
  logger = createLogger(),
  sourceLoggerFactory = (source) => createLogger(source.name),
  stateFactory = (source) => new StateStore(path.resolve('data', source.id, 'state.json'), 1000),
  pusherFactory = (config, source) => createMeowClient({
    nickname: config.meowNickname,
    showLinkUrl: config.showLinkUrl,
    source
  }),
  monitorFactory = (options) => new Monitor(options),
  fetchItemsFactory = (source) => source.fetchItems,
  checkUpdateFn = checkUpdate,
  signal: externalSignal,
  registerSignals = true
} = {}) {
  const configs = parseConfig(env);
  const contexts = configs.map(({ source, config }) => {
    const sourceLogger = sourceLoggerFactory(source);
    const pusher = pusherFactory(config, source);
    const fetchItems = fetchItemsFactory(source);
    const monitor = monitorFactory({
      config,
      fetchItems,
      matcher: matchItem,
      pusher,
      state: stateFactory(source),
      logger: sourceLogger
    });
    return { source, config, pusher, fetchItems, monitor, logger: sourceLogger };
  });

  // 在任何网络推送和调度之前加载所有状态，避免损坏状态下部分启动。
  for (const context of contexts) {
    try {
      await context.monitor.initialize();
    } catch (error) {
      context.logger.error(`状态初始化失败：${error.message}`);
      throw error;
    }
    context.logger.info(`启动配置：${describeConfig(context.config)}`);
  }

  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const stop = (name) => {
    logger.info(`收到 ${name}，等待当前操作和状态保存完成`);
    controller.abort();
  };
  const onSigterm = () => stop('SIGTERM');
  const onSigint = () => stop('SIGINT');

  if (registerSignals) {
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
  }

  const getUpdateInfo = async (sourceLogger, version) => {
    try {
      return await checkUpdateFn(sourceLogger, version);
    } catch (error) {
      sourceLogger.warn(`更新检查失败：${error.message}`);
      return null;
    }
  };
  const startupUpdate = signal.aborted ? Promise.resolve(null) : getUpdateInfo(logger, VERSION);
  const tasks = contexts.map(async (context) => {
    try {
      await runSource(context, signal, startupUpdate, getUpdateInfo);
    } catch (error) {
      context.logger.error(`监控遇到不可恢复错误：${error.message}`);
      throw error;
    }
  });
  try {
    await Promise.all(tasks);
  } finally {
    // 任一任务出现不可恢复错误时，让其他来源也完成退出和状态保存。
    controller.abort();
    await Promise.allSettled(tasks);
    if (registerSignals) {
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runApp().catch((error) => {
    createLogger().error(`启动或运行失败：${error.message}`);
    process.exitCode = 1;
  });
}
