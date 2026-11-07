import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.js';
import { createMeowClient, formatMessage } from '../src/meow.js';
import { SOURCES } from '../src/sources/index.js';

const env = {
  NODESEEK_MEOW_NICKNAME: 'ns-user',
  NODESEEK_KEYWORDS: 'VPS',
  SB_MEOW_NICKNAME: 'sb-user',
  SB_KEYWORDS: '优惠'
};

test('默认启用两站并独立解析全部设置', () => {
  const [ns, sb] = parseConfig({
    ...env,
    NODESEEK_MATCH_SCOPE: 'title',
    NODESEEK_CATEGORIES: 'daily',
    NODESEEK_PUSH_CATEGORY: 'daily',
    NODESEEK_KEYWORD_GROUPS: '[["香港","VPS"]]',
    NODESEEK_REGEX_PATTERNS: '["年付"]',
    NODESEEK_BLOCK_KEYWORDS: '求购',
    NODESEEK_PUSH_EXISTING: 'true',
    NODESEEK_SHOW_LINK_URL: 'true',
    NODESEEK_HEALTH_CHECK_MINUTES: '0',
    SB_CATEGORIES: 'hosting',
    SB_PUSH_CATEGORY: 'hosting',
    SB_CHECK_INTERVAL_SECONDS: '120'
  });
  assert.equal(ns.source.id, 'nodeseek');
  assert.equal(ns.config.checkIntervalMs, 5000);
  assert.equal(ns.config.meowNickname, 'ns-user');
  assert.deepEqual(ns.config.keywords, ['VPS']);
  assert.deepEqual(ns.config.keywordGroups, [['香港', 'VPS']]);
  assert.deepEqual(ns.config.regexPatterns.map((p) => p.source), ['年付']);
  assert.deepEqual(ns.config.blockedKeywords, ['求购']);
  assert.equal(ns.config.matchScope, 'title');
  assert.equal(ns.config.pushExisting, true);
  assert.equal(ns.config.showLinkUrl, true);
  assert.equal(ns.config.healthCheckMs, null);
  assert.deepEqual([...ns.config.categories], ['daily']);
  assert.deepEqual([...ns.config.pushCategory], ['daily']);

  assert.equal(sb.source.id, 'sb');
  assert.equal(sb.config.checkIntervalMs, 120000);
  assert.equal(sb.config.meowNickname, 'sb-user');
  assert.deepEqual(sb.config.keywords, ['优惠']);
  assert.deepEqual(sb.config.keywordGroups, []);
  assert.deepEqual(sb.config.regexPatterns, []);
  assert.deepEqual(sb.config.blockedKeywords, []);
  assert.equal(sb.config.matchScope, 'all');
  assert.equal(sb.config.pushExisting, false);
  assert.equal(sb.config.showLinkUrl, false);
  assert.equal(sb.config.healthCheckMs, 86400000);
  assert.deepEqual([...sb.config.categories], ['hosting']);
  assert.deepEqual([...sb.config.pushCategory], ['hosting']);
});

test('单站启用时忽略停用来源的缺失或非法配置', () => {
  const [ns] = parseConfig({
    SOURCES: 'nodeseek',
    NODESEEK_MEOW_NICKNAME: 'user',
    NODESEEK_PUSH_CATEGORY: 'all',
    SB_REGEX_PATTERNS: 'broken'
  });
  assert.equal(ns.source.id, 'nodeseek');
  const [sb] = parseConfig({ SOURCES: 'sb', SB_MEOW_NICKNAME: 'user', SB_KEYWORDS: 'VPS' });
  assert.equal(sb.source.id, 'sb');
  assert.equal(sb.config.checkIntervalMs, 60000);
});

test('每站按自己的版块校验，拒绝全局变量继承', () => {
  assert.throws(() => parseConfig({ ...env, NODESEEK_CATEGORIES: 'hosting' }), /NodeSeek.*NODESEEK_.*CATEGORIES/);
  assert.throws(() => parseConfig({ ...env, SB_PUSH_CATEGORY: 'daily' }), /烧饼论坛.*SB_.*PUSH_CATEGORY/);
  assert.throws(() => parseConfig({
    SOURCES: 'sb',
    MEOW_NICKNAME: 'global',
    KEYWORDS: 'VPS'
  }), /SB_.*MEOW_NICKNAME/);
  assert.throws(() => parseConfig({ ...env, SB_KEYWORDS: '' }), /SB_.*正向规则/);
});

test('来源列表拒绝空值和未知来源，并对重复来源去重', () => {
  for (const value of ['', 'other', 'nodeseek,other']) {
    assert.throws(() => parseConfig({ ...env, SOURCES: value }), /SOURCES/);
  }
  assert.equal(parseConfig({ ...env, SOURCES: ' sb, sb ' }).length, 1);
});

test('来源元数据与版块表不可变，未知版块保持原文', () => {
  assert.ok(Object.isFrozen(SOURCES));
  for (const source of Object.values(SOURCES)) {
    assert.ok(Object.isFrozen(source));
    assert.ok(Object.isFrozen(source.categoryNames));
    assert.throws(() => { source.categoryNames.unknown = '未知'; }, TypeError);
    assert.match(formatMessage({ category: 'unknown', pubDate: '' }, {}, source), /版块：unknown/);
    assert.match(formatMessage({ category: '__proto__', pubDate: '' }, {}, source), /版块：__proto__/);
  }
});

for (const source of Object.values(SOURCES)) {
  test(source.name + ' 推送保留来源、图标和独立昵称', async () => {
    const requests = [];
    const client = createMeowClient({
      nickname: source.id + '-user',
      source,
      showLinkUrl: true,
      fetchImpl: async (url, options) => {
        requests.push({ url, payload: JSON.parse(options.body) });
        return Response.json({ status: 200 });
      }
    });
    await client.push({
      title: 'VPS 补货',
      summary: '摘要',
      link: source.homeUrl,
      category: 'trade',
      pubDate: ''
    }, { reason: 'category-push:trade' });
    assert.ok(requests[0].url.endsWith('/' + encodeURIComponent(source.meowSource) + '?msgType=text'));
    assert.ok(requests[0].url.includes(source.id + '-user'));
    assert.equal(requests[0].payload.imgUrl, source.iconUrl);
    assert.match(requests[0].payload.msg, /版块：交易/);
    assert.match(requests[0].payload.msg, /交易（版块匹配）/);
    assert.ok(requests[0].payload.msg.endsWith('🔗 链接：' + source.homeUrl));

    await client.pushHealthCheck({ version: '1.0.0' });
    assert.equal(requests[1].payload.title, 'SeedMeow · ' + source.name + ' 自检');
    assert.equal(requests[1].payload.url, source.homeUrl);
    assert.equal(requests[1].payload.imgUrl, source.iconUrl);
    assert.match(requests[1].payload.msg, /当前版本：v1.0.0/);
    assert.doesNotMatch(requests[1].payload.msg, /已是最新/);
  });
}
