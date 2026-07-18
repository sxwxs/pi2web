# Remote Pi Android

原生 Kotlin / Jetpack Compose 客户端，最低 Android 8.0（API 26）。当前实现覆盖 Android MVP 的前台闭环：

- 多 Server 配置、连接测试和认证错误展示
- Android Keystore AES-GCM 加密 Access Token
- Release 版本拒绝 HTTP 明文连接；Debug 可连接本机开发服务
- Workspace 列表、懒加载目录和分页文件预览
- 在 Workspace/当前目录创建 Agent，查看和停止 Agent
- 加载历史消息，发送 prompt/steer/follow-up，abort
- OkHttp WebSocket Bearer 认证、sequence 去重、游标持久化和指数退避重连
- 文本增量、thinking、tool start/end 和 retry 事件展示
- protocol v1 检查和 Server snapshot 恢复
- Session 新建/恢复、tree navigation 和 compact
- Model 与 thinking level 查询和切换
- Extension UI select/confirm/input/editor/notify/status 映射
- Session 自定义名称
- 输入 `@` 从 Agent cwd 开始浏览目录、选择文件/目录并自动插入引用
- 多 Agent 完成事件监听和 Android 本地通知（Unix 时间戳转换为设备本地时间）

## 构建

需要 JDK 17 和 Android SDK 35：

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

Debug APK：`app/build/outputs/apk/debug/app-debug.apk`。

## 连接开发 Server

模拟器访问宿主机通常使用 `http://10.0.2.2:8787`。真机使用 VPN/Tailscale、局域网地址或 HTTPS 反向代理。Remote Pi Server 默认只监听 `127.0.0.1`，请勿为测试直接裸露到公网。

Release build 的 manifest 禁止 cleartext traffic，并且客户端会拒绝非 `https://` URL。TLS 错误不会绕过或静默接受。

## 数据安全

Server 名称和 URL 存储于普通 SharedPreferences；Token 使用不可导出的 Android Keystore 密钥进行 AES-GCM 加密后存储在独立 `secure.xml`，且该文件排除于 Android Backup。Token 不进入 URL、应用日志或数据库。

## 协议兼容性

App 对接 `/api/v1` HTTP 和 `/api/v1/ws`，发送 `X-Remote-Pi-Protocol: 1`，登录时读取 `/api/v1/system/status` 并拒绝不兼容协议。WebSocket 使用 `agent_snapshot` 恢复缓存缺口，并保留 HTTP messages fallback。协议定义位于 `packages/protocol/`。
