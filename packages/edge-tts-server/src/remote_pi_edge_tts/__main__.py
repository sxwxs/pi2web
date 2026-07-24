from __future__ import annotations

import argparse
import asyncio
import os
from typing import Any

import edge_tts
from aiohttp import web


def error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": {"message": message}}, status=status)


def create_app(default_voice: str, max_chars: int) -> web.Application:
    app = web.Application(client_max_size=256 * 1024)
    app["default_voice"] = default_voice
    app["max_chars"] = max_chars

    async def health(_: web.Request) -> web.Response:
        return web.json_response({"status": "ok", "service": "remote-pi-edge-tts"})

    async def voices(_: web.Request) -> web.Response:
        values = await edge_tts.list_voices()
        return web.json_response({"data": values})

    async def speech(request: web.Request) -> web.StreamResponse:
        try:
            body: dict[str, Any] = await request.json()
        except Exception:
            return error("Request body must be valid JSON")
        text = body.get("input")
        if not isinstance(text, str) or not text.strip():
            return error("input must be a non-empty string")
        if len(text) > request.app["max_chars"]:
            return error(f"input exceeds {request.app['max_chars']} characters", 413)
        response_format = str(body.get("response_format", "mp3")).lower()
        if response_format not in {"mp3", "mpeg"}:
            return error("Only response_format=mp3 is supported")
        voice = str(body.get("voice") or request.app["default_voice"])
        rate = str(body.get("rate", "+0%"))
        volume = str(body.get("volume", "+0%"))
        pitch = str(body.get("pitch", "+0Hz"))
        try:
            communicate = edge_tts.Communicate(text.strip(), voice, rate=rate, volume=volume, pitch=pitch)
            chunks: list[bytes] = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    chunks.append(chunk["data"])
            audio = b"".join(chunks)
            if not audio:
                return error("Edge TTS returned no audio", 502)
            return web.Response(body=audio, headers={"Content-Type": "audio/mpeg", "Cache-Control": "no-store"})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return error(f"Edge TTS failed: {exc}", 502)

    app.router.add_get("/health", health)
    app.router.add_get("/v1/voices", voices)
    app.router.add_post("/v1/audio/speech", speech)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenAI-compatible Edge TTS server for Remote Pi")
    parser.add_argument("--host", default=os.environ.get("EDGE_TTS_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("EDGE_TTS_PORT", "5050")))
    parser.add_argument("--voice", default=os.environ.get("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural"))
    parser.add_argument("--max-chars", type=int, default=int(os.environ.get("EDGE_TTS_MAX_CHARS", "5000")))
    args = parser.parse_args()
    web.run_app(create_app(args.voice, args.max_chars), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
