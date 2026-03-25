const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== VAPID 密钥（固定，重启不变） ====================
// 可通过环境变量覆盖，否则使用内置密钥
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BDy-v2PgWg6_BKbpG2_BtHgt3iFjaAqi0rrsBVq45rAAlAQnaKKzJAjgvHOucZS-V0gHhTlpOd7U0I4twjER-U8';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'CQCnVQUWHYTfrHoWcdognU5rtbQccAGPC5_-BzJBeBc';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:gold-monitor@example.com';

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const vapidKeys = { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };

console.log('🔑 VAPID Public Key:', VAPID_PUBLIC_KEY);

// ==================== 数据存储 ====================
let subscriptions = new Map();
let priceHistory = [];
let currentGoldPrice = null;
let previousPrice = null;
let alertSettings = new Map();
let lastDataSource = '初始化中';
// 上金所完整行情数据
let sgeMarketData = {};  // { Au99.99: {latest, high, low, open}, Au(T+D): {...}, ... }
let shanghaiGoldBenchmark = { am: null, pm: null }; // 上海金基准价

// ==================== 多数据源实时金价获取 ====================
// 数据源优先级：
// 1. 上金所延时行情（交易时段最权威）
// 2. 新浪国际金价实时换算（24小时可用）
// 3. 黄金ETF实时价格换算（A股交易时段）
// 4. 上金所首页上海金基准价（每天固定值，兜底）
async function fetchGoldPrice() {
  const sources = [
    { name: '上金所延时行情(Au99.99)', fn: fetchFromSGEDelayed },
    { name: '新浪国际金价换算', fn: fetchFromSinaInternational },
    { name: '黄金ETF(518880)换算', fn: fetchFromGoldETF },
    { name: '上金所首页(上海金基准价)', fn: fetchFromSGEHomepage },
  ];

  for (const source of sources) {
    try {
      const result = await source.fn();
      if (result && result > 0) {
        lastDataSource = source.name;
        console.log(`  📡 数据源: ${source.name}, 价格: ¥${result}`);
        return result;
      }
    } catch (e) {
      console.log(`  ⚠️ ${source.name} 失败: ${e.message}`);
      continue;
    }
  }
  return null;
}

// ===== 数据源1: 上金所延时行情页面 =====
// 交易时段返回实时数据，非交易时段返回 0.0（会被过滤掉）
async function fetchFromSGEDelayed() {
  const response = await fetch('https://www.sge.com.cn/sjzx/yshqbg', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'https://www.sge.com.cn/'
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  let au9999Price = null;
  const allContracts = {};

  $('table tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 4) {
      const contract = $(cells[0]).text().trim();
      const latestPrice = parseFloat($(cells[1]).text().trim());
      const highPrice = parseFloat($(cells[2]).text().trim());
      const lowPrice = parseFloat($(cells[3]).text().trim());
      const openPrice = cells.length >= 5 ? parseFloat($(cells[4]).text().trim()) : null;

      // 关键：必须 > 100 才算有效（非交易时段返回 0.0）
      if (contract && latestPrice > 100) {
        allContracts[contract] = {
          latest: latestPrice,
          high: highPrice || latestPrice,
          low: lowPrice || latestPrice,
          open: openPrice || latestPrice
        };
      }
    }
  });

  if (Object.keys(allContracts).length > 0) {
    sgeMarketData = allContracts;
    console.log(`  📊 解析到 ${Object.keys(allContracts).length} 个合约行情`);
  }

  if (allContracts['Au99.99']?.latest > 0) au9999Price = allContracts['Au99.99'].latest;
  if (!au9999Price && allContracts['Au(T+D)']?.latest > 0) au9999Price = allContracts['Au(T+D)'].latest;
  if (!au9999Price && allContracts['Au100g']?.latest > 0) au9999Price = allContracts['Au100g'].latest;

  if (au9999Price && au9999Price > 100 && au9999Price < 5000) {
    return parseFloat(au9999Price.toFixed(2));
  }

  throw new Error('上金所延时行情无有效数据（可能非交易时段）');
}

// ===== 数据源2（24小时可用）: 新浪国际金价实时换算 =====
// 通过纽约金（COMEX黄金，美元/盎司）+ 美元兑人民币汇率 换算成 人民币/克
async function fetchFromSinaInternational() {
  const response = await fetch('https://hq.sinajs.cn/list=hf_GC,fx_susdcny', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://finance.sina.com.cn/'
    },
    signal: AbortSignal.timeout(8000)
  });

  const text = await response.text();

  // 解析纽约金价（美元/盎司）
  const gcMatch = text.match(/hf_GC="([^"]+)"/);
  if (!gcMatch) throw new Error('无法解析纽约金价');

  const gcFields = gcMatch[1].split(',');
  const goldUSD = parseFloat(gcFields[0]); // 最新价
  if (!goldUSD || goldUSD <= 0) throw new Error('纽约金价为空');

  // 解析美元兑人民币汇率
  const cnyMatch = text.match(/fx_susdcny="([^"]+)"/);
  if (!cnyMatch) throw new Error('无法解析汇率');

  const cnyFields = cnyMatch[1].split(',');
  const usdcny = parseFloat(cnyFields[1]); // 买入价
  if (!usdcny || usdcny <= 0) throw new Error('汇率为空');

  // 换算：美元/盎司 → 人民币/克（1盎司 = 31.1035克）
  const goldCNYPerGram = (goldUSD * usdcny) / 31.1035;

  console.log(`  📊 纽约金: $${goldUSD}/oz × ${usdcny} = ¥${goldCNYPerGram.toFixed(2)}/克`);

  if (goldCNYPerGram > 100 && goldCNYPerGram < 5000) {
    // 保存国际金价信息到 sgeMarketData（补充展示）
    sgeMarketData['国际金(换算)'] = {
      latest: parseFloat(goldCNYPerGram.toFixed(2)),
      high: parseFloat(((parseFloat(gcFields[4]) || goldUSD) * usdcny / 31.1035).toFixed(2)),
      low: parseFloat(((parseFloat(gcFields[5]) || goldUSD) * usdcny / 31.1035).toFixed(2)),
      open: parseFloat(((parseFloat(gcFields[2]) || goldUSD) * usdcny / 31.1035).toFixed(2)),
      goldUSD,
      usdcny
    };
    return parseFloat(goldCNYPerGram.toFixed(2));
  }

  throw new Error(`换算金价异常: ¥${goldCNYPerGram.toFixed(2)}`);
}

// ===== 数据源3: 黄金ETF(518880)实时价格换算 =====
// 华安黄金ETF 每份约对应0.01克黄金，A股交易时段实时更新
async function fetchFromGoldETF() {
  const response = await fetch('https://push2.eastmoney.com/api/qt/stock/get?secid=1.518880&fields=f43,f44,f45,f46,f170,f14&ut=fa5fd1943c7b386f172d6893dbbd1', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://quote.eastmoney.com/'
    },
    signal: AbortSignal.timeout(5000)
  });

  const data = await response.json();
  if (!data.data || !data.data.f43) throw new Error('ETF数据为空');

  // 东方财富返回的价格单位是 厘（1元=1000厘）
  const etfPrice = data.data.f43 / 1000; // 元/份
  const etfHigh = data.data.f44 / 1000;
  const etfLow = data.data.f45 / 1000;

  // 1份ETF ≈ 0.01克黄金 → 金价 = ETF价格 × 100
  const goldPrice = etfPrice * 100;
  const goldHigh = etfHigh * 100;
  const goldLow = etfLow * 100;

  console.log(`  📊 黄金ETF: ¥${etfPrice}/份 → 金价 ≈ ¥${goldPrice.toFixed(2)}/克`);

  if (goldPrice > 100 && goldPrice < 5000) {
    sgeMarketData['黄金ETF(换算)'] = {
      latest: parseFloat(goldPrice.toFixed(2)),
      high: parseFloat(goldHigh.toFixed(2)),
      low: parseFloat(goldLow.toFixed(2)),
      open: parseFloat((data.data.f46 / 1000 * 100).toFixed(2))
    };
    return parseFloat(goldPrice.toFixed(2));
  }

  throw new Error(`ETF换算金价异常: ¥${goldPrice.toFixed(2)}`);
}

// ===== 数据源4（兜底）: 上金所首页上海金基准价 =====
// 每天固定值（早盘/午盘各一个），不会实时变化
async function fetchFromSGEHomepage() {
  const response = await fetch('https://www.sge.com.cn/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();

  const amMatch = html.match(/早盘价[^]*?(\d{3,4}\.\d{1,2})/);
  const pmMatch = html.match(/午盘价[^]*?(\d{3,4}\.\d{1,2})/);

  if (amMatch) shanghaiGoldBenchmark.am = parseFloat(amMatch[1]);
  if (pmMatch) shanghaiGoldBenchmark.pm = parseFloat(pmMatch[1]);

  const benchmarkPrice = shanghaiGoldBenchmark.pm || shanghaiGoldBenchmark.am;

  if (benchmarkPrice && benchmarkPrice > 100 && benchmarkPrice < 5000) {
    console.log(`  📊 上海金基准价 - 早盘: ${shanghaiGoldBenchmark.am || '--'}, 午盘: ${shanghaiGoldBenchmark.pm || '--'}`);
    return parseFloat(benchmarkPrice.toFixed(2));
  }

  throw new Error('上金所首页未找到上海金基准价');
}

// ==================== 价格更新逻辑 ====================
let lastFetchTime = null; // 上次成功获取时间

async function updateGoldPrice() {
  try {
    const newPrice = await fetchGoldPrice();

    if (newPrice) {
      const now = new Date();
      lastFetchTime = now;

      // 计算与上一个不同价格之间的变动
      const change = previousPrice ? parseFloat((newPrice - previousPrice).toFixed(2)) : 0;
      const changePercent = previousPrice
        ? parseFloat(((newPrice - previousPrice) / previousPrice * 100).toFixed(4))
        : 0;

      const record = {
        price: newPrice,
        timestamp: now.toISOString(),
        time: now.toLocaleTimeString('zh-CN', { hour12: false }),
        change,
        changePercent,
        source: lastDataSource
      };

      // 只在价格真正变化时才写入新历史记录，避免重复
      if (newPrice !== currentGoldPrice) {
        // 价格变化了，更新 previousPrice
        previousPrice = currentGoldPrice;
        currentGoldPrice = newPrice;

        priceHistory.push(record);
        if (priceHistory.length > 500) {
          priceHistory = priceHistory.slice(-500);
        }

        console.log(`💰 金价更新: ¥${newPrice}/克 | 变动: ${change >= 0 ? '+' : ''}${change} (${changePercent}%) | 数据源: ${lastDataSource}`);

        // 价格变化时才检查告警
        checkAlerts(newPrice, record);
      } else {
        // 价格没变，只更新时间戳（静默，不打日志刷屏）
        if (priceHistory.length > 0) {
          priceHistory[priceHistory.length - 1].timestamp = now.toISOString();
          priceHistory[priceHistory.length - 1].time = now.toLocaleTimeString('zh-CN', { hour12: false });
        }
      }
    }
  } catch (error) {
    console.error('❌ 金价更新失败:', error.message);
  }
}

// ==================== 告警检查（价格变动时调用） ====================
function checkAlerts(price, record) {
  subscriptions.forEach((sub, id) => {
    const settings = alertSettings.get(id) || {};

    // 常驻通知在 pushPersistentNotifications() 中独立处理，这里只处理告警

    // ====== 普通告警推送（响铃弹出，只在触发条件时才推） ======
    let alertTitle = '';
    let alertBody = '';

    // 普通定时推送（每次价格变动都弹通知，会响铃）
    if (settings.alwaysNotify) {
      const arrow = record.change >= 0 ? '📈' : '📉';
      alertTitle = '💰 金价更新';
      alertBody = `${arrow} ¥${price}/克 | ${record.change >= 0 ? '+' : ''}¥${record.change} (${record.changePercent}%)`;
    }

    // 价格上限告警（优先级更高，覆盖普通推送）
    if (settings.upperLimit && price >= settings.upperLimit) {
      alertTitle = '🚨 金价上限告警';
      alertBody = `Au99.99 已达 ¥${price}/克，超过上限 ¥${settings.upperLimit}！`;
    }

    // 价格下限告警
    if (settings.lowerLimit && price <= settings.lowerLimit) {
      alertTitle = '🚨 金价下限告警';
      alertBody = `Au99.99 已降至 ¥${price}/克，低于下限 ¥${settings.lowerLimit}！`;
    }

    // 波动幅度告警
    if (settings.changeThreshold && Math.abs(record.changePercent) >= settings.changeThreshold) {
      alertTitle = '⚠️ 金价剧烈波动';
      alertBody = `Au99.99 波动 ${record.changePercent}%，当前 ¥${price}/克`;
    }

    if (alertTitle && alertBody) {
      sendPushNotification(sub, {
        title: alertTitle,
        body: alertBody,
        tag: 'gold-alert-' + Date.now(),  // 每条告警独立（不覆盖），确保用户看到
        renotify: true,                    // 重新提醒（响铃+震动）
        silent: false,
        requireInteraction: false,         // 自动消失
        vibrate: [200, 100, 200],
        actions: [
          { action: 'view', title: '查看详情' },
          { action: 'dismiss', title: '忽略' }
        ]
      });
    }
  });
}

// ==================== 常驻通知（独立于价格变动，每次cron都推） ====================
// 根据 web.dev 官方文档：
//   - 相同 tag 的通知会自动替换旧通知
//   - renotify 默认 false = 替换时不响铃不震动（静默替换）
//   - renotify: true = 替换时重新响铃震动（这就是之前"每次都弹新通知"的原因！）
// 所以正确做法：固定 tag + 不设 renotify（默认false）= 静默原地替换
function pushPersistentNotifications() {
  if (!currentGoldPrice) return;

  const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const lastRecord = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1] : null;
  const change = lastRecord ? lastRecord.change : 0;
  const changePercent = lastRecord ? lastRecord.changePercent : 0;
  const arrow = change >= 0 ? '▲' : '▼';
  const sign = change >= 0 ? '+' : '';

  subscriptions.forEach((sub, id) => {
    const settings = alertSettings.get(id) || {};
    if (!settings.persistentNotify) return;

    sendPushNotification(sub, {
      title: `📊 金价 ¥${currentGoldPrice.toFixed(2)}/克  ${arrow}${sign}${change.toFixed(2)}`,
      body: `涨跌: ${sign}${changePercent.toFixed(3)}% | ${lastDataSource}\n⏱ 更新: ${now}`,
      tag: 'gold-persistent',         // ← 固定tag，同tag自动替换旧通知
      renotify: false,                // ← 关键！false=静默替换，不响铃不震动不弹出
      silent: true,                   // 双保险：静默
      requireInteraction: true,       // 不自动消失，钉在通知栏
      vibrate: [],                    // 不震动
      actions: [{ action: 'view', title: '📊 查看详情' }],
      persistent: true                // 标记给SW做特殊处理
    });
  });
}

// ==================== 推送通知 ====================
async function sendPushNotification(subscription, options) {
  const payload = JSON.stringify({
    title: options.title,
    body: options.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: options.tag || 'gold-price',
    renotify: options.renotify ?? false,        // ← 默认false！只有告警通知显式设true
    silent: options.silent ?? false,
    requireInteraction: options.requireInteraction ?? false,
    vibrate: options.vibrate || [],
    actions: options.actions || [],
    persistent: options.persistent || false,     // ← 必须传给SW！之前漏掉了
    data: {
      price: currentGoldPrice,
      timestamp: new Date().toISOString(),
      url: '/'
    }
  });

  try {
    await webpush.sendNotification(subscription, payload);
  } catch (error) {
    if (error.statusCode === 410 || error.statusCode === 404) {
      // 订阅已失效，移除
      subscriptions.forEach((sub, id) => {
        if (sub.endpoint === subscription.endpoint) {
          subscriptions.delete(id);
          alertSettings.delete(id);
        }
      });
    }
    console.error('推送失败:', error.message);
  }
}

// ==================== API 路由 ====================

// 获取 VAPID 公钥
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// 订阅推送
app.post('/api/subscribe', (req, res) => {
  const { subscription, settings } = req.body;
  const id = crypto.createHash('md5').update(subscription.endpoint).digest('hex');

  subscriptions.set(id, subscription);
  if (settings) {
    alertSettings.set(id, settings);
  }

  console.log(`📱 新订阅: ${id}`);
  res.json({ success: true, id });
});

// 取消订阅（关闭通知时调用）
app.post('/api/unsubscribe', (req, res) => {
  const { subscriptionId } = req.body;
  if (subscriptionId) {
    subscriptions.delete(subscriptionId);
    alertSettings.delete(subscriptionId);
    console.log(`🔕 已删除订阅: ${subscriptionId}`);
    res.json({ success: true });
  } else {
    res.status(400).json({ error: '缺少订阅ID' });
  }
});

// 更新告警设置
app.post('/api/settings', (req, res) => {
  const { subscriptionId, settings, subscription } = req.body;
  if (subscriptionId) {
    alertSettings.set(subscriptionId, settings);
    // 如果同时传了 subscription 对象，也更新订阅（防止重启丢失）
    if (subscription) {
      subscriptions.set(subscriptionId, subscription);
    }
    res.json({ success: true });
  } else {
    res.status(400).json({ error: '缺少订阅ID' });
  }
});

// 获取当前金价
app.get('/api/price', (req, res) => {
  const au9999 = sgeMarketData['Au99.99'] || {};
  const auTD = sgeMarketData['Au(T+D)'] || {};
  res.json({
    price: currentGoldPrice,
    previousPrice,
    change: previousPrice ? parseFloat((currentGoldPrice - previousPrice).toFixed(2)) : 0,
    changePercent: previousPrice
      ? parseFloat(((currentGoldPrice - previousPrice) / previousPrice * 100).toFixed(4))
      : 0,
    timestamp: new Date().toISOString(),
    unit: 'CNY/g',
    source: lastDataSource,
    // 上金所 Au99.99 行情
    au9999: {
      latest: au9999.latest || null,
      high: au9999.high || null,
      low: au9999.low || null,
      open: au9999.open || null
    },
    // Au(T+D) 行情
    auTD: {
      latest: auTD.latest || null,
      high: auTD.high || null,
      low: auTD.low || null,
      open: auTD.open || null
    },
    // 上海金基准价
    benchmark: shanghaiGoldBenchmark
  });
});

// 获取历史价格
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({
    history: priceHistory.slice(-limit),
    total: priceHistory.length
  });
});

// 手动发送测试通知
app.post('/api/test-notification', (req, res) => {
  const { subscriptionId } = req.body;
  const sub = subscriptions.get(subscriptionId);

  if (sub) {
    sendPushNotification(sub, {
      title: '🔔 测试通知',
      body: `金价监控运行中！当前 ¥${currentGoldPrice || '获取中...'}/克 | ${lastDataSource}`,
      tag: 'gold-test-' + Date.now(),
      renotify: true,
      silent: false,
      requireInteraction: false,
      vibrate: [200, 100, 200],
      actions: [{ action: 'view', title: '查看详情' }]
    });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '未找到订阅' });
  }
});

// SSE 实时推送
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 立即发送当前价格
  if (currentGoldPrice) {
    const lastRecord = priceHistory[priceHistory.length - 1];
    res.write(`data: ${JSON.stringify({
      price: currentGoldPrice,
      previousPrice,
      change: lastRecord?.change || 0,
      changePercent: lastRecord?.changePercent || 0,
      timestamp: new Date().toISOString(),
      source: lastDataSource,
      sgeMarket: sgeMarketData,
      benchmark: shanghaiGoldBenchmark
    })}\n\n`);
  }

  // SSE 只负责推送已有数据，不再重复调 updateGoldPrice
  // 金价更新统一由 cron 每30秒执行一次
  const intervalId = setInterval(() => {
    if (currentGoldPrice) {
      const lastRecord = priceHistory[priceHistory.length - 1];
      res.write(`data: ${JSON.stringify({
        price: currentGoldPrice,
        previousPrice,
        change: lastRecord?.change || 0,
        changePercent: lastRecord?.changePercent || 0,
        timestamp: new Date().toISOString(),
        source: lastDataSource,
        sgeMarket: sgeMarketData,
        benchmark: shanghaiGoldBenchmark
      })}\n\n`);
    }
  }, 30000);  // 每30秒推送一次已有数据，与 cron 频率一致

  req.on('close', () => {
    clearInterval(intervalId);
  });
});

// ==================== 吵架/怼人助手 API ====================
// 回复模板库 — 按风格+场景分类
const roastTemplates = {
  // ==================== 高情商回怼 ====================
  elegant: {
    marriage: [
      "谢谢关心~我在等一个值得我降低标准的人，毕竟不是所有人都像您一样，随便找个人就将就了。",
      "您这么关心我的感情状态，是您的婚姻不太幸福，想找人一起分担孤独感吗？",
      "我还在挑呢，不像有些人，先结了再说，后悔了也不敢离。",
      "缘分到了自然就结了，不像某些人，结婚只是为了给亲戚一个交代。",
      "我一个人过得很好啊，有钱有闲有自由，您确定要安利婚姻给我？",
      "我在等一个让我觉得结婚比单身更快乐的人，这个要求不过分吧？"
    ],
    salary: [
      "没有您赚得多，但够花，也没借过别人的钱，挺好的~",
      "抱歉，我的财务状况只向银行和税务局汇报，不接受民间审计。",
      "够买我喜欢的东西，够对我好的人好，至于具体数字，这是我和工资卡之间的秘密。",
      "您是想给我介绍高薪工作还是想借钱？如果都不是的话，这个问题意义不大哈~",
      "足够让我不需要向别人打听工资来获得优越感了~",
      "钱多钱少不重要，重要的是我靠自己赚的，心安理得。"
    ],
    weight: [
      "谢谢您的'关心'~不过我的体重和您的关系，大概和您的发际线和我的关系一样——咱各管各的。",
      "胖了说明我最近过得不错，吃得好睡得香，您也可以试试。",
      "谢谢提醒！不过我身上每一斤肉都是快乐的重量，您呢？",
      "至少我胖在明面上，有些人心眼小得可是一眼看不出来呢~",
      "我的体重和我的人生一样，都在我自己掌控中，不需要外界评价。",
      "是的，快乐的代价就是胖了几斤。看您这么瘦，一定不太快乐吧？"
    ],
    major: [
      "能啊，养活自己还有余力请您喝咖啡，下次要不要试试？",
      "专业只是起点，能力才是终点。当然，如果您只能靠专业吃饭，那确实应该担心。",
      "我学到的不只是专业知识，还有独立思考的能力——这个可比很多'热门专业'值钱多了。",
      "找工作靠的是能力，不是专业名字。您要是只看标签选人，那确实挑不到什么好东西。",
      "比起'能不能找到工作'，我更关心'能不能做自己喜欢的事'，这个区别您懂吗？"
    ],
    compare: [
      "别人家孩子确实优秀，那您去给别人家当爸妈也行啊，正好我也想试试独立。",
      "别人家的孩子好，因为您只看到了人家的亮点。别人家的父母也好，但我没拿来比过~",
      "比较是一条没有终点的路，建议您和'别人家的父母'也比比？",
      "我会努力变优秀的，不是因为别人家的孩子，是因为我自己想。",
      "每个孩子都有自己的花期，您浇水就好，别忙着和别人的花园比。"
    ],
    gender: [
      "读书的用处是让我能分辨出这种话有多愚蠢。",
      "读书让我有选择的权利，包括选择不跟说这种话的人计较。",
      "有没有用我不知道，但至少让我不会说出这么无知的话来。",
      "知识的用处之一，就是让我能优雅地反驳这种偏见。",
      "女孩子读书有什么用？用处就是不需要依附任何人就能活得很好。"
    ],
    age_gaming: [
      "玩游戏不分年龄，但说这种话暴露了您的认知水平。",
      "快乐是没有年龄限制的，如果您不理解，那可能是您太久没快乐过了。",
      "巴菲特93岁还在炒股，我玩个游戏怎么了？",
      "年龄和爱好没有关系，但偏见和无知通常成正比。",
      "游戏是第九艺术，不懂就别评论，跟说'成年人还看电影'一样可笑。"
    ],
    civil_servant: [
      "谢谢关心，不过我的职业规划是根据自己的能力和兴趣来的，不是亲戚聚会的投票结果。",
      "考公是一种选择，不考也是。人生不只有一条路，您觉得窄可能是您走的路太少了。",
      "我更喜欢在市场上检验自己的价值，而不是在体制里检验自己的耐心。",
      "您这么推荐考公，是在体制内待得很开心，还是不开心所以想找人陪？"
    ],
    job: [
      "稳不稳定我心里有数，至少每天上班不用装孙子，这就是最大的稳定。",
      "稳定的工作是一种选择，稳定的能力是一种保障。我选择了后者。",
      "工作稳不稳定取决于我的能力，不取决于您的看法。",
      "您觉得不稳定是因为您不了解这个行业，就像我不了解您为什么总关心别人的工作一样。"
    ],
    house: [
      "买不买房是我的事，但您关心别人买不买房，说明您除了房子没什么别的谈资了。",
      "人这辈子，比房子重要的东西多了去了。如果您的人生只剩房子，那确实挺可悲的。",
      "我买房不需要别人认可，就像我的人生不需要别人来评价一样。",
      "与其讨论我买不买得起房，不如讨论您为什么对别人的钱包这么感兴趣？"
    ],
    default: [
      "您说得对，我虚心接受。但如果您是认真的，那我建议您先检查一下自己的生活。",
      "这句话说的，我都不知道该佩服您的勇气还是同情您的无知了。",
      "谢谢您的看法，不过我通常只参考有建设性的意见，抱歉您这条不符合标准。",
      "你说的好有道理哦，但可惜，我不需要没被邀请的评委来给我的人生打分。",
      "如果嘴巴这么厉害能换钱，您现在应该已经财务自由了。",
      "我尊重您发表意见的权利，也请您尊重我完全不在乎的权利。"
    ]
  },

  // ==================== 发疯文学 ====================
  crazy: {
    marriage: [
      "啊！你说得对！我这就去路边随便拉一个结婚！管他是人是鬼！结了就行！让你满意！你满意了吧！啊啊啊啊！！！",
      "好好好！我不结婚就是原罪！那你帮我安排一个呗？什么？没有合适的？那你催个锤子啊啊啊啊！！！",
      "呜呜呜你说的对我好失败我居然还没结婚我好想死可是死了也没人给我办葬礼因为我连个老公都没有啊啊啊啊救命啊啊啊！！！",
      "你再催我结婚我就当场发疯了啊啊啊啊！我跟你说！我没结婚是因为地球上的人还配不上我！你信不信！你不信拉倒！啊啊啊！",
      "好！既然你这么关心我结不结婚！那你来当我的配偶吧！什么？你不愿意？那你催什么啊你到底想怎样啊啊啊啊啊！！",
      "你要是再催我结婚我就原地爆炸了你知不知道！砰！炸了！没了！你开心了吧！我变成烟花了总不用结婚了吧！！！"
    ],
    salary: [
      "你问我工资？好啊我告诉你！我穷！我穷得只剩快乐了！你满意了吗？你开心了吗？你终于可以嘲笑我了吗？啊啊啊啊！",
      "我的工资？我告诉你了你能帮我涨吗？不能是吧？那你问个锤子啊啊啊啊！你是税务局的吗你！",
      "哈哈哈哈哈你问我工资！好家伙你是来审计的吗！你这么关心我的工资是不是想借钱！不借！一分都不借！就算我月入百万我也不借！啊啊啊！",
      "我工资多少关你什么事啊关你什么事！你是央行行长吗你管我印多少钱！你再问我就原地表演一个精神崩溃给你看！！！"
    ],
    weight: [
      "你说我胖！！你竟然说我胖！！我这叫丰满！叫圆润！叫有福气！你这个干巴巴的咸鱼有什么资格说我！啊啊啊啊！",
      "对！我胖了！然后呢！你是想赞助我去健身还是想资助我做抽脂！都没有的话你闭嘴啊啊啊啊啊！！！",
      "哈哈哈哈你说我胖！好笑死了！我胖我至少快乐！你瘦你快乐了吗！你怎么一脸苦瓜相啊！是不是因为太瘦脑子缺营养了！啊啊啊！",
      "你说我胖我就真的好伤心好难过呜呜呜呜然后我要化悲愤为食欲我要吃十个汉堡来治愈自己然后变得更胖给你看！！你满意了吗！！"
    ],
    default: [
      "啊啊啊啊啊你怎么能说出这种话！你是人吗你！你有心吗你！你知不知道我现在的状态已经是疯批美人了你还刺激我！啊啊啊啊啊！！！",
      "好好好！你说的都对！你是这个世界上最正确的人！你说的每一句话都是真理！我不配跟你说话！我这就原地消失！砰！没了！你开心了吧！！！",
      "你再说一句我就当场哭给你看你信不信！呜呜呜呜呜你怎么可以这样说我呜呜呜我好委屈我好难过我要回家找妈妈啊啊啊啊！",
      "我发疯了我真的发疯了！！你一句话把我最后一根理智的弦给弹断了！弹断了你知道吗！现在后果自负！！我开始发疯了！啊啊啊啊！",
      "哈哈哈哈好好好你继续说你继续说！反正我已经疯了！你说什么我都无所谓了！因为疯子是不会受伤的你知道吗！哈哈哈哈哈！",
      "你说出这种话的时候有没有照过镜子！没有的话我建议你去照一照！你会看到一个比你说的话还离谱的人！啊啊啊啊我受不了了！！！"
    ]
  },

  // ==================== 阴阳怪气 ====================
  sarcastic: {
    marriage: [
      "哟~您这么关心我的感情状态，该不会是您的婚姻不太美满，想拉个人一起下水吧？😏",
      "还没呢~不过没关系，至少我单身是因为我在选，不是没人选嘛。您说是吧？",
      "哎哟喂，您都替我操心结婚了，您家那位知道吗？应该把这份关心多留给身边人吧~",
      "是啊~我还没结婚~真是太不幸了~您结了就幸福了吗？哦不好意思，看您这表情好像也不怎么样~",
      "我结不结婚跟您有什么关系？哦我知道了，您是对自己的婚姻不太满意所以想确认下别人是不是也一样惨~",
      "结婚还没有，但自由我有。您有吗？哦对了，您不方便说~"
    ],
    salary: [
      "哟~这就打听上了？我看您挺像我们公司HR的~可惜不是，所以这个问题您就别操心了~",
      "不多不少~反正我发工资不需要跟您报备，您又不是我的财务顾问~要不您先说说？",
      "我的工资啊~够我过得比问别人工资的人体面就行了~",
      "您问我工资？我还以为您想请我吃饭呢~原来只是好奇心泛滥了~下次好奇心可以用在学习上哦~"
    ],
    weight: [
      "哎呀~您的眼神可真好使~不过我胖不胖好像跟您没有半毛钱关系呢~还是多关注下自己那日渐后移的发际线吧~",
      "是的呢~因为我把您的份也吃了~毕竟有些人只靠嘴就能活~不用吃东西的~",
      "哟~我胖了您好像比我还着急呢~不知道的还以为您是我的私人营养师~可惜您不是~",
      "胖了就胖了呗~至少我身上有肉~不像有些人~只有一张嘴特别能叨叨~"
    ],
    default: [
      "哟~您这话说的，我都不知道该怎么接了。不过没关系，像您这种水平的话，我一般是不回复的，今天算给您面子~",
      "啧啧啧~这话说的真有水平~我建议您去参加脱口秀~不过要做好被观众赶下台的准备~",
      "哇~您说话怎么这么有勇气呢~是无知给了您力量吧？真是好羡慕啊~",
      "嗯嗯嗯~您说的都对~毕竟在这方面~没有人比您更有经验了~是吧~",
      "您这张嘴可真厉害~可惜厉害的只有嘴~别的方面嘛~啧啧~我就不多说了~",
      "噢~好的呢~我记住您说的话了哦~下次您需要帮助的时候我也会「真诚」地回馈您的~"
    ]
  },

  // ==================== 逻辑鬼才 ====================
  logic: {
    marriage: [
      "按照你的逻辑，结婚 = 成功。那离婚率将近50%，是不是说一半的已婚人士都是失败的？那结婚的风险回报比也不怎么样嘛。",
      "你催我结婚的预设是：单身 = 有问题。但这个前提本身就有问题。第一，婚姻不是人生必选项；第二，你对我的感情生活一无所知就下结论，这在逻辑学上叫「诉诸无知的谬误」。",
      "如果结婚是为了幸福，那前提是找到对的人。在还没找到的情况下催我结婚，就好比催一个还没到站的乘客下车——你到底是关心我还是关心仪式？",
      "「你怎么还没结婚」这个问句包含了一个隐含前提：你应该在某个年龄之前结婚。请问这个'应该'的依据是什么？是法律、科学还是你的个人偏见？",
      "让我帮你做个成本收益分析：催我结婚的成本 = 得罪我 + 浪费唾沫。收益 = 0。建议你做更有正收益的事情。"
    ],
    salary: [
      "你问我工资，我反问你三个问题：第一，你问的目的是什么？第二，我的回答会改变什么？第三，如果我说的比你多或者比你少，接下来你打算干嘛？如果这三个问题你都答不上来，说明这个问题毫无意义。",
      "工资是一个人的隐私数据，你在公开场合索要别人的隐私数据，这在任何文明社会都属于不礼貌的行为。如果你理解这一点但还是问了，那说明你根本不在乎礼貌。",
      "收入 ≠ 价值，正如价格 ≠ 价值。你用工资来衡量一个人，说明你的评价体系过于单一，建议升级一下认知维度。",
      "假设我告诉你了，然后呢？你会嫉妒还是同情？无论哪种，对你我都没有好处。所以这是一个纳什均衡下的劣势策略，不建议执行。"
    ],
    weight: [
      "你说我胖了，请问你的参照物是什么？是我上次见你的体重？还是你心目中的标准体重？如果是后者，请问你的标准依据是BMI还是主观审美？因为这两者经常自相矛盾。",
      "体重增加有很多原因：压力、睡眠、饮食、运动量变化。你不了解任何一个变量就直接给出结论，这在科学方法论上叫做「不充分归纳谬误」。",
      "我的体重只和我的健康有关，而我的健康只和我的医生有关。你既不是我的医生也不是我的营养师，所以你在我的体重问题上没有发言权。"
    ],
    default: [
      "你的这个观点，需要满足三个前提条件才能成立：第一，你对情况完全了解；第二，你的判断标准是客观的；第三，你的结论能经得起反证。很遗憾，三条你一条都不满足。",
      "让我用反证法回应你：如果你说的是对的，那世界上应该有大量证据支持你的观点。但事实上，持有你这种观点的人通常都是信息量不足的。这就产生了逻辑矛盾，所以你的结论不成立。",
      "你的话犯了几个典型的逻辑谬误：1.以偏概全 2.诉诸个人经验 3.稻草人论证。建议你先去了解一下基本的逻辑学概念再来发表意见。",
      "我注意到你说这句话的时候非常自信，但自信和正确性之间没有因果关系。历史上很多错得离谱的人也都非常自信。",
      "这个问题的答案取决于你问问题的目的。如果你是真心好奇，我可以解释；如果你只是想显摆优越感，那我建议你找一面镜子，效果更好。",
      "根据奥卡姆剃刀原则，如无必要，勿增实体。你这句话完全没必要说，它既不能解决问题，也不能增进感情，唯一的效果是暴露了你的认知局限。"
    ]
  }
};

// 场景识别关键词映射
const sceneKeywords = {
  marriage: ['结婚', '嫁', '对象', '男朋友', '女朋友', '单身', '相亲', '脱单', '恋爱', '谈朋友', '娶', '生孩子', '催婚'],
  salary: ['工资', '月薪', '年薪', '收入', '挣钱', '赚钱', '薪水', '薪资', '多少钱', '一个月'],
  weight: ['胖', '瘦', '体重', '减肥', '长肉', '发福', '身材'],
  major: ['专业', '找工作', '就业', '学历', '文凭', '读书'],
  compare: ['别人家', '人家', '你看看', '比比', '不如'],
  gender: ['女孩子', '女生', '女人', '读书有什么用', '干得好不如嫁得好'],
  age_gaming: ['玩游戏', '打游戏', '幼稚', '长不大', '年纪'],
  civil_servant: ['考公', '公务员', '事业编', '铁饭碗', '编制'],
  job: ['稳定', '工作不稳定', '铁饭碗', '靠谱'],
  house: ['买房', '房子', '首付', '房价']
};

// 识别场景
function detectScene(text) {
  for (const [scene, keywords] of Object.entries(sceneKeywords)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return scene;
    }
  }
  return 'default';
}

// 从模板库中随机挑选不重复的 N 条
function pickRandom(arr, count = 3) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// 吵架助手 API
app.post('/api/roast', (req, res) => {
  const { text, style } = req.body;

  if (!text || !style) {
    return res.status(400).json({ error: '缺少参数 text 或 style' });
  }

  const scene = detectScene(text);
  const styleTemplates = roastTemplates[style] || roastTemplates.elegant;

  // 优先使用场景模板，fallback 到 default
  let pool = styleTemplates[scene] || styleTemplates.default || [];

  // 如果场景模板不足3条，补充 default
  if (pool.length < 3 && styleTemplates.default) {
    const extras = styleTemplates.default.filter(t => !pool.includes(t));
    pool = [...pool, ...extras];
  }

  const replies = pickRandom(pool, 3);

  // 模拟 AI 思考延迟（800~1500ms）
  const delay = 800 + Math.random() * 700;
  setTimeout(() => {
    res.json({
      replies,
      style,
      scene,
      original: text
    });
  }, delay);
});

// 所有其他路由返回 index.html（SPA）
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== Render 免费方案防休眠 ====================
// Render 免费方案 15 分钟无请求会休眠，用定时自请求保持唤醒
function keepAlive() {
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    setInterval(async () => {
      try {
        await fetch(`${RENDER_URL}/api/price`);
        console.log('🏓 Keep-alive ping sent');
      } catch (e) {
        console.log('🏓 Keep-alive ping failed:', e.message);
      }
    }, 10 * 60 * 1000); // 每 10 分钟 ping 一次
  }
}

// ==================== 启动服务 ====================
app.listen(PORT, () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const renderUrl = process.env.RENDER_EXTERNAL_URL;

  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   💰 上金所黄金实时监控 已启动               ║
  ║   📡 访问: ${renderUrl || `http://localhost:${PORT}`}
  ║   🌍 环境: ${isProduction ? '生产环境' : '开发环境'}
  ╚═══════════════════════════════════════════╝
  `);

  // 初次获取金价
  updateGoldPrice();

  // 每30秒更新一次金价（cron定时任务）
  cron.schedule('*/30 * * * * *', () => {
    updateGoldPrice();
    // 常驻通知：每次cron都推送最新金价到通知栏（独立于价格变动）
    pushPersistentNotifications();
  });

  // 生产环境开启防休眠
  if (isProduction) {
    keepAlive();
  }
});
