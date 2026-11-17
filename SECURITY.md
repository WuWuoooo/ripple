# 安全说明

## 这个项目会处理哪些敏感数据

| 数据 | 存在哪里 | 说明 |
|---|---|---|
| 网易云登录态（`MUSIC_U`） | APK：应用私有 SharedPreferences；浏览器模式：`.ripple-cookie` | 已在 `.gitignore` 里，**绝不会提交** |
| `server.js` 访问令牌 | `.ripple-token`（服务端启动时自动生成，**30 分钟内有效**） | 用于校验 `/ncm/*` 请求，每次页面加载轮换 |
| 本机导入的音频 | IndexedDB（浏览器）/ 应用私有目录（APK） | 只在本机 |
| 播放记录、设置 | localStorage / SharedPreferences | 只在本机 |
| 运行日志 | `Download/Ripple-log.txt` | 含播放与接口调用记录，不含密码 |

本项目**没有自有服务器**，不上传任何数据到第三方。所有网络请求只发往 `music.163.com` 及其 CDN。

> **关于「权限 0600」**：`server.js` 创建 `.ripple-cookie` / `.ripple-token` 时会尝试
> `chmod 0600` 并在启动时读回 mode 校验、不符即打印警告。但本项目常跑在
> `/sdcard/DSHBox/ripple`（Android 内部存储，**fuseblk 挂载**），该挂载不实现 POSIX
> 权限位，`chmod` 在这里是**空操作** —— 实测 `stat -c '%a' .ripple-cookie .ripple-token`
> 得到的是 `660` 而不是 `0600`。真正的保护来自「别的 App 读不到这块存储」，
> 而不是文件权限位。同步说明见 [README.md](README.md#隐私)。

## 报告安全问题

如果发现安全漏洞，请**不要**直接开公开 issue。请通过下面任一方式私下联系：

1. 在 GitHub 上用 [Security Advisories](../../security/advisories/new) 私密报告（推荐）
2. 或在 issue 里只说「有一个安全问题，需要私下沟通」，让维护者联系你

请尽量附上：

- 影响范围（例如：局域网内可未授权调用接口）
- 复现步骤
- 你建议的修复方向

我们会在 7 天内确认收到，并在修复后于发行说明中致谢（除非你希望匿名）。

## 已做的防护

这些是为了让你放心，也是给贡献者的改动基准：

- **`/ncm/*` 需要访问令牌**：这个接口带着你的网易云登录态，未加保护时同一 Wi-Fi 下任何网页都能用你的账号改收藏。
- **令牌是短期、轮换、绑定来源 IP 的**：令牌由 `/ripple-token.js` 在每次页面加载时签发，
  默认 30 分钟过期，每个 IP 每分钟最多签发 30 个，且只认签发时的来源 IP。
  所以即使令牌泄露，可用窗口也很短。
- **浏览器发起的跨站请求会被拒绝**：`/ripple-token.js` 校验 Host 白名单、`Sec-Fetch-Site`、
  `Sec-Fetch-Mode` / Origin / Referer，浏览器里从别的站点发起的请求拿不到令牌。
  **但这不是「无头请求一律 403」** —— 这些请求头客户端可以自行伪造，实测
  `curl -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: no-cors'` **能拿到令牌**。
  换句话说：**同机的其它程序仍然可以访问 `/ripple-token.js` 取到令牌，只是拿到的是短命令牌。**
  本项目的威胁模型是「防局域网 / 互联网上的网页跨站打你的接口」，不是「防本机上已经拿到同等权限的程序」：
  后者能读你的 cookie 文件，同理也能读令牌，靠令牌拦不住。真正起作用的是 TTL + IP 绑定 + 轮换。
  令牌的具体实现（TTL 长度、是否一次性 nonce）可能继续收紧，本段描述的是**设计意图**而不是实现细节。
- **`/ncm/*` 按 IP 限流**：60 次/分钟，超限 429 + `Retry-After`，避免被别人借你的登录态刷爆网易云风控。
- **上游路径白名单在拼接前校验**：用户参数不合法直接拒绝，不做「先拼再用 URL 归一化」的补丁（`new URL()` 会把 `..` 归一化掉，事后校验拦不住）。
- **`/audio` 代理已下线**：前端从未使用它，为减少攻击面已整体删除（原先它的域名白名单只是纵深防御）。
- **`/ncm/*` 请求体上限 256 KB**。
- **畸形 URL 不会打挂进程**：`decodeURIComponent` / `new URL` 都有 try/catch，整个请求处理外层也有兜底。
- **静态目录前缀校验带分隔符**：`file === ROOT || file.startsWith(ROOT + sep)`，避免 `app2/` 这类同级目录被误放行。
- **WebView 关闭 universal file access**：`setAllowUniversalAccessFromFileURLs(false)`，`file://` 页面不能任意跨域。
- **登录页禁止站外跳转**：防止钓鱼页面在登录 WebView 里接管流程。
- **`file://` 页面只加载自身 assets**。

## 已知限制（不是漏洞，但你应该知道）

- **调试签名的 APK（已知取舍，不会改）**：Release 包用仓库里固定的 **debug keystore** 签名。
  这是有意的取舍 —— 换签名会让现有用户**无法覆盖升级**（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`），
  代价是 debug 证书的密码是公开的（`android`），**任何人都能签出同包名的 APK**。
  因此：
  - 请**只从本仓库 Releases** 安装，不要安装其它来源的同包名 APK；
  - 如果你自己分发，可以换自己的 release keystore，但要知道老用户必须卸载重装。
  - **不能上架应用商店**：公开密码的证书不被商店接受。
- **`usesCleartextTraffic="true"`**：允许 http 明文，因为部分用户的私有代理是 http。生产环境建议改成 https。
- **状态栏歌词需要悬浮窗权限**：这是 Android 的机制限制，不是本项目额外索取。
- **`.ripple-cookie` 是明文**：网易云的登录态本身就是 cookie，无法加密存储。
  服务端会尝试 `chmod 0600`，但在 `/sdcard`（fuseblk）上不生效，实测为 `660`（见上文）。
- **同机其它程序可自行取到访问令牌**：令牌防的是跨站网页，不是本机上的其它进程。
  如果这台机器上还有别的 App 能读你的内部存储，请把项目移到应用私有目录再运行。
