# 💰 金价实时监控 (Gold Price Monitor)

一个支持手机通知栏推送的金价实时监控 PWA 应用。

## ✨ 功能特性

- 📊 **实时金价监控** - 每 10 秒更新一次国际金价 (XAU/USD)
- 📱 **手机通知栏推送** - 通过 Web Push 技术直接推送到手机通知栏
- 📈 **价格走势图** - 实时绘制金价走势曲线
- 🔔 **智能告警** - 支持价格上限/下限/波动幅度告警
- 📲 **PWA 支持** - 可安装到手机主屏幕，类原生应用体验
- 🌐 **离线可用** - Service Worker 缓存，断网也能查看历史数据

## 🚀 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 生成图标
```bash
node generate-icons.js
```

### 3. 启动服务
```bash
npm start
```

### 4. 访问应用
- 电脑: http://localhost:3000
- 手机: 同一局域网下访问 `http://你的电脑IP:3000`

## 📱 手机使用方法

### 方法一：浏览器直接访问
1. 手机和电脑连同一个 WiFi
2. 查看电脑 IP 地址 (终端输入 `ifconfig` 或 `ipconfig`)
3. 手机浏览器访问 `http://电脑IP:3000`
4. 点击 **"开启通知"** 按钮
5. 允许浏览器发送通知

### 方法二：安装为 APP（推荐）
1. 访问网页后，浏览器会提示 **"添加到主屏幕"**
2. 点击安装，应用会以独立窗口运行
3. 体验与原生 APP 相同

### 通知设置
- **实时推送**: 每次价格更新都推送到通知栏
- **价格上限**: 金价超过设定值时告警
- **价格下限**: 金价低于设定值时告警
- **波动告警**: 单次变动超过设定百分比时告警

## 🛠 技术栈

- **后端**: Node.js + Express
- **前端**: 原生 HTML/CSS/JS (无框架依赖)
- **推送**: Web Push API + VAPID
- **实时通信**: Server-Sent Events (SSE)
- **PWA**: Service Worker + Web App Manifest
- **图表**: Canvas 2D 自绘

## 📡 金价数据源

应用会依次尝试以下数据源:
1. Metal Price API
2. Gold API  
3. 模拟数据 (基于市场波动模型)

> 如需使用真实 API，请替换 `server.js` 中的 API Key

## ⚠️ 注意事项

- Web Push 通知需要 **HTTPS** 环境（localhost 除外）
- iOS Safari 从 16.4+ 开始支持 Web Push
- 建议使用 Chrome / Edge / Firefox 浏览器
- 如需公网访问，可使用 ngrok 等内网穿透工具
