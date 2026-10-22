# 架构与实现

> 面向想改代码的人，也面向想看工程能力的面试官。
> 六张可交互的架构图在 **[在线图集](https://black-mouse-sha.github.io/12306-ticket-assistant-pro/)**，
> 图里每个节点都标了源码行号，和仓库里的 `12306-ticket-assistant-pro.user.js` 逐行对应。

## 1. 一眼看懂

```text
┌────────────────────────── 浏览器页面世界（@match www / kyfw）──────────────────────────┐
│                                                                                        │
│   12306 页面 DOM                                    用户脚本（单个 IIFE）                 │
│   ├─ 车次 / 余票 / 订单页                            ├─ UIModule        三步面板、选座、报警 │
│   ├─ CLeftTicketUrl（查询接口地址）                  ├─ Main            读表单、建方案、调度 │
│   └─ 页面变量 lc_search_url                          ├─ NetworkModule   接口封装、登录态     │
│                                                      ├─ TicketLogicModule 解析、可下单判定   │
│                                                      └─ OrderLogicModule  下单 5 步严格串行  │
│                                                                                        │
│                                          请求通道 httpFetch ──┬─ 同源 → fetch            │
│                                                               └─ 跨域 → GM_xmlhttpRequest│
└────────────────────────────────────────────────────────────────┼───────────────────────┘
                                                                 │
┌──────────────────────── 油猴扩展世界（@grant 沙箱）─────────────┼───────────────────────┐
│  GM_xmlhttpRequest · unsafeWindow · GM_getValue / GM_setValue   │                       │
│  落盘：grab_config_pro_v3 · grab_plan_state · grab_relay_state │                       │
│        grab_last_order · grab_log_persist · query_url_pool ... │                       │
└────────────────────────────────────────────────────────────────┼───────────────────────┘
                                                                 ▼
                                          12306 服务端（kyfw.12306.cn）
                                          查票 / 经停 / 票价 / 下单 / 候补
```

## 2. 模块与代码位置

| 模块 | 职责 | 代码位置 |
|---|---|---|
| 日志 / 落盘 | 面板日志 + 技术日志，跨页面恢复，TTL 2h | `L43` 起 |
| 接力状态 | 中转半程票状态，TTL 8h，刷新后可恢复 | `L125` 起 |
| `NetworkModule` | 所有 12306 接口封装、登录态检查、请求超时 | `L783` 起 |
| `TicketLogicModule` | 余票字符串解析、席别映射、经停站、票价、可下单判定 | `L1013` 起 |
| `OrderLogicModule` | 提交订单、下单页参数提取、check / queue / confirm | `L1318` 起 |
| `UIModule` | 三步面板、日历、乘车人、方案列表、座位图、报警、通知 | `L1495` 起 |
| `Main` | 方案构建、轮询档位、调度、三路唤醒、开始 / 停止 | `L3442` 起 |
| 初始化 | 拉站名表、挂面板、检查登录 / 未完成订单 / 接力 | `L4639` 起 |

## 3. 请求通道：为什么不会「一直查询」

12306 的接口都在 `kyfw.12306.cn`。人在 `www.12306.cn` 时就是跨域，而 12306 的边缘节点对 `OPTIONS` 预检经常不回应——`fetch` 既不会成功也不会报错，表现就是一直转圈。

`httpFetch(target, init, timeoutMs)` 的处理：

1. **同源**（`hostOf(target) === location.host`）→ 走页面 `fetch`；
2. **跨域** → 直接走 `GM_xmlhttpRequest`，由油猴在扩展后台发请求，没有预检；
3. 两条路都套一个**硬看门狗**：`timeoutMs + 3000` 还没回来就主动 reject，避免无限挂起；
4. 所有请求带 `Referer`，并拒绝手工覆盖 `Host` / `Origin` / `Cookie` / `Content-Length`。

查票接口地址不是写死的：从页面变量 `CLeftTicketUrl` 学，失败时用 `/otn/leftTicket/query` 探测，成功后把可用地址记进 `query_url_pool`，下次优先复用并轮换。

## 4. 时间与节奏

| 机制 | 实现 |
|---|---|
| 服务器时钟 | 从响应头 `Date` 采样，按请求往返中点估算偏移；超过 12h 的异常样本丢弃 |
| 起售时刻 | 起售时间按「乘车站」算；中转两段各生成一个 `salePoint`，分别开火 |
| 轮询档位 | `far 20-30s` → `probe 12-20s` → `idle 1-1.5s` → `warmup 0.5-0.8s` → `hot 0.25-0.4s` |
| 三路唤醒 | ① 长 `setTimeout` 直接定到开火点；② 1s 心跳测漂移、补枪；③ 音频报警线程不受后台定时器限流影响 |
| 失败退避 | 12306 拒绝 / 超时 → 降速；登录失效、有未完成订单 → 直接停止并报警 |

## 5. 下单 5 步

| 步骤 | 接口 | 关键点 |
|---|---|---|
| 1 | `POST /otn/leftTicket/submitOrderRequest` | `secretStr` 来自查票结果；从 `www` 域发会被拒 |
| 2 | `GET /otn/confirmPassenger/initDc` | 从返回 HTML 里提取 `globalRepeatSubmitToken`、`key_check_isChange`、`leftTicketStr` |
| 3 | `POST /otn/confirmPassenger/checkOrderInfo` | 校验乘客 / 席别 / 票种；学生票走 `purpose_codes=0X00` |
| 4 | `POST /otn/confirmPassenger/getQueueCount` | 查排队人数；无座票会做席别码置换 |
| 5 | `POST /otn/confirmPassenger/confirmSingleForQueue` | 确认排队；成功后跳 `/otn/queryOrder/initNoComplete` 提醒付款 |

每一步都是严格串行，任一步失败就回到轮询；下单阶段**不再查价**，避免浪费限流额度。

## 6. 中转接力

```text
第 1 段有票 → 真下单 → 落盘 grab_relay_state（含两段信息、订单号、TTL 8h）
                          ↓
                    提示先付款，同时继续盯第 2 段
                          ↓
第 2 段有票 → 下单 → 清接力状态 → 全停
```

刷新 / 跳转 / 重新打开页面时，`readRelayState()` 会把半程票捡回来，面板直接进第 ③ 步。两段是同一趟车（同车换乘）时，等待时间会自动放宽。

## 7. 状态与存储

| Key | 内容 | 语义 |
|---|---|---|
| `grab_config_pro_v3` | 条件配置 | **对象**（油猴存储是 JSON 值语义） |
| `grab_plan_state` | 方案勾选 / 删除 / 顺序 | JSON 字符串 |
| `grab_relay_state` | 中转半程票 | JSON 字符串，TTL 8h |
| `grab_last_order` | 抢到的订单提醒 | JSON 字符串，TTL 6h |
| `grab_log_persist` | 面板 / 技术日志镜像 | JSON 字符串，TTL 2h |
| `query_url_pool` | 查票接口候选池 | 多行字符串 |
| `lc_search_url` | 联程查询路径提示 | 字符串 |
| `grab_running` | 是否正在抢 | JSON 字符串 |
| `grab_last_stop_at` | 上次停止时刻 | 数字 |

这 9 个键是安卓 WebView 兼容层的完整契约：存对象得对象、存字符串得字符串、没存过原样返回默认值（见 [ANDROID-PLAN.md](ANDROID-PLAN.md)）。

## 8. 已知设计取舍

- **删掉联程链路**：`lcQuery` / `lcConfirmPassenger` 要求参数与 12306 自己的 JS 逐字对齐，改版即整条失效；它想解决的问题已被「两段接力」覆盖大半。
- **不做支付自动化**：12306 没有开放支付接口，只做提醒和跳转，付款必须人工完成。
- **票价查询有预算**：一趟车一次请求，最多 12 次，连续失败 3 次整体停止；抢票阶段不再查价。
- **不猜商务座座位**：不同车型座位字母不同，猜错会导致整单非法参数，交给系统分配。

## 9. 验证与留痕

- 2026-10-17：在 `kyfw.12306.cn/otn/view/index.html` 下出真实订单（订单号已打码）。
- 2026-10-19：预约 11-02 杭州 → 深圳 D3123，开售 5 分钟售罄后抢票成功（截图见 README）。
- 六张图由 Archify 3.2.0 渲染，均通过 validate / deliver / browser-check 检查；图中节点标注的源码行号与 v3.3.5 脚本逐行对应。
- 本文与 README、USAGE、CHANGELOG 一起构成这个项目的「可维护性证据」：不只看功能，也看边界、失败路径和取舍。
