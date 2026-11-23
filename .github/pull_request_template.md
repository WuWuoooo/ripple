## 改了什么

<!-- 一句话说明这个 PR 解决什么问题。写「为什么」，不要只写「改了哪个文件」。 -->

## 关联 issue

<!-- 例如 Closes #12。没有就写「无」 -->

## 怎么验证的

<!-- 说清你怎么确认改动生效，以及在哪台设备 / 哪个浏览器上试过 -->

- [ ] `node --check` 全部 JS 通过
- [ ] 改了前端 → 已跑 `bash android/sync-version.sh`（**不要手改** `app/sw.js` 的 `CACHE`，它由脚本从 `version.json` 同步）
- [ ] 没有提交 `.ripple-cookie` / `.ripple-token` / `android/debug.keystore`
- [ ] 界面改动附了截图

## 类型

- [ ] 修复 bug
- [ ] 新功能
- [ ] 重构 / 清理
- [ ] 文档

## 备注

<!-- 有没有已知限制、后续要做的、需要 reviewer 特别注意的地方 -->
