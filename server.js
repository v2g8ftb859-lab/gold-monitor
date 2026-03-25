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
// 关键改动：renotify:true 确保浏览器真正更新通知内容（renotify:false会被大多数浏览器忽略）
// silent:true 确保不响铃不震动
// 每30秒推送一次最新金价到通知栏，无论价格是否变化
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
      title: `📊 ¥${currentGoldPrice.toFixed(2)}/克  ${arrow}${sign}${change.toFixed(2)}`,
      body: `${sign}${changePercent.toFixed(3)}% | ${lastDataSource} | ${now}`,
      tag: 'gold-persistent',         // 固定tag → 替换同一条通知
      renotify: true,                 // ← 关键！必须true，否则浏览器不更新内容
      silent: true,                   // 不响铃、不震动（静默替换）
      requireInteraction: true,       // 不自动消失，钉在通知栏
      vibrate: [],                    // 空数组，不震动
      actions: [{ action: 'view', title: '📊 查看详情' }],
      persistent: true                // 标记给SW，方便SW做特殊处理
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
    renotify: options.renotify ?? true,
    silent: options.silent ?? false,
    requireInteraction: options.requireInteraction ?? false,
    vibrate: options.vibrate || [200, 100, 200],
    actions: options.actions || [],
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
