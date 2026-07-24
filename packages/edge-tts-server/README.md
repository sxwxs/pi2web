# Native Edge TTS server for Remote Pi

这是一个很薄的 Python 服务：

- `edge-tts` 连接 Microsoft Edge 在线语音服务并生成 MP3。
- `aiohttp` 提供 OpenAI-compatible `POST /v1/audio/speech` HTTP 接口。
- 不需要 Docker、FFmpeg，也不提供语音识别。
- 默认只监听 `127.0.0.1:5050`。

## 安装和启动

要求 Python 3.10 或更高版本。

```bash
cd packages/edge-tts-server
python -m venv .venv
```

Windows PowerShell：

```powershell
.venv\Scripts\Activate.ps1
python -m pip install -e .
remote-pi-edge-tts
```

Linux/macOS：

```bash
source .venv/bin/activate
python -m pip install -e .
remote-pi-edge-tts
```

可以指定监听地址和默认音色：

```bash
remote-pi-edge-tts --host 127.0.0.1 --port 5050 --voice zh-CN-XiaoxiaoNeural
```

## 测试

```bash
curl http://127.0.0.1:5050/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"edge-tts","voice":"zh-CN-XiaoxiaoNeural","input":"你好，这是 Edge TTS 测试。","response_format":"mp3"}' \
  --output edge-tts-test.mp3
```

## 启动 Remote Pi

```bash
remote-pi \
  --voice-base-url http://127.0.0.1:5050/v1 \
  --voice-tts-model edge-tts \
  --voice-tts-voice zh-CN-XiaoxiaoNeural \
  --voice-tts-format mp3 \
  --voice-summary-base-url https://llm.example.com/v1 \
  --voice-summary-model your-summary-model \
  --voice-summary-api-key-env SUMMARY_API_KEY \
  --voice-language zh-CN
```

不要传 `--voice-stt-model`。Web UI 会提供 Agent 摘要播报，但隐藏麦克风按钮。

常用中文音色包括 `zh-CN-XiaoxiaoNeural`、`zh-CN-YunxiNeural`、`zh-CN-YunyangNeural` 和 `zh-CN-YunjianNeural`。

Edge TTS 使用非官方消费者服务，建议仅在本机或可信私有网络中使用。
