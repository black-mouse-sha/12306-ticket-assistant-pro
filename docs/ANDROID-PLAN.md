# 12306 抢票助手 Pro → 安卓 App 改造方案（v1，待确认）

> **状态：设计稿，尚未实现。** 这里记录的是把同一份引擎搬进 Android WebView 的拆分方式、
> 宿主契约和踩坑点，用来展示技术方案，不是已发布的产品。
>
> 目标：手机装上就能用、不用油猴、打开就在 12306 页面上自动出现面板，
> 并且把"挂预约到点抢 / 开售秒抢 / 捡漏等退票"三种场景都做得比浏览器版更可靠。
>
> 现状：`12306-ticket-assistant-pro.user.js` 单文件约 4700 行，纯原生 JS，逻辑与网络请求已经自洽；
> 唯一的外部依赖是油猴提供的 4 个接口 + 注入时机。

---

## 0. 结论与边界

| 项 | 结论 |
|---|---|
| 引擎（4684 行逻辑） | **不改**，只加一层兼容层（约 60 行）+ 3 个只读钩子（约 10 行） |
| 壳（安卓） | 新增，约 700~900 行 Kotlin |
| 油猴 | 不需要。同一份引擎，两种宿主：油猴 / App |
| 覆盖场景 | 开售秒抢 ✅（原生闹钟）／挂预约 ✅（前台服务常驻）／捡漏 ✅（长轮询 + 通知） |
| 平台 | 仅安卓，自签侧载（不上架） |
| 备注 | 引擎保持单文件，App 升级只需换一个 js，壳可以几年不动 |

---

## 1. 依赖清单：脚本 ↔ 宿主 的完整契约

### 1.1 存储（9 个键，全部由兼容层接管）

| 键 | 内容 | 语义 | 脚本里的位置 |
|---|---|---|---|
| `grab_config_pro_v3` | 全部条件配置（**对象**） | 读回必须是对象 | L665/696/704 |
| `grab_plan_state` | 方案勾选/删除/顺序 | JSON **字符串** | L709/712/723 |
| `grab_relay_state` | 中转接力状态（手上那张半程票） | JSON 字符串 | L125/128/133/141 |
| `grab_last_order` | 抢到的订单，用于跨页提醒付款 | JSON 字符串 | L96/99/104/112 |
| `grab_log_persist` | 面板日志镜像（刷新后捡回来） | JSON 字符串 | L48/57/70 |
| `query_url_pool` | 查票接口候选池 | 多行字符串 | L281/291/304 |
| `lc_search_url` | 联程查询路径提示 | 字符串 | L992/1002/1003 |
| `grab_running` | 是否正在抢（防重复开火） | JSON 字符串 | L4597/4456 |
| `grab_last_stop_at` | 上次停止时刻（**数字**） | 数字 | L3472/4458 |

> ⚠️ **关键坑**：`GM_getValue(CONFIG_KEY, null)` 读出来的**必须直接是对象**
> （油猴的存储是 JSON 值语义，不是字符串语义），而其他 8 个键写进去的是
> `JSON.stringify(...)` 的**字符串**。所以兼容层必须做 **JSON 整体往返**，
> 不能天真地 `localStorage.getItem`：
>
> ```js
> set(k, v) → localStorage[k] = JSON.stringify(v)      // 字符串会被再包一层引号
> get(k, d) → d === undefined ? d : JSON.parse(localStorage[k])
> ```
>
> 这样 9 个键**全部**行为一致：存对象得对象，存字符串得字符串，没存过则原样返回默认值
> （`null` / `0` / `''` 三种默认值都不能被吞掉）。

### 1.2 其余接口

| 接口 | 真实用处 | 替代 |
|---|---|---|
| `GM_xmlhttpRequest` | 仅 2 处真正调用：`gmRequest`（L181）、环境自检（L4647）。**只在跨域时用** | 原生 OkHttp；书签版用 `fetch(credentials:'include')` |
| `unsafeWindow` | 2 处，读 12306 页面变量 `CLeftTicketUrl` / `lc_search_url` | 注入在页面主世界 → `window` 就是它；不注入也能兜底 |
| `GM_notification` | **声明了但代码里没用**（实际用的是原生 `Notification`） | 删掉这个 `@grant`；App 里换成原生通知 |
| `@match` | 注入时机 | 壳的 `onPageFinished` 负责 |

### 1.3 引擎需要动的 3 处（全部是"加"，不是"改"）

1. **顶部拼兼容层**：`build.ps1` 把 `shim.js` 拼在 `.user.js` 前面，油猴版不拼。
2. **三个钩子**（原生闹钟要能叫醒它）：
   ```js
   window.__TH_TICK__   = runRound;                      // 原生闹钟到点，强制跑一轮
   window.__TH_STATE__  = () => ({ running: stateRunning, next: nextFireAtMs });
   window.__TH_SOON__   = () => salePoints.map(p => p.atMs);   // 供原生排精确闹钟
   ```
3. **`www.12306.cn` 的拒绝逻辑**：App 里根本不会停在那，留着无害，不动。

---

## 2. 兼容层代码草案（`shim.js`，约 60 行）

```js
// 油猴环境直接 return；App / 书签 / 控制台三种环境共用同一份
(function () {
  'use strict';
  if (typeof window.GM_setValue === 'function') return;

  const B = window.__THI_NATIVE__ || null;   // 原生桥（App 里有，书签版为 null）
  const mem = Object.create(null);

  // ---------- 1. 存储：JSON 值语义 ----------
  const LS = {
    get(k) { try { return localStorage.getItem('th:' + k); } catch (e) { return null; } },
    set(k, s) { try { localStorage.setItem('th:' + k, s); } catch (e) {} },
    del(k) { try { localStorage.removeItem('th:' + k); } catch (e) {} }
  };
  if (B && B.storageDump) {
    try { Object.assign(mem, JSON.parse(B.storageDump() || '{}')); } catch (e) {}
  }
  window.GM_getValue = function (k, d) {
    let raw = (k in mem) ? mem[k] : (B ? null : LS.get(k));
    if (raw === null || raw === undefined) return d;
    try { const v = JSON.parse(raw); return (v === undefined || v === null) ? d : v; }
    catch (e) { return raw; }        // 老版本写进去的裸字符串，原样给
  };
  window.GM_setValue = function (k, v) {
    const s = JSON.stringify(v === undefined ? null : v);
    mem[k] = s;
    if (B && B.storageSet) { try { B.storageSet(k, s); return; } catch (e) {} }
    LS.set(k, s);
  };
  window.GM_deleteValue = function (k) {
    delete mem[k];
    if (B && B.storageSet) { try { B.storageSet(k, ''); return; } catch (e) {} }
    LS.del(k);
  };

  // ---------- 2. 跨域请求：原生优先，fetch 兜底 ----------
  let seq = 0; const pending = new Map();
  window.__TH_HTTP_CB = function (id, r) {
    const job = pending.get(id); if (!job) return;
    pending.delete(id);
    if (r && r.error) return job.fail(r.error);
    job.ok({ status: r.status | 0, responseHeaders: r.headers || '', responseText: r.text || '' });
  };
  window.GM_xmlhttpRequest = function (opt) {
    const id = ++seq;
    pending.set(id, {
      ok: r => { try { opt.onload && opt.onload(r); } catch (e) {} },
      fail: () => { try { (opt.onerror || opt.ontimeout || function () {})(); } catch (e) {} }
    });
    if (B && B.httpRequest) { try { B.httpRequest(id, JSON.stringify(opt)); return; } catch (e) {} }
    fetch(opt.url, {
      method: opt.method || 'GET', headers: opt.headers || {}, body: opt.data,
      credentials: 'include', redirect: 'follow'
    }).then(async res => window.__TH_HTTP_CB(id, { status: res.status, text: await res.text() }))
      .catch(err => window.__TH_HTTP_CB(id, { error: String(err && err.message || err) }));
  };

  // ---------- 3. 页面变量 ----------
  if (typeof window.unsafeWindow === 'undefined') window.unsafeWindow = window;

  // ---------- 4. 报警：WebView 里没有 Notification ----------
  if (B && B.notify && typeof window.Notification === 'undefined') {
    window.Notification = function (t, o) { B.notify(t, (o && o.body) || ''); };
    window.Notification.permission = 'granted';
    window.Notification.requestPermission = () => Promise.resolve('granted');
  }
})();
```

> 这 60 行同时服务三个形态：**油猴（不加载）／书签（fetch 兜底）／App（原生桥）**。

---

## 3. 原生桥 IPC 规格

| 方向 | 名称 | 签名 | 说明 |
|---|---|---|---|
| JS→Kotlin | `storageDump()` | `String`（同步） | 注入时一次性把全部键读进 JS 内存镜像，保证 `GM_getValue` 同步 |
| JS→Kotlin | `storageSet(k, v)` | 同步返回 `void` | 写穿透到 SharedPreferences（异步落盘），不阻塞抢票 |
| JS→Kotlin | `httpRequest(id, optJson)` | 异步回调 `__TH_HTTP_CB(id, {...})` | OkHttp，自动注入 CookieManager 的 Cookie，可覆写 Referer |
| JS→Kotlin | `notify(title, body)` | `void` | NotificationManager，点按回 App |
| JS→Kotlin | `alarmAt(atMs, tag)` | `void` | `setExactAndAllowWhileIdle`；到点 → `evaluateJavascript('__TH_TICK__()')` |
| JS→Kotlin | `keepAwake(on)` | `void` | 启停前台服务 + `PARTIAL_WAKE_LOCK` |
| Kotlin→JS | `__TH_TICK__()` | — | 原生闹钟触发；内部只调一次 `runRound()`，不新写逻辑 |
| Kotlin→JS | `__TH_STATE__()` | JSON | 前台服务通知栏文案（"下一场 14:30 · 还有 42 分钟"） |

安全：桥对象只在 `kyfw.12306.cn` 页面注入；`onPageFinished` 里校验 `view.url` 的 host，不符就 `removeJavascriptInterface` 并跳过注入。

---

## 4. 工程结构

```
12306-helper/
├─ core/12306抢票助手Pro.user.js     ← 现有引擎（桌面端继续用油猴版）
├─ build/
│  ├─ shim.js                        ← 上面那 60 行
│  └─ build.ps1                      ← shim + core → app/assets/engine.js
└─ app-android/
   ├─ app/src/main/
   │  ├─ java/.../MainActivity.kt    ← WebView + CookieManager + 注入
   │  ├─ java/.../NativeBridge.kt    ← @JavascriptInterface 全部方法
   │  ├─ java/.../GrabService.kt     ← 前台服务 + 唤醒锁 + 常驻通知
   │  ├─ java/.../AlarmReceiver.kt   ← 精确闹钟 → 拉起 WebView → __TH_TICK__
   │  ├─ assets/engine.js            ← build.ps1 生成
   │  └─ res/                        ← 图标/主题/通知渠道
   └─ build.gradle.kts
```

## 5. 启动 / 注入时序

```
App 启动
 └─ MainActivity: settings(UA=桌面版去掉 "; wv", JS=on, DOM storage=on,
                            useWideViewPort, loadWithOverviewMode)
     CookieManager.setAcceptThirdPartyCookies(true)
     WebView.loadUrl("https://kyfw.12306.cn/otn/leftTicket/init")
      └─ onPageFinished
          ├─ host 校验（必须 kyfw.12306.cn）
          ├─ addJavascriptInterface(NativeBridge, "__THI_NATIVE__")
          ├─ evaluateJavascript(engine.js)      ← shim 已拼在前面
          └─ 引擎自带 setTimeout(1000) 后挂面板（无需额外 ready 处理）
```

> 注：引擎在 L4642 自己 `setTimeout(1000)` 后 `UIModule.init`，并且先 `fetchStationMap(3)`。
> 所以注入不必等 DOM 完全就绪，`onPageFinished` 足够早。

## 6. 开售那一秒的时序（为什么 App 比浏览器准）

```
T-10min   用户点「开始抢票」→ JS 把各个 salePoints 报给原生：alarmAt(each)
T-5min    原生报警（声音走 Notification + 前台服务，锁屏也响）
T-60s     闹钟 #1 → 唤醒屏幕 + 强 CPU → 拉起 WebView 探一次查票接口（预热连接）
T-0.8s    闹钟 #2 → __TH_TICK__() 立刻跑一轮
T-0       引擎照旧按 salePoints 连发下单（逻辑没变）
          成功 → 原生通知 + 震动 + 跳支付页（引擎原有 postRedirect）
```

浏览器版做不到的：标签页在后台 5 分钟就被压到"每分钟一次定时器"，电脑休眠就彻底不动。
App 里闹钟由 `AlarmManager` 负责、CPU 由前台服务锁着，**定时不依赖 JS 定时器**。

## 7. 面板的三处手机适配（最小改动）

| 问题 | 现状 | 改法 |
|---|---|---|
| 宽度写死 | `width:378px; top:50px; right:20px`（L1506） | 加 `@media (max-width:480px)`：`width:100vw; inset:0; height:100dvh; border-radius:0` |
| 拖动 | `mousedown`（L3045） | 换 `pointerdown` + `touch-action:none`；手机上改成上滑手柄 + 下拉关闭 |
| 触控太小 | `.th-del` 22px（L1703） | `@media (pointer:coarse)` 放大到 32px；日志区 `max-height:40dvh` |
| 底部按钮 | 无安全区处理 | `padding-bottom:calc(10px + env(safe-area-inset-bottom))` |

## 8. 三场景保障矩阵

| 场景 | 靠什么保证 | 引擎现有逻辑是否够 |
|---|---|---|
| 开售秒抢 | 原生精确闹钟 + 前台服务 + 预热 | 够，只换定时源 |
| 挂预约（预售期外） | 前台服务常驻 + 中断后自动重注入恢复 | 够（`grab_running` + 落盘） |
| 捡漏/等退票 | 长轮询（引擎已有退避）+ 原生通知提醒 | 够；后台定时器可能变慢 → 原生每 60s 兜底 tick |

## 9. 构建（需要一个 SDK）

```powershell
# 一次性
winget install EclipseAdoptium.Temurin.17.JDK   # 已有 java，核对版本 ≥17
# 下载 commandline-tools → sdkmanager 装 platform-34 + build-tools-34（约 1.2G）
# 产物
cd app-android ; .\gradlew.bat assembleDebug      # app-debug.apk，自签即可装
```

版本策略：`versionCode`（App）与 `SCRIPT_VERSION`（引擎）解耦，面板「关于」两个都显示。
升级引擎 = 替换 `assets/engine.js` 重新打包；或做成从 GitHub Raw 拉 `engine.js`
（拉不到回退 assets），这样改一次脚本不用重装 App。

## 10. 验收清单（不花钱、不下单）

- [ ] 面板出现、三步可切、站名表加载成功（`fetchStationMap`）
- [ ] 点「下一步」能列出真实车次（证明同源 fetch 通）
- [ ] 挑一趟没票的车跑「捡漏」，观察轮询 + 退避 + 「12306 没接这次请求」
- [ ] 设 60 秒后开火 → **锁屏** → 观察 `__TH_TICK__` 是否准点（toast + 日志时间戳）
- [ ] 杀进程/清后台 5 分钟后重开，接力状态、日志、配置都还在
- [ ] 飞行模式：报错不崩、恢复后能继续
- [ ] 登录态过期：提示明确、可一键重登
- [ ] 真下单：只在开售日做，且第一张用便宜短途票验证

## 11. 里程碑（每个都能单独验证）

| # | 内容 | 验收 | 估时 |
|---|---|---|---|
| D0 | 环境 + 空壳 WebView 打开 kyfw 并注入 `document.title=...` | 手机屏幕标题变了 | 0.5d（含下载） |
| D1 | shim + 注入全引擎 | 面板出现在手机上 | 0.5d |
| D2 | storage/http 桥通 | 能登录、能点「下一步」查出车次 | 1d |
| D3 | UI 手机适配 | 竖屏可用、能拖动、能滚动 | 0.5d |
| D4 | 前台服务 + 闹钟 + 通知 | 锁屏准点触发 | 0.5d |
| D5 | 三场景演练 | 捡漏/预约/开售模拟全过 | 0.5d |
| D6 | 打包签名 + 安装引导 | 干净手机装上能用 | 0.5d |

## 12. 风险

| 风险 | 说明 | 反制 |
|---|---|---|
| 12306 服务条款禁止自动化代购 | 风控表现：验证码变严、候补受限、异常订单取消 | 自用单账号、别并发多开；接受即可 |
| WebView 被识别 | 12306 可能校验 UA / 指纹 | 桌面 UA 去掉 `; wv`，禁用 `WebView` 特有标记；不行再试 GeckoView |
| 国产 ROM 杀后台 | 3 大厂尤甚 | 引导加电池白名单 + 自启动；前台服务常驻通知 |
| 接口改版 | 引擎会失效 | 引擎热更新（换 js / 远程拉） |
| 不能替你付款 | 12306 无支付接口 | 保留通知 + 跳支付页；配合 12306 免密支付 |
| 无法上架应用商店 | 合规 | 只侧载，不做分发 |

## 13. 已确认的决定

| 决定 | 结论 |
|---|---|
| 捡漏时是否亮屏 | **省电优先**：捡漏期间不常亮屏，发现余票才亮屏 + 震动 + 通知 |
| 引擎热更新 | **要**：从网络拉 `engine.js`，拉不到回退内置版本 |

### 13.1 捡漏模式的具体做法（省电分支）

- 屏不常亮，CPU 靠前台服务 + `PARTIAL_WAKE_LOCK`（只保 CPU，不点亮屏幕）。
- 轮询节奏沿用引擎自带的退避；**后台时每 60 秒由原生闹钟兜底 tick 一次**，
  避免 WebView 定时器被压。
- 命中（引擎日志出现"抓到票"）→ `notify()` + 震动 + 亮屏（`FLAG_KEEP_SCREEN_ON` 或
  `setTurnScreenOn(true)`），让用户能立刻上手付款。
- 到开售时刻（`salePoints`）自动切回"灵敏档"：提前 60s 预热 + 精确闹钟，抢完再回省电档。

### 13.2 热更新规格

```
启动 → 读 assets/engine.js（内置，永远可用）
     → 读上次缓存的 engine.js（filesDir，优先用）
     → 后台拉 https://<你的地址>/engine.js（超时 5s，失败静默跳过）
         ├─ 校验：首行注释里的 SCRIPT_VERSION 必须比本地大
         ├─ 落盘到 filesDir/engine.js，下次启动生效
         └─ 任何异常 → 继续用缓存/内置
```

要点：
- **永远三份兜底**（内存内置 → 磁盘缓存 → 网络），网络永远不是启动阻塞项。
- 只认 `.js` 文本，不执行任何原生代码；地址走 HTTPS，可换 CDN/仓库 Raw。
- 面板「关于」显示：App 版本 / 引擎版本 / 引擎来源（内置 or 热更 + 拉取时间）。
- 出问题一键「回滚到内置引擎」（清缓存）。
- 需要一个静态托管地址：GitHub Raw、Gitee Raw、或你自己的任意 HTTP 目录都行。

## 14. 还需要拍板的（都不阻塞开工）

1. App 名字 / 包名（默认：`抢票助手 Pro` / `com.littleperson.t12306pro`）
2. 开屏落在哪个页面：车票查询页（推荐）/ 个人中心
3. 是否要「导出/导入配置 JSON」（换手机方便，约 1 小时工作量）
4. 热更新的托管地址（GitHub 还是你自己的服务器）

---

设计稿整理：**LittlePerson** · 二次开发自 [辻弌20 的开源脚本](https://scriptcat.org/zh-CN/script-show-page/6106)（MIT License）
