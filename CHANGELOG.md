# 更新记录

版本号唯一来源是根目录 `version.json`，构建脚本会自动同步到
Gradle / Java / 网页 / Service Worker 缓存名（`app/sw.js` 的 `CACHE`）几处。

本项目公开发布保留三个版本号。内部迭代号（1.2.17、1.2.23 …）不再作为独立版本发布，
但下面的内容按**改动主题**重新组织，方便查「某个功能是哪一版加进来的」。

**内部迭代号与公开发布版本的关系**（按时间先后，不要被数字大小误导）：

| 阶段 | 内部迭代号 | 公开发布版本 |
|---|---|---|
| 1.0.0 之前的内部测试版 | 1.0.0 ~ 1.3.5 | **1.0.0** |
| 1.0.0 之后的内部测试版 | 1.2.16 ~ 1.2.30 | **1.1.0** |
| 1.1.0 之后的内部测试版 | 1.2.31 ~ | **1.2.0** |

也就是说：**1.0.0 之前**的内部测试全部归入公开发布的 1.0.0，**1.0.0 之后**的内部测试
依次归入 1.1.0、1.2.0。内部迭代号是历史遗留，编号不单调（1.3.x 出现在 1.2.16 之前），
不要拿它跟公开发布版本比大小。

---

## 1.2.1 — 第四个版本

### 一、首页改为「每日推荐 / 推荐歌单 / 排行榜」

原来的第二块是「排行榜」、第三块是「最近播放」。现在换成：

| 位置 | 原来 | 现在 |
|---|---|---|
| 01 | 每日推荐 | 每日推荐（不变） |
| 02 | 排行榜 | **推荐歌单** |
| 03 | 最近播放 | **排行榜** |

- **推荐歌单**走 `personalized` 接口（`Netease.personalizedPlaylists(10)`），
  和排行榜各自独立缓存 —— 以前是"榜单为空才回落推荐歌单"，
  两个接口互相影响，榜单挂了下面就没内容。现在分开取、分开失败。
- 推荐歌单右侧的「更多」在**首页内展开成 2 列网格**（不跳页），
  再点收起。展开时把横滑那一排隐藏，避免同一批内容出现两次；
  按钮文案跟着变成「收起」，并带 `aria-expanded` 状态。
- 移除了「最近播放」区块（含 `#gridView` / `#listView`）。
  **但保留了渲染代码并加了判空** —— 旧缓存页面（SW 可能还在供旧 HTML）
  里这两个容器还存在，直接 `.innerHTML` 会抛错并打断整个 `renderHome`。

### 二、新增「软件内通知」开关（默认关闭）

设置 → 通知，第一项：

- **默认关闭**。关掉后顶部弹出的 toast 不再出现。
- 拦截点放在 `toast()` **函数入口**，而不是去改 106 个调用点 ——
  后者必然漏，以后新加通知又会忘。
- **两个例外不受影响**：
  - `warn`（失败/异常）类仍显示。「登录未完成」「这首歌放不了」这类
    如果也被吞掉，用户只会觉得"点了没反应"，反而更糟。
    关通知的意图是"别打扰我"，不是"出错了也别告诉我"。
  - 底部 `toastBottom`（"再按一次返回退出"等操作确认）走另一套通道，
    压根不经过这个开关。
- 原生系统通知由「通知不打断播放」(`notifyQuiet`) 单独控制，两者互不干扰。

### 三、迷你播放器补上液态玻璃的反射层

迷你播放器（`.dock-inner`）本来就在液态玻璃名单里，`backdrop-filter`
和上方通知**完全一致**（`blur + saturate + brightness + url(#lg-warp)`）。
但观感上明显更"平"，根因是：

- 上方通知没有 `overflow:hidden`，而 `.dock-inner` **有**
  （用来裁住里面那条 2px 进度条和圆角）
- 反射高光层是 `z-index:-1` 的 `::before`，**负 z-index 的伪元素会被
  父级的 `overflow:hidden` 一起裁掉** —— 高光压根画不出来

修法：**把反射直接叠进 `background` 的多层渐变里**。
`background` 本来就是被裁剪的那一层，不需要额外 DOM 或伪元素。
三层自下而上：底部环境暗部 → 128° 斜向扫光（和 `::before` 同一条曲线，
强度由 `--glass-strength` 缩放）→ 原来的 `--glass` 底色。
另外补了 3 条 inset 边缘（上缘亮线 / 下缘暗线 / 内亮边），做出玻璃厚度感。

低画质（`html.perf-low`）下不生效，保持原来的纯色外观。

### 四、默认歌词字号

沿用 1.2.0 的 11px（滑块范围 11~19px）。

---


收录 1.1.0 之后的内部测试版（内部迭代 1.2.31 起）的全部成果。

### 一、按第三方代码审查报告整改（135 条全覆盖）

一次针对 1.1.0 的全量审查，报告 1058 行、135 条（16 high / 62 medium / 56 low / 1 info，
无 blocker）。**全部处理完毕**，其中 132 条实际修改、3 条经核实判定不改并说明理由。

**数据安全与崩溃（最高优先）**

- 「从链接添加」写入无 blob 的记录会污染 IndexedDB，下次启动**整个本机曲库消失**。
  改为逐条 try/catch + 链接曲目单独还原路径，单条坏记录不再拖垮全部
- 崩溃处理器被安装两次：双份崩溃文件，并把 Activity 泄漏进静态字段。改为只装一次 + 幂等
- `onRenderProcessGone` 返回 true 却不销毁/重建 WebView → 返回键永久失效。改为真正重建
- safeMode 计数在 WebView 刚创建成功就清零，对「页面加载期故障」永远失效。清零挪到页面稳定后
- `dbClear` / `dbAll` 缺 `onabort`：事务中止时 Promise 永不 settle，首页起不来

**搜索与列表**

- 搜索「加载更多」把新歌插进了「歌单」列表（容器的第一个 `.list`）
- `renderAll()` 无条件重置搜索页：点一次♥，搜索结果整块消失
- 歌单详情没有请求序号，快速切换时旧请求会覆盖新歌单
- 歌单页头部永远显示「读取中…」（成功路径不清空）
- 漫游续队列不去重，越听越重复

**播放器**

- 拖进度条时每秒 ticker 把滑块抢回播放位置
- 底部 dock 进度条因内联 `width:0` 永远不可见
- `restoreLast()` 没有「用户已接管」守卫 → 抢播、跳进度、失去控制；且绕过
  `Player.load()` 导致变速/MediaSession/均衡器图都不生效
- 淡入淡出的目标音量是常量：淡入期间改音量被曲线吃掉
- 三个 `<audio>` 的事件回调不校验「事件来自当前元素」，`ended` 会无条件推进队列
- `load()` 对非法直链直接 `new URL()` 抛异常，且此时 track 已被改掉
- `seek()` 无有限性校验：MediaSession 可把 NaN 写进 `currentTime`
- `_ensureGraph` 半成功会永久无声且反复重建
- 歌词点击跳转没有扣掉 `lyricOffset`，设了偏移后点哪句都错位

**退出与后台**

- 退出 App 不停前台服务：通知栏留下一条滑不掉、按钮全失效的「正在播放」
- 后台 `startForegroundService` 被系统拒绝后静默放弃媒体通知，改为记录 + 重试 + 通知网页
- WebView 未 detach 就 destroy，退出路径资源回收不完整
- 下载目录里堆一堆 `Ripple-crash-*.txt`：改为固定文件名覆盖写 + 保留最近 10 份

**登录与网络**

- `logout` 先清 cookie 再请求上游（server.js），浏览器模式「退出登录」没有真正注销会话
- cookie「读-改-写」不在锁内，并发请求互相覆盖 `Set-Cookie`
- 登录态有三个副本，logout 只清两个（漏了 `CookieManager`）
- `login()` 把「登录成功」绑在 `status()` 上：status 超时会让整次登录报失败
- 首页在线内容被账号查询串行阻塞，弱网下长时间停在骨架屏
- 点歌时先 `await ensureLyric` 才出声，歌词接口慢时要等十几秒
- `comments` 把 id 直接拼进 URL path；改为 `^\d+$` + 路径字符白名单双层校验
- 删除三个前端零调用的桥方法（`httpGetAsync`/`exitApp`/`platform`），直接消除攻击面

**安全加固**

- `/ripple-token.js` 只信 `Sec-Fetch-Site`：改为**短期令牌**（TTL + 绑定来源 IP +
  每次签发轮换、只保留 2 个灰度），并同时校验 `Sec-Fetch-Mode`/`Origin`/`Referer`。
  前端协议不变，旧版「伪造一个头就能拿到长效令牌」不再成立
- `.ripple-cookie` 非原子写 + 吞异常：改为临时文件 + `rename` 原子替换，失败必告警
- `usesCleartextTraffic="true"` 全应用放开明文：新增 `networkSecurityConfig`，
  只给 `127.0.0.1` / `localhost` 放行
- 删除三条从未使用的权限（`ACCESS_NETWORK_STATE` / `WAKE_LOCK` / `WRITE_EXTERNAL_STORAGE`）
- 静态文件 `createReadStream` 补 `error` 监听；`/ncm` 请求体上限改按**字节**算（原先
  按 UTF-16 码元，中文实际可吃 3 倍）
- `/ncm/*` 限制为 `POST`（`GET` 也能触发 logout/like/comment_add）
- 参数校验错误返回 400 而非 502；`song_detail` 补 ids 校验
- Host 白名单改为实时查询网卡（换 Wi-Fi / IP 变化不再全站 421），421 响应体带允许列表

**性能与画质**

- **低配判定阈值从 200 万物理像素提到 450 万**：原先 1080p 自己就 207 万，
  几乎所有手机被判低配，液态玻璃（主打卖点）永远不出现
- 「减少动效」不再参与低配判定（它是偏好，不是性能信号），避免旗舰机开「移除动画」
  就变成没有玻璃质感的省电外观
- 断网/切后台时测帧率会被误判并永久降级：改为逐帧只统计可见时段
- 播放中每秒重建一次 MediaStyle 通知 → 改为按内容指纹缓存，进度交给系统插值
- `HttpBridge` 每次调用新建线程 → 固定 5 线程池 + 有界队列，拒绝时明确报错
- `LogBridge` 在 UI 线程做 MediaStore 查询 + 200KB 全量重写 → 单线程 executor + 节流
- 播放页进度条改 `transform`（不触发 layout）
- 把设置在 `requestAnimationFrame` 里合并落盘，但页面隐藏时退回 `setTimeout`
  （原先锁屏后 rAF 暂停，睡眠定时永远写不进去）

**状态与设置**

- localStorage 里的 `settings` 不做类型收敛，坏值静默生效：新增 `coerceSettings()`，
  按 `DEFAULTS` 类型逐项校验 + 钳位 + 枚举白名单
- 「列表密度」「显示歌词」两项设置重启后不生效（DOM 副作用只在手动改设置时才写）
- 「恢复默认设置」没有回滚 `Netease.base` 和已设的睡眠定时
- 睡眠定时把 `sleepUntil` 与 `sleepMin` 一起落盘，触发后归零

**无障碍（本轮改动最大的一块）**

- 核心列表/卡片/设置行全是 `div`，键盘和读屏**完全用不了**：
  歌曲行、网格卡、歌单卡、歌单行、轮播卡全部改为 `role="button" tabindex="0"`
  + `aria-label` + Enter/Space 激活；`span.more` 改为真正的 `<button>`
- 自绘对话框没有 `dialog` 语义、不接管焦点、返回键/Esc 关不掉且会把 App 退掉：
  补 `role="dialog"` + `aria-modal` + `aria-labelledby` + 焦点接管/陷阱，
  **返回键现在优先关闭模态框**而不是退出 App
- 15 个纯图标按钮补 `aria-label`；9 个开关改为 `role="switch"` + `aria-checked`
  （点击路径与启动同步都写），6 个滑块补 `aria-label`
- 浅色主题次要文字对比度只有 2.38:1：`--text3` 浅色 .38→.52（3.56:1）、
  深色 .36→.50（5.32:1）、`--lyric-dim` 浅色 .55→.68（5.95:1），
  `.about-note` 去掉多余的 `.8` 透明度
- 收起的播放页与六个 sheet 仍可聚焦：`visibility:hidden`（带 delay 保证动画走完）
  + `inert` 双层拦截
- 触摸目标小于 44px：补 `.gcard .pl`、`.c-card .c-play`、`.chip`、`.sw` 等热区
  （`.sw` 的 `::after` 已被白色圆点占用，热区走 `::before`）
- 完整歌词「当前行放大」被行内 `font-size` 压掉：改用 `--ln-size` 变量 + `calc(×1.12)`
- 底部胶囊提示补 live region；空格键不再劫持按钮的激活

**视觉**

- 歌词展开时**标题会先往下跳 125.6px 再往上飞**：根因是展开第一帧
  `min-height` 归零，腾出的空间被封面容器 `flex-grow:1` 抢走。改为展开态保持
  `min-height`，实测标题位移从「534.9 → 660.5 → 50」变成单调「534.9 → 50」
- 展开/收回缓动曲线换成本人调参定稿的 14 控制点 `linear()`（快起手、后段收缓），
  时长固定 0.3s
- 开发用的动画调参器随生产包发布（长按「关于」弹全屏面板）：**已从生产包移除**
- 「没有封面就不画模糊层」的降级规则永远不会命中（`coverOf()` 永远返回 URL）：
  改用 `body.no-cover` class
- 列表里的格式/VIP 角标被永久 `display:none`：改为正常显示，只在 <360px 隐藏
- `manifest` 锁竖屏导致 `responsive.css` 的横屏布局成为死代码：已放开

**工程质量**

- 新增 `tests/lrc.test.js`：**38 个用例**覆盖 LRC 解析（四种时间戳格式混排）、
  同时间戳去重（0.05s）、原文/译文 300ms 最近邻合并、时间轴不一致按行号兜底
- 新增 `.eslintrc.json` + `.prettierrc`
- CI 版本一致性检查改用精确匹配（`versionCode 11` 不再命中 `110`），
  并新增 `sw.js` 的 `CACHE` 校验
- CI 新增 Java 编译门禁（aapt2 compile → link 生成 R.java → javac）
- CI artifact 只上传成品 `Ripple-*.apk`，不再夹带未签名中间产物
- CI 发布步骤在 CHANGELOG 缺本段时不再失败（原 else 分支不创建文件）
- Gradle 路径补齐 `signingConfigs`（与 `build-apk.sh` 同签名），
  版本同步抽成 `android/sync-version.sh` 供两条路径共用
- `build-apk.sh` 版本解析失败直接 `exit 1`（原静默回退到 14 / 1.3.5）
- `build-apk.sh` 的 manifest package 注入改结构化插入 + 双重断言，格式一变就构建失败
  （`--rename-manifest-package` 在 aapt2 上不可用：它要求输入 manifest 已有 `package`）
- `MediaStore` 落盘逻辑从 `CrashLog`/`LogBridge` 各一份抽成 `PublicFile.write()`
- 通知小图标从系统 `android.R.drawable.ic_media_play` 换成自绘 24dp 单色 vector
  （部分 ROM 上系统图标会被 tint 成白块）
- 死代码/死样式清理：删除 `.brand`/`.tbspacer`/`.navtabs`/`.titleblock` 等约 10 个类、
  4 个只声明不读取的 CSS 变量、5 个零引用 id；`prof()` 空包装删除
- `responsive.css` 里 `.np-inner` 的重复 grid 声明合并

**文档**

- README 7 张截图补齐（`docs/screenshots/`，PNG 压缩后共约 1.6 MB），
  修正「0.67 MB」为 APK 实际大小、Java 类数、「无 Gradle 依赖」的口径
- SECURITY.md 的「跨站、无头请求一律 403」实测不成立，改为准确表述
  （浏览器跨站会被拒；同机其它程序仍可访问，但令牌是短命的）
- SECURITY.md / README 补 `/sdcard` 上 chmod 无效（fuseblk）的实测说明
- 安装说明写明 debug 签名与「只从本仓库 Releases 安装」
- CONTRIBUTING 的 SW 缓存名改法已过时（由脚本自动同步，不要手改）
- 全部「审查 X.Y 已修」式注释改为解释「为什么这样做」，历史收进本文件

### 二、本轮默认值变化

- **默认歌词字号 14px → 11px**（滑块范围 11~19px）。默认更紧凑，把播放页
  更多空间留给封面和三行歌词的呼吸感；字号仍可在设置里随时调整。

---

## 1.2.0 — 第三个版本

收录 1.1.0 之后的内部测试版（内部迭代 1.2.31 起）的全部成果。

### 一、按第三方代码审查报告整改（135 条全覆盖）

一次针对 1.1.0 的全量审查，报告 1058 行、135 条（16 high / 62 medium / 56 low / 1 info，
无 blocker）。**全部处理完毕**，其中 132 条实际修改、3 条经核实判定不改并说明理由。

**数据安全与崩溃（最高优先）**

- 「从链接添加」写入无 blob 的记录会污染 IndexedDB，下次启动**整个本机曲库消失**。
  改为逐条 try/catch + 链接曲目单独还原路径，单条坏记录不再拖垮全部
- 崩溃处理器被安装两次：双份崩溃文件，并把 Activity 泄漏进静态字段。改为只装一次 + 幂等
- `onRenderProcessGone` 返回 true 却不销毁/重建 WebView → 返回键永久失效。改为真正重建
- safeMode 计数在 WebView 刚创建成功就清零，对「页面加载期故障」永远失效。清零挪到页面稳定后
- `dbClear` / `dbAll` 缺 `onabort`：事务中止时 Promise 永不 settle，首页起不来

**搜索与列表**

- 搜索「加载更多」把新歌插进了「歌单」列表（容器的第一个 `.list`）
- `renderAll()` 无条件重置搜索页：点一次♥，搜索结果整块消失
- 歌单详情没有请求序号，快速切换时旧请求会覆盖新歌单
- 歌单页头部永远显示「读取中…」（成功路径不清空）
- 漫游续队列不去重，越听越重复

**播放器**

- 拖进度条时每秒 ticker 把滑块抢回播放位置
- 底部 dock 进度条因内联 `width:0` 永远不可见
- `restoreLast()` 没有「用户已接管」守卫 → 抢播、跳进度、失去控制；且绕过
  `Player.load()` 导致变速/MediaSession/均衡器图都不生效
- 淡入淡出的目标音量是常量：淡入期间改音量被曲线吃掉
- 三个 `<audio>` 的事件回调不校验「事件来自当前元素」，`ended` 会无条件推进队列
- `load()` 对非法直链直接 `new URL()` 抛异常，且此时 track 已被改掉
- `seek()` 无有限性校验：MediaSession 可把 NaN 写进 `currentTime`
- `_ensureGraph` 半成功会永久无声且反复重建
- 歌词点击跳转没有扣掉 `lyricOffset`，设了偏移后点哪句都错位

**退出与后台**

- 退出 App 不停前台服务：通知栏留下一条滑不掉、按钮全失效的「正在播放」
- 后台 `startForegroundService` 被系统拒绝后静默放弃媒体通知，改为记录 + 重试 + 通知网页
- WebView 未 detach 就 destroy，退出路径资源回收不完整
- 下载目录里堆一堆 `Ripple-crash-*.txt`：改为固定文件名覆盖写 + 保留最近 10 份

**登录与网络**

- `logout` 先清 cookie 再请求上游（server.js），浏览器模式「退出登录」没有真正注销会话
- cookie「读-改-写」不在锁内，并发请求互相覆盖 `Set-Cookie`
- 登录态有三个副本，logout 只清两个（漏了 `CookieManager`）
- `login()` 把「登录成功」绑在 `status()` 上：status 超时会让整次登录报失败
- 首页在线内容被账号查询串行阻塞，弱网下长时间停在骨架屏
- 点歌时先 `await ensureLyric` 才出声，歌词接口慢时要等十几秒
- `comments` 把 id 直接拼进 URL path；改为 `^\d+$` + 路径字符白名单双层校验
- 删除三个前端零调用的桥方法（`httpGetAsync`/`exitApp`/`platform`），直接消除攻击面

**安全加固**

- `/ripple-token.js` 只信 `Sec-Fetch-Site`：改为**短期令牌**（TTL + 绑定来源 IP +
  每次签发轮换、只保留 2 个灰度），并同时校验 `Sec-Fetch-Mode`/`Origin`/`Referer`。
  前端协议不变，旧版「伪造一个头就能拿到长效令牌」不再成立
- `.ripple-cookie` 非原子写 + 吞异常：改为临时文件 + `rename` 原子替换，失败必告警
- `usesCleartextTraffic="true"` 全应用放开明文：新增 `networkSecurityConfig`，
  只给 `127.0.0.1` / `localhost` 放行
- 删除三条从未使用的权限（`ACCESS_NETWORK_STATE` / `WAKE_LOCK` / `WRITE_EXTERNAL_STORAGE`）
- 静态文件 `createReadStream` 补 `error` 监听；`/ncm` 请求体上限改按**字节**算（原先
  按 UTF-16 码元，中文实际可吃 3 倍）
- `/ncm/*` 限制为 `POST`（`GET` 也能触发 logout/like/comment_add）
- 参数校验错误返回 400 而非 502；`song_detail` 补 ids 校验
- Host 白名单改为实时查询网卡（换 Wi-Fi / IP 变化不再全站 421），421 响应体带允许列表

**性能与画质**

- **低配判定阈值从 200 万物理像素提到 450 万**：原先 1080p 自己就 207 万，
  几乎所有手机被判低配，液态玻璃（主打卖点）永远不出现
- 「减少动效」不再参与低配判定（它是偏好，不是性能信号），避免旗舰机开「移除动画」
  就变成没有玻璃质感的省电外观
- 断网/切后台时测帧率会被误判并永久降级：改为逐帧只统计可见时段
- 播放中每秒重建一次 MediaStyle 通知 → 改为按内容指纹缓存，进度交给系统插值
- `HttpBridge` 每次调用新建线程 → 固定 5 线程池 + 有界队列，拒绝时明确报错
- `LogBridge` 在 UI 线程做 MediaStore 查询 + 200KB 全量重写 → 单线程 executor + 节流
- 播放页进度条改 `transform`（不触发 layout）
- 把设置在 `requestAnimationFrame` 里合并落盘，但页面隐藏时退回 `setTimeout`
  （原先锁屏后 rAF 暂停，睡眠定时永远写不进去）

**状态与设置**

- localStorage 里的 `settings` 不做类型收敛，坏值静默生效：新增 `coerceSettings()`，
  按 `DEFAULTS` 类型逐项校验 + 钳位 + 枚举白名单
- 「列表密度」「显示歌词」两项设置重启后不生效（DOM 副作用只在手动改设置时才写）
- 「恢复默认设置」没有回滚 `Netease.base` 和已设的睡眠定时
- 睡眠定时把 `sleepUntil` 与 `sleepMin` 一起落盘，触发后归零

**无障碍（本轮改动最大的一块）**

- 核心列表/卡片/设置行全是 `div`，键盘和读屏**完全用不了**：
  歌曲行、网格卡、歌单卡、歌单行、轮播卡全部改为 `role="button" tabindex="0"`
  + `aria-label` + Enter/Space 激活；`span.more` 改为真正的 `<button>`
- 自绘对话框没有 `dialog` 语义、不接管焦点、返回键/Esc 关不掉且会把 App 退掉：
  补 `role="dialog"` + `aria-modal` + `aria-labelledby` + 焦点接管/陷阱，
  **返回键现在优先关闭模态框**而不是退出 App
- 15 个纯图标按钮补 `aria-label`；9 个开关改为 `role="switch"` + `aria-checked`
  （点击路径与启动同步都写），6 个滑块补 `aria-label`
- 浅色主题次要文字对比度只有 2.38:1：`--text3` 浅色 .38→.52（3.56:1）、
  深色 .36→.50（5.32:1）、`--lyric-dim` 浅色 .55→.68（5.95:1），
  `.about-note` 去掉多余的 `.8` 透明度
- 收起的播放页与六个 sheet 仍可聚焦：`visibility:hidden`（带 delay 保证动画走完）
  + `inert` 双层拦截
- 触摸目标小于 44px：补 `.gcard .pl`、`.c-card .c-play`、`.chip`、`.sw` 等热区
  （`.sw` 的 `::after` 已被白色圆点占用，热区走 `::before`）
- 完整歌词「当前行放大」被行内 `font-size` 压掉：改用 `--ln-size` 变量 + `calc(×1.12)`
- 底部胶囊提示补 live region；空格键不再劫持按钮的激活

**视觉**

- 歌词展开时**标题会先往下跳 125.6px 再往上飞**：根因是展开第一帧
  `min-height` 归零，腾出的空间被封面容器 `flex-grow:1` 抢走。改为展开态保持
  `min-height`，实测标题位移从「534.9 → 660.5 → 50」变成单调「534.9 → 50」
- 展开/收回缓动曲线换成本人调参定稿的 14 控制点 `linear()`（快起手、后段收缓），
  时长固定 0.3s
- 开发用的动画调参器随生产包发布（长按「关于」弹全屏面板）：**已从生产包移除**
- 「没有封面就不画模糊层」的降级规则永远不会命中（`coverOf()` 永远返回 URL）：
  改用 `body.no-cover` class
- 列表里的格式/VIP 角标被永久 `display:none`：改为正常显示，只在 <360px 隐藏
- `manifest` 锁竖屏导致 `responsive.css` 的横屏布局成为死代码：已放开

**工程质量**

- 新增 `tests/lrc.test.js`：**38 个用例**覆盖 LRC 解析（四种时间戳格式混排）、
  同时间戳去重（0.05s）、原文/译文 300ms 最近邻合并、时间轴不一致按行号兜底
- 新增 `.eslintrc.json` + `.prettierrc`
- CI 版本一致性检查改用精确匹配（`versionCode 11` 不再命中 `110`），
  并新增 `sw.js` 的 `CACHE` 校验
- CI 新增 Java 编译门禁（aapt2 compile → link 生成 R.java → javac）
- CI artifact 只上传成品 `Ripple-*.apk`，不再夹带未签名中间产物
- CI 发布步骤在 CHANGELOG 缺本段时不再失败（原 else 分支不创建文件）
- Gradle 路径补齐 `signingConfigs`（与 `build-apk.sh` 同签名），
  版本同步抽成 `android/sync-version.sh` 供两条路径共用
- `build-apk.sh` 版本解析失败直接 `exit 1`（原静默回退到 14 / 1.3.5）
- `build-apk.sh` 的 manifest package 注入改结构化插入 + 双重断言，格式一变就构建失败
  （`--rename-manifest-package` 在 aapt2 上不可用：它要求输入 manifest 已有 `package`）
- `MediaStore` 落盘逻辑从 `CrashLog`/`LogBridge` 各一份抽成 `PublicFile.write()`
- 通知小图标从系统 `android.R.drawable.ic_media_play` 换成自绘 24dp 单色 vector
  （部分 ROM 上系统图标会被 tint 成白块）
- 死代码/死样式清理：删除 `.brand`/`.tbspacer`/`.navtabs`/`.titleblock` 等约 10 个类、
  4 个只声明不读取的 CSS 变量、5 个零引用 id；`prof()` 空包装删除
- `responsive.css` 里 `.np-inner` 的重复 grid 声明合并

**文档**

- README 7 张截图补齐（`docs/screenshots/`，PNG 压缩后共约 1.6 MB），
  修正「0.67 MB」为 APK 实际大小、Java 类数、「无 Gradle 依赖」的口径
- SECURITY.md 的「跨站、无头请求一律 403」实测不成立，改为准确表述
  （浏览器跨站会被拒；同机其它程序仍可访问，但令牌是短命的）
- SECURITY.md / README 补 `/sdcard` 上 chmod 无效（fuseblk）的实测说明
- 安装说明写明 debug 签名与「只从本仓库 Releases 安装」
- CONTRIBUTING 的 SW 缓存名改法已过时（由脚本自动同步，不要手改）
- 全部「审查 X.Y 已修」式注释改为解释「为什么这样做」，历史收进本文件

### 二、本轮默认值变化

- **默认歌词字号 14px → 11px**（滑块范围 11~19px）。默认更紧凑，把播放页
  更多空间留给封面和三行歌词的呼吸感；字号仍可在设置里随时调整。

---

## 1.1.0 — 第二个版本

收录 1.0.0 之后的内部测试版（内部迭代 1.2.16 ~ 1.2.30）的全部成果。

### 一、按第三方代码审查报告整改

一份 751 行的外部审查，列出 91 个问题（9 blocker / 26 high / 32 medium / 24 low）。
分五批整改完毕：

**Blocker（9 个，全部修复）**

- 搜索一次就永久破坏搜索页（热搜/推荐节点被 `innerHTML` 抹掉，后续渲染抛错）
- Service Worker 缓存版本与代码版本脱钩 → 整个应用冻在旧版本
- `server.js` 同源判定可被 Host 头伪造 → 登录态可被窃取
- 「从链接添加」的远程直链必然播不出来（CORS 路由错误）
- 切歌/淡入淡出全程使用可变的 `this.el` → 会把新歌淡掉、暂停掉
- 均衡器预设对第一首本地歌不生效（设置页却显示已启用）
- IndexedDB 事务 abort 时 Promise 永不 settle → 导入永久卡死
- 浅色主题下歌词非当前行对比度只有 1.43:1
- `prefers-reduced-motion` 没有真正降级

**High（26 个，全部修复）**

体验类：搜索结果只能看到 30 条（`offset` 从未传下去）、万人歌单一次性
渲染上万个节点、`status` 超时导致误显示「未登录网易云」、退出确认窗口
与提示时长不一致、「清除播放记录」无二次确认、后台定时器从不清理。

视觉/性能类：`.page` 同时跑 transition 与 animation 导致末尾回抽、
进度条过渡 `width` 触发 layout、`will-change` 常驻占用显存、
玻璃饱和度四档混用、面板叠层 4 层 `backdrop-filter`、14 处触摸目标小于 44px、
动态取色时整屏主色瞬间跳变。

**Medium / Low**：见下方各节，已按影响面挑重点处理。

### 二、液态玻璃（高画质专属）

参考 iOS 26 的 Liquid Glass，四项特征：

- **高斯模糊** —— `backdrop-filter:blur()`
- **折射** —— `backdrop-filter: url(#lg-warp)`，用 SVG 的 `feTurbulence` +
  `feDisplacementMap` 让背后的内容真的被弯曲。
  这是液态玻璃与普通毛玻璃的分界：普通毛玻璃是均匀模糊，看起来像磨砂塑料；
  真实玻璃有厚度，边缘会把背景**弯曲错位**。
  实测确认：横条纹经过玻璃后变成波浪，对照组（只 blur）条纹是直的。
- **反射** —— 顶部亮线 + 底部弱反光 + `::before` 铺 128° 斜向扫光
- **动态响应** —— 按压时模糊 ×1.18、饱和度 ×1.06、亮度抬升

全部由「玻璃强度」滑块统一驱动：0~40px 归一化成 `--glass-strength`（0~1），
同时缩放折射幅度、反射高光、按压强度。拉到 0 时彻底关掉 `backdrop-filter`。

低画质模式保持原样（普通毛玻璃 + 实色底）。

### 三、真机反馈修复

一轮密集的用户实测，每条都是按症状倒查根因：

| 症状 | 根因 |
|---|---|
| 重进软件后歌词拿不到 | 恢复流程里界面先渲染、歌词后回来，时序不匹配 |
| 小窗（411×685）布局被挤爆 | 封面尺寸用了「较大值」兜底，无视容器高度 |
| 411×851 全屏高度不对、状态栏没被覆盖 | safeMode 判定 `streak >= 1`，重启过一次就永久降级 |
| 评论键盘弹出时不跟随 | 原生 `getInsets()` 漏了 `ime()` |
| 曲库最后一行被底部导航挡住 | 页面留白写死 150px，不含 `--safe-b` |
| 底部导航越界到右边 | 液态玻璃的 `position:relative` 覆盖了原本的 `absolute` |
| 页面随便都能拖动 | `html` 未锁 `overflow` |
| 底部莫名多出一条面板 | 面板收起用 `translateY(101%)`，内容少时不够移出 |
| 首页大卡片重进后没封面 | 推荐回来后只更新横滑区，从未重绘 hero |
| 左上角时间停在启动那一刻 | 只在 boot 写一次，没有定时刷新 |

### 四、功能改动

**首页大卡片改成「无限漫游」入口**

- 数据来自 `v1/discovery/simiSong`（相似歌曲），不再是每日推荐第 1 首
  （以前和下面第一张小卡片是同一张图，看起来像重复）
- 种子三级回退：当前播放的在线歌 →「我喜欢」第一首 → 每日推荐随机一首
- 点主按钮：从卡片上那首出发灌满队列并播放，模式切到 `roam`
- 点副按钮：换一首显示，不重播
- 结果落 `localStorage`，冷启动第一帧就有封面

**搜索分页**

以前固定 30 条，`offset` 参数定义了却全项目没人传，界面还显示总数。
现在有「加载更多」+ 滚到底自动续取，新结果追加而不重建列表。

**其他**

- 请求 in-flight 去重（连点同一首歌不再打多次请求）
- 设置滑块合并写盘（拖动时不再每帧全量序列化 localStorage）
- 返回键两次确认退出，判定窗口与提示时长统一为 2500ms
- `:focus-visible` 键盘焦点样式、`aria-live` 提示区
- 封面尺寸改由 CSS 变量单点驱动，删掉整套测量/冻结/补偿逻辑

---

## 1.0.0 — 首个完整版本

收录 1.0.0 之前内部测试版（内部迭代 1.0.0 ~ 1.3.5）的成果汇总。

### 播放页

- 封面吸收剩余高度、底部按钮固定贴底
- 歌词点一下原地展开（页面布局整体上移，不另开浮层）
- 封面横滑切歌（下一首封面滑入）
- 下拉关闭播放页
- 播放设置面板（右上角 …）、均衡器、播放列表
- 恢复上次播放歌曲与进度（在线曲目重启后重新解析音源）

### 网易云接入

- weapi 协议（双重 AES-128-CBC + RSA）
- 登录（手机号 / 扫码）、每日推荐、搜索、歌单、评论、点赞、心动模式
- 音质档位切换、VIP 角标、试听提示

### 原生外壳

- edge-to-edge：状态栏/导航栏透明，网页自己避让，insets 通过 CSS 变量传递
- 前台服务 + MediaSession：通知栏播放控件、锁屏控件、耳机键
- 状态栏歌词浮层（可调颜色、字号、位置）
- 崩溃日志、软件日志、安全模式

### 适配与性能

- 断点按宽度 + 宽高比判断（手机 / 大屏手机 / 平板竖横 / 折叠屏 / 桌面）
- 平板左侧竖排导航、播放页两栏
- 低配模式自动降级（氛围光、噪点、玻璃模糊、面板 backdrop-filter）
- 封面网格 `content-visibility`、页面 `contain:paint`

### 主题

- 深色 / 浅色 / 跟随系统
- 动态取色（从封面提取主色）
- 液态玻璃外观（1.1.0 起升级为真折射）
