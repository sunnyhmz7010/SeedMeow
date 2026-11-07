const MEOW_BASE_URL = 'https://api.chuckfang.com';

function categoryName(slug, source) {
  if (!slug) return '未知';
  return Object.hasOwn(source.categoryNames, slug) ? source.categoryNames[slug] : slug;
}

function formatSingleKeyword(reason = '', source) {
  if (reason.startsWith('keyword:')) return reason.slice('keyword:'.length);
  if (reason.startsWith('group:')) return reason.slice('group:'.length);
  if (reason.startsWith('regex:')) return reason.slice('regex:'.length);
  if (reason.startsWith('category-push:')) return `${categoryName(reason.slice('category-push:'.length), source)}（版块匹配）`;
  return reason;
}

function formatKeyword(reason = '', source) {
  return reason.split('|').filter(Boolean).map((part) => formatSingleKeyword(part, source)).join(' ');
}

export function formatReason(reason = '', source) {
  if (reason === 'no-match') return '未命中';
  if (reason === 'category') return '版块过滤';
  if (reason.startsWith('blocked:')) return `屏蔽词（${reason.slice('blocked:'.length)}）`;
  return formatKeyword(reason, source);
}

function formatChineseTime(value) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value || '未知';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date(time)).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatMessage(item, match = {}, source) {
  return [
    `📌 版块：${categoryName(item.category, source)}`,
    `👤 作者：${item.creator || '未知'}`,
    `🎯 命中规则：${formatKeyword(match.reason, source)}`,
    `🕒 发布时间：${formatChineseTime(item.pubDate)}`,
    `📝 摘要：${item.summary || '（无摘要）'}`
  ].join('\n');
}

export function createMeowClient({
  nickname,
  source,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  showLinkUrl = false
}) {
  const endpoint = `${MEOW_BASE_URL}/${encodeURIComponent(nickname)}/${encodeURIComponent(source.meowSource)}?msgType=text`;

  async function post(payload) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        imgUrl: source.iconUrl
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) throw new Error(`MeoW 请求失败: HTTP ${response.status}`);

    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw new Error(`MeoW 响应不是有效 JSON: ${error.message}`);
    }
    if (result.status !== 200) {
      const detail = result.msg ?? result.message ?? '';
      throw new Error(`MeoW 推送失败: ${result.status ?? '未知状态'} ${detail}`.trim());
    }
  }

  return {
    async push(item, match) {
      let msg = formatMessage(item, match, source);
      if (showLinkUrl && item.link) {
        msg += `\n🔗 链接：${item.link}`;
      }
      await post({
        title: item.title,
        msg,
        url: item.link
      });
    },
    async pushHealthCheck({ rssOk = true, version = '', updateInfo = null, configSummary = '' } = {}) {
      const lines = [];
      if (rssOk) {
        lines.push(`SeedMeow（${source.name}）订阅源与 MeoW 连接正常。`);
      } else {
        lines.push(`SeedMeow（${source.name}）MeoW 连接正常；订阅源连接异常，请检查网络或论坛订阅服务。`);
      }
      if (version) {
        const updateLine = updateInfo
          ? `当前版本：v${version}，发现新版本 v${updateInfo.latestVersion}！请访问 ${updateInfo.url} 查看更新。`
          : `当前版本：v${version}`;
        lines.push(updateLine);
      }
      if (configSummary) {
        lines.push(`⚙️ 启动配置：${configSummary}`);
      }
      await post({
        title: `SeedMeow · ${source.name} ${configSummary ? '启动' : '自检'}`,
        msg: lines.join('\n'),
        url: source.homeUrl
      });
    },
    async pushConfig(summary) {
      await post({
        title: `SeedMeow · ${source.name} 启动配置`,
        msg: summary,
        url: source.homeUrl
      });
    },
    async pushError(message) {
      await post({
        title: `SeedMeow · ${source.name} 异常`,
        msg: message,
        url: source.homeUrl
      });
    },
    async pushRecovery() {
      await post({
        title: `SeedMeow · ${source.name} 恢复`,
        msg: 'RSS 连接已恢复，监控正常运行。',
        url: source.homeUrl
      });
    }
  };
}
