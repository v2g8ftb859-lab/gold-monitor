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

// ==================== 上金所实时金价获取 ====================
// 所有数据来源于上海黄金交易所官网 https://www.sge.com.cn/
async function fetchGoldPrice() {
  const sources = [
    { name: '上金所延时行情(Au99.99)', fn: fetchFromSGEDelayed },
    { name: '上金所首页(上海金基准价)', fn: fetchFromSGEHomepage },
    { name: '东方财富-沪金主力', fn: fetchFromEastMoneyFutures },
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

// ===== 数据源1（主力）: 上金所延时行情页面 =====
// 直接抓取 https://www.sge.com.cn/sjzx/yshqbg 的HTML表格
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

  // 解析表格数据
  let au9999Price = null;
  const allContracts = {};

  // 遍历所有表格行
  $('table tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 4) {
      const contract = $(cells[0]).text().trim();
      const latestPrice = parseFloat($(cells[1]).text().trim());
      const highPrice = parseFloat($(cells[2]).text().trim());
      const lowPrice = parseFloat($(cells[3]).text().trim());
      const openPrice = cells.length >= 5 ? parseFloat($(cells[4]).text().trim()) : null;

      if (contract && latestPrice > 0) {
        allContracts[contract] = {
          latest: latestPrice,
          high: highPrice || latestPrice,
          low: lowPrice || latestPrice,
          open: openPrice || latestPrice
        };
      }
    }
  });

  // 保存完整行情数据
  if (Object.keys(allContracts).length > 0) {
    sgeMarketData = allContracts;
    console.log(`  📊 解析到 ${Object.keys(allContracts).length} 个合约行情`);
  }

  // 优先取 Au99.99
  if (allContracts['Au99.99'] && allContracts['Au99.99'].latest > 0) {
    au9999Price = allContracts['Au99.99'].latest;
  }
  // 其次取 Au(T+D)
  if (!au9999Price && allContracts['Au(T+D)'] && allContracts['Au(T+D)'].latest > 0) {
    au9999Price = allContracts['Au(T+D)'].latest;
  }
  // 再次取 Au100g
  if (!au9999Price && allContracts['Au100g'] && allContracts['Au100g'].latest > 0) {
    au9999Price = allContracts['Au100g'].latest;
  }

  if (au9999Price && au9999Price > 100 && au9999Price < 5000) {
    return parseFloat(au9999Price.toFixed(2));
  }

  throw new Error('上金所延时行情页面未解析到有效金价');
}

// ===== 数据源2: 上金所首页 上海金基准价 =====
// 抓取首页的上海金早盘价/午盘价
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

  // 从首页提取上海金基准价
  // 首页展示了: 上海金 早盘价 xxx.xx 午盘价 xxx.xx
  const amMatch = html.match(/早盘价[^]*?(\d{3,4}\.\d{1,2})/);
  const pmMatch = html.match(/午盘价[^]*?(\d{3,4}\.\d{1,2})/);

  if (amMatch) shanghaiGoldBenchmark.am = parseFloat(amMatch[1]);
  if (pmMatch) shanghaiGoldBenchmark.pm = parseFloat(pmMatch[1]);

  // 优先用午盘价（更新），其次早盘价
  const benchmarkPrice = shanghaiGoldBenchmark.pm || shanghaiGoldBenchmark.am;

  if (benchmarkPrice && benchmarkPrice > 100 && benchmarkPrice < 5000) {
    console.log(`  📊 上海金基准价 - 早盘: ${shanghaiGoldBenchmark.am || '--'}, 午盘: ${shanghaiGoldBenchmark.pm || '--'}`);
    return parseFloat(benchmarkPrice.toFixed(2));
  }

  throw new Error('上金所首页未找到上海金基准价');
}

// ===== 数据源3: 东方财富 - 沪金主力期货 =====
async function fetchFromEastMoneyFutures() {
  const contracts = ['au2506', 'au2508', 'au2512'];
  for (const contract of contracts) {
    try {
      const secid = `113.${contract}`;
      const response = await fetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f170&ut=fa5fd1943c7b386f172d6893dbbd1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://quote.eastmoney.com/'
        },
        signal: AbortSignal.timeout(5000)
      });
      const data = await response.json();
      if (data.data && data.data.f43) {
        const price = data.data.f43 / 100;
        if (price > 100 && price < 5000) {
          return parseFloat(price.toFixed(2));
        }
      }
    } catch (e) {
      continue;
    }
  }
  throw new Error('东方财富期货 API 失败');
}

// ==================== 价格更新逻辑 ====================
async function updateGoldPrice() {
  try {
    previousPrice = currentGoldPrice;
    const newPrice = await fetchGoldPrice();

    if (newPrice) {
      currentGoldPrice = newPrice;

      const now = new Date();
      const record = {
        price: newPrice,
        timestamp: now.toISOString(),
        time: now.toLocaleTimeString('zh-CN', { hour12: false }),
        change: previousPrice ? parseFloat((newPrice - previousPrice).toFixed(2)) : 0,
        changePercent: previousPrice
          ? parseFloat(((newPrice - previousPrice) / previousPrice * 100).toFixed(4))
          : 0
      };

      priceHistory.push(record);
      // 只保留最近 500 条记录
      if (priceHistory.length > 500) {
        priceHistory = priceHistory.slice(-500);
      }

      console.log(`💰 上金所金价: ¥${newPrice}/克 | 变动: ${record.change >= 0 ? '+' : ''}${record.change} (${record.changePercent}%) | 数据源: ${lastDataSource}`);

      // 检查是否触发告警
      checkAlerts(newPrice, record);
    }
  } catch (error) {
    console.error('❌ 金价更新失败:', error.message);
  }
}

// ==================== 告警检查 ====================
function checkAlerts(price, record) {
  subscriptions.forEach((sub, id) => {
    const settings = alertSettings.get(id) || {};

    let shouldNotify = false;
    let notifyTitle = '💰 金价监控';
    let notifyBody = '';

    // 1. 定时推送（每次更新都推送）
    if (settings.alwaysNotify) {
      shouldNotify = true;
      const arrow = record.change >= 0 ? '📈' : '📉';
      notifyBody = `${arrow} Au99.99: ¥${price}/克\n变动: ${record.change >= 0 ? '+' : ''}¥${record.change} (${record.changePercent}%)`;
    }

    // 2. 价格上限告警
    if (settings.upperLimit && price >= settings.upperLimit) {
      shouldNotify = true;
      notifyTitle = '🚨 金价上限告警';
      notifyBody = `Au99.99 已达 ¥${price}/克，超过设定上限 ¥${settings.upperLimit}！`;
    }

    // 3. 价格下限告警
    if (settings.lowerLimit && price <= settings.lowerLimit) {
      shouldNotify = true;
      notifyTitle = '🚨 金价下限告警';
      notifyBody = `Au99.99 已降至 ¥${price}/克，低于设定下限 ¥${settings.lowerLimit}！`;
    }

    // 4. 波动幅度告警
    if (settings.changeThreshold && Math.abs(record.changePercent) >= settings.changeThreshold) {
      shouldNotify = true;
      notifyTitle = '⚠️ 金价剧烈波动';
      notifyBody = `Au99.99 波动 ${record.changePercent}%，当前 ¥${price}/克`;
    }

    if (shouldNotify && notifyBody) {
      sendPushNotification(sub, notifyTitle, notifyBody, price);
    }
  });
}

// ==================== 推送通知 ====================
async function sendPushNotification(subscription, title, body, price, options = {}) {
  const payload = JSON.stringify({
    title,
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: {
      price,
      timestamp: new Date().toISOString(),
      url: '/'
    },
    persistent: options.persistent || false,  // 常驻通知标记
    tag: options.persistent ? 'gold-persistent' : 'gold-price',
    actions: options.persistent
      ? [{ action: 'view', title: '📊 查看详情' }]
      : [
          { action: 'view', title: '查看详情' },
          { action: 'dismiss', title: '忽略' }
        ],
    vibrate: options.persistent ? [] : [200, 100, 200],
    renotify: options.persistent ? false : true
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

// ==================== 常驻通知定时更新 ====================
function startPersistentNotifications() {
  // 每 30 秒更新一次常驻通知
  setInterval(() => {
    if (!currentGoldPrice) return;

    const lastRecord = priceHistory[priceHistory.length - 1];
    const au9999 = sgeMarketData['Au99.99'] || {};
    const change = lastRecord?.change || 0;
    const changePct = lastRecord?.changePercent || 0;
    const arrow = change >= 0 ? '▲' : '▼';
    const sign = change >= 0 ? '+' : '';
    const high = au9999.high || currentGoldPrice;
    const low = au9999.low || currentGoldPrice;
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });

    subscriptions.forEach((sub, id) => {
      const settings = alertSettings.get(id) || {};
      if (settings.persistentNotify) {
        const title = `📊 Au99.99: ¥${currentGoldPrice}  ${arrow}${sign}${change.toFixed(2)}`;
        const body = `涨跌: ${sign}${changePct.toFixed(3)}%\n最高 ¥${high} | 最低 ¥${low}\n⏱ ${now} · ${lastDataSource}`;
        sendPushNotification(sub, title, body, currentGoldPrice, { persistent: true });
      }
    });
  }, 30 * 1000);
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

// 更新告警设置
app.post('/api/settings', (req, res) => {
  const { subscriptionId, settings, subscription } = req.body;
  if (subscriptionId) {
    alertSettings.set(subscriptionId, settings);

    // 如果同时传了 subscription 对象，也更新订阅（防止重启丢失）
    if (subscription) {
      subscriptions.set(subscriptionId, subscription);
    }

    // 如果开启了常驻通知，立刻发送一条，让用户马上看到效果
    if (settings.persistentNotify && currentGoldPrice) {
      const sub = subscriptions.get(subscriptionId);
      if (sub) {
        const lastRecord = priceHistory[priceHistory.length - 1];
        const au9999 = sgeMarketData['Au99.99'] || {};
        const change = lastRecord?.change || 0;
        const changePct = lastRecord?.changePercent || 0;
        const arrow = change >= 0 ? '▲' : '▼';
        const sign = change >= 0 ? '+' : '';
        const high = au9999.high || currentGoldPrice;
        const low = au9999.low || currentGoldPrice;
        const now = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });

        const title = `📊 Au99.99: ¥${currentGoldPrice}  ${arrow}${sign}${change.toFixed(2)}`;
        const body = `涨跌: ${sign}${changePct.toFixed(3)}%\n最高 ¥${high} | 最低 ¥${low}\n⏱ ${now} · ${lastDataSource}`;
        sendPushNotification(sub, title, body, currentGoldPrice, { persistent: true });
        console.log(`📌 已发送常驻通知给 ${subscriptionId}`);
      }
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
    sendPushNotification(
      sub,
      '🔔 测试通知',
      `金价监控运行中！Au99.99: ¥${currentGoldPrice || '获取中...'}/克 | 数据源: ${lastDataSource}`,
      currentGoldPrice
    );
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
    res.write(`data: ${JSON.stringify({
      price: currentGoldPrice,
      previousPrice,
      timestamp: new Date().toISOString(),
      source: lastDataSource,
      sgeMarket: sgeMarketData,
      benchmark: shanghaiGoldBenchmark
    })}\n\n`);
  }

  // 每10秒推送一次
  const intervalId = setInterval(async () => {
    await updateGoldPrice();
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
  }, 10000);

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
  });

  // 启动常驻通知定时更新
  startPersistentNotifications();

  // 生产环境开启防休眠
  if (isProduction) {
    keepAlive();
  }
});
