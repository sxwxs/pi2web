# Remote Pi 本地语音服务器启动指南（Windows）

本文记录本机上启动 Speaches、加载中文 TTS 模型，以及启动 Remote Pi 语音功能的完整步骤。

## 当前配置

- Speaches 源码目录：`C:\src\opensource\speaches`
- Speaches 地址：`http://127.0.0.1:8000/v1`
- 中文 TTS 模型：`speaches-ai/piper-zh_CN-huayan-medium`
- TTS voice：`huayan`
- Remote Pi 地址：`http://127.0.0.1:11318`

> Windows 上启动 Speaches 时必须启用 Python UTF-8 模式。否则读取中文 Piper 模型的 `config.json` 时可能发生 `UnicodeDecodeError`，客户端表现为 `HTTP 200, 0 bytes` 或 `curl: (18) transfer closed`。

## 一、每次启动 Speaches

打开一个新的 PowerShell 窗口，执行：

```powershell
cd C:\src\opensource\speaches

.\.venv\Scripts\python.exe -X utf8 -m uvicorn `
  --factory `
  --host 127.0.0.1 `
  --port 8000 `
  speaches.main:create_app
```

保持这个窗口运行。看到以下内容表示服务已经启动：

```text
Uvicorn running on http://127.0.0.1:8000
```

在另一个 PowerShell 窗口检查服务：

```powershell
curl.exe --fail-with-body http://127.0.0.1:8000/health
```

正常响应：

```json
{"message":"OK"}
```

Speaches Web UI：

```text
http://127.0.0.1:8000
```

## 二、首次安装或模型丢失时下载中文 TTS 模型

模型已经下载后不需要每次执行。

```powershell
curl.exe --fail-with-body -X POST `
  "http://127.0.0.1:8000/v1/models/speaches-ai/piper-zh_CN-huayan-medium"
```

查看已经安装的模型：

```powershell
curl.exe --fail-with-body http://127.0.0.1:8000/v1/models
```

输出中应包含：

```text
speaches-ai/piper-zh_CN-huayan-medium
```

## 三、测试中文语音合成

先创建测试请求文件：

```powershell
@'
{
  "model": "speaches-ai/piper-zh_CN-huayan-medium",
  "voice": "huayan",
  "input": "语音服务器配置成功，这是一段标准普通话测试。",
  "response_format": "wav",
  "sample_rate": 24000,
  "stream_format": "audio"
}
'@ | Set-Content "C:\Users\sunxiaowen\piper-request.json" -Encoding utf8
```

发送请求：

```powershell
curl.exe --fail-with-body -sS `
  -X POST "http://127.0.0.1:8000/v1/audio/speech" `
  -H "Content-Type: application/json" `
  --data-binary "@C:\Users\sunxiaowen\piper-request.json" `
  --output "C:\Users\sunxiaowen\piper-test.wav" `
  -w "`nHTTP %{http_code}, %{size_download} bytes`n"
```

正常情况下应显示 `HTTP 200`，并且下载大小明显大于零。播放测试文件：

```powershell
Invoke-Item "C:\Users\sunxiaowen\piper-test.wav"
```

## 四、启动 Remote Pi 的语音功能

Remote Pi 需要两个服务：

1. Speaches：负责 STT/TTS。
2. OpenAI-compatible 摘要 LLM：把 Agent 最终输出压缩成适合朗读的短摘要。

打开另一个 PowerShell 窗口：

```powershell
cd C:\src\sxw\remote-pi
```

如果摘要 LLM 需要 API key，先设置环境变量：

```powershell
$env:SUMMARY_API_KEY = "替换成摘要服务的实际密钥"
```

启动 Remote Pi：

```powershell
npm run dev -- `
  --voice-base-url "http://127.0.0.1:8000/v1" `
  --voice-tts-model "speaches-ai/piper-zh_CN-huayan-medium" `
  --voice-tts-voice "huayan" `
  --voice-summary-base-url "https://替换成摘要服务地址/v1" `
  --voice-summary-model "替换成摘要模型ID" `
  --voice-summary-api-key-env "SUMMARY_API_KEY" `
  --voice-language "zh-CN"
```

如果摘要服务不需要 API key，删除下面两项：

```powershell
$env:SUMMARY_API_KEY = "..."
--voice-summary-api-key-env "SUMMARY_API_KEY"
```

如果 Speaches 已经配置 STT 模型，可在启动参数中增加：

```text
--voice-stt-model "实际的STT模型ID"
```

未配置 `--voice-stt-model` 时，语音播报仍可使用，但浏览器麦克风转写不可用。

## 五、Web UI 中启用语音

1. 打开 `http://127.0.0.1:11318`。
2. 输入 Remote Pi 终端显示的配对码。
3. 点击 Web UI 中的“启用语音”。
4. Agent 完成任务后，Remote Pi 会先请求摘要 LLM，再调用 Speaches 播放中文摘要。

浏览器麦克风通常要求 HTTPS 安全上下文；通过 `localhost` 访问时可以使用 HTTP。

## 六、推荐的日常启动顺序

每次开机后按以下顺序启动：

1. 启动 Speaches，并保持窗口运行。
2. 调用 `/health` 确认 Speaches 正常。
3. 启动摘要 LLM（如果是本地服务）。
4. 启动 Remote Pi。
5. 打开 Web UI 并启用语音。

## 七、停止服务

在对应的 PowerShell 窗口按：

```text
Ctrl+C
```

建议先停止 Remote Pi，再停止 Speaches。

## 八、常见问题

### `HTTP 200, 0 bytes` 或 `curl: (18)`

确认 Speaches 是使用下面的 UTF-8 启动方式，而不是直接运行 `uvicorn.exe`：

```powershell
.\.venv\Scripts\python.exe -X utf8 -m uvicorn --factory --host 127.0.0.1 --port 8000 speaches.main:create_app
```

### `Failed to open ...piper-request.json`

确认文件存在：

```powershell
Get-Item "C:\Users\sunxiaowen\piper-request.json"
```

然后在 `curl.exe --data-binary` 中使用完整绝对路径。

### 模型不存在

重新下载：

```powershell
curl.exe --fail-with-body -X POST `
  "http://127.0.0.1:8000/v1/models/speaches-ai/piper-zh_CN-huayan-medium"
```

### Speaches 无法连接

检查端口：

```powershell
Test-NetConnection 127.0.0.1 -Port 8000
```

如果 `TcpTestSucceeded` 为 `False`，说明 Speaches 尚未启动或已经退出。

### 能生成测试音频，但 Remote Pi 没有声音

依次确认：

1. Web UI 已点击“启用语音”。
2. 摘要 LLM 的 `/v1/chat/completions` 支持流式响应。
3. Remote Pi 启动终端和 Speaches 终端没有报错。
4. 浏览器标签页没有静音，系统输出设备选择正确。
