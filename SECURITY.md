# 安全说明

## 这个项目会处理哪些敏感数据

| 数据 | 存在哪里 | 说明 |
|---|---|---|
| 网易云登录态（`MUSIC_U`） | APK：应用私有 SharedPreferences；浏览器模式：`.ripple-cookie`（权限 0600） | 已在 `.gitignore` 里，**绝不会提交** |
| `server.js` 访问令牌 | `.ripple-token`（权限 0600，服务端启动时自动生成） | 用于校验 `/ncm/*` 请求 |
| 本机导入的音频 | IndexedDB（浏览器）/ 应用私有目录（APK） | 只在本机 |
| 播放记录、设置 | localStorage / SharedPreferences | 只在本机 |
| 运行日志 | `Download/Ripple-log.txt` | 含播放与接口调用记录，不含密码 |

本项目**没有自有服务器**，不上传任何数据到第三方。所有网络请求只发往 `music.163.com` 及其 CDN。

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

- **`/ncm/*` 需要同源 + 访问令牌**：这个接口带着你的网易云登录态，未加保护时同一 Wi-Fi 下任何网页都能用你的账号改收藏。
- **`/audio?u=` 有目标域名白名单**：只代理网易云域名，防止被当成内网探测跳板（SSRF）。
- **`/ncm/*` 请求体上限 256 KB**。
- **畸形 URL 不会打挂进程**：`decodeURIComponent` / `new URL` 都有 try/catch，整个请求处理外层也有兜底。
- **静态目录前缀校验带分隔符**：`file === ROOT || file.startsWith(ROOT + sep)`，避免 `app2/` 这类同级目录被误放行。
- **WebView 关闭 universal file access**：`setAllowUniversalAccessFromFileURLs(false)`，`file://` 页面不能任意跨域。
- **登录页禁止站外跳转**：防止钓鱼页面在登录 WebView 里接管流程。
- **`file://` 页面只加载自身 assets**。

## 已知限制（不是漏洞，但你应该知道）

- **调试签名的 APK**：Release 包目前用 debug keystore 签名（方便覆盖安装）。如果你自己分发，建议换成自己的 release keystore 并妥善保管。
- **`usesCleartextTraffic="true"`**：允许 http 明文，因为部分用户的私有代理是 http。生产环境建议改成 https。
- **状态栏歌词需要悬浮窗权限**：这是 Android 的机制限制，不是本项目额外索取。
- **`.ripple-cookie` 是明文**：网易云的登录态本身就是 cookie，无法加密存储；本机权限已收到 0600。
