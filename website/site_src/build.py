#!/usr/bin/env python3
"""Build the bilingual pi2web static site into ../public."""

from pathlib import Path
import shutil

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
PUBLIC = PROJECT_ROOT / "public"
TEMPLATES = ROOT / "templates"
ASSETS = ROOT / "assets"
BASE_URL = "https://pi2web.es2q.com"

PAGES = {
    "home": {
        "slug": "",
        "modified": "2026-07-25",
        "zh": {
            "title": "pi2web — 用浏览器和 Android 手机远程操作 Pi Coding Agent",
            "description": "pi2web 在开发机上运行 Pi Coding Agent，并通过配对码保护的 HTTP/WebSocket 服务提供 Web UI、Android 客户端、终端、语音播报和邮件通知。npm install -g pi2web 即可启动。",
        },
        "en": {
            "title": "pi2web — Run Pi Coding Agent remotely from your browser or Android phone",
            "description": "pi2web runs Pi Coding Agent on your dev machine and exposes a pairing-code protected HTTP/WebSocket service with a web UI, Android client, terminals, voice summaries, and email notifications.",
        },
    },
    "features": {
        "slug": "features",
        "modified": "2026-07-25",
        "zh": {
            "title": "产品能力 — pi2web 远程 Pi Agent 服务器",
            "description": "了解 pi2web 的 Web UI、Terminal、Workspace 文件浏览、Session 管理、配对码鉴权与限流、语音摘要、邮件通知、SQLite 持久化和 Android 原生客户端。",
        },
        "en": {
            "title": "Features — pi2web remote Pi Agent server",
            "description": "Explore the pi2web web UI, terminals, workspace file browsing, session management, pairing-code auth, voice summaries, email notifications, SQLite persistence, and Android client.",
        },
    },
    "blog": {
        "slug": "blog",
        "modified": "2026-07-25",
        "zh": {
            "title": "pi2web 使用指南与文档",
            "description": "pi2web 中文指南：安装配置、Web UI 使用、安全远程访问、语音摘要与语音输入、Agent 完成邮件通知，以及 Android 客户端构建。",
        },
        "en": {
            "title": "pi2web guides and documentation",
            "description": "Practical pi2web guides: installation and configuration, using the web UI, secure remote access, voice summaries and speech input, email notifications, and the Android client.",
        },
    },
    "blog_setup": {
        "slug": "blog/install-and-configure",
        "article": True,
        "published": "2026-07-25",
        "zh": {
            "title": "pi2web 安装与配置指南",
            "description": "从 npm install -g pi2web 开始，完整配置 pi2web：命令行选项、配对码、数据目录、Workspace、Terminal、邮件与语音开关、反向代理与故障排查。",
        },
        "en": {
            "title": "Install and configure pi2web",
            "description": "Configure pi2web end to end: npm installation, CLI options, pairing code, data directory, workspaces, terminals, email and voice switches, reverse proxy, and troubleshooting.",
        },
    },
    "blog_webui": {
        "slug": "blog/web-ui",
        "article": True,
        "published": "2026-07-25",
        "zh": {
            "title": "pi2web Web UI 使用说明",
            "description": "在浏览器中创建 Workspace 与 Agent、发送 Prompt 与 steer、使用 Terminal、@ 引用文件、切换模型与 Thinking level、Fork/Undo 与 Compact。",
        },
        "en": {
            "title": "Using the pi2web web UI",
            "description": "Create workspaces and agents in the browser, send prompts and steer, use terminals, reference files with @, switch models and thinking levels, fork/undo, and compact.",
        },
    },
    "blog_remote": {
        "slug": "blog/remote-access",
        "article": True,
        "published": "2026-07-25",
        "zh": {
            "title": "安全地远程访问 pi2web：SSH 隧道、Tailscale 与 HTTPS 反代",
            "description": "pi2web 的威胁模型、配对码与限流机制，以及使用 SSH 端口转发、Tailscale、devtunnel 或 nginx HTTPS 反向代理安全暴露服务的方法。",
        },
        "en": {
            "title": "Access pi2web securely: SSH tunnels, Tailscale, and HTTPS reverse proxies",
            "description": "Understand the pi2web threat model, pairing code and rate limiting, and how to expose the service safely through SSH forwarding, Tailscale, devtunnel, or an nginx HTTPS proxy.",
        },
    },
    "blog_voice": {
        "slug": "blog/voice",
        "article": True,
        "published": "2026-07-25",
        "zh": {
            "title": "配置 pi2web 的语音摘要与语音输入",
            "description": "为 pi2web 配置摘要 LLM 与 OpenAI 兼容语音服务：Speaches 全功能方案、Edge TTS 轻量方案、命令行参数、播报队列与常见问题。",
        },
        "en": {
            "title": "Configure voice summaries and speech input in pi2web",
            "description": "Connect a summary LLM and an OpenAI-compatible speech service to pi2web: the full Speaches setup, the lightweight Edge TTS server, CLI flags, playback queueing, and troubleshooting.",
        },
    },
    "blog_mail": {
        "slug": "blog/mail-notifications",
        "article": True,
        "published": "2026-07-25",
        "zh": {
            "title": "配置 pi2web 的 Agent 完成邮件通知",
            "description": "通过 MailDispatch 在 Agent 任务结束时收到邮件：命令行参数、API key 环境变量、聚合等待时间、正文内容开关与失败排查。",
        },
        "en": {
            "title": "Configure email notifications for finished pi2web agents",
            "description": "Send transactional email through MailDispatch when an agent settles: CLI flags, API key environment variables, aggregation window, body options, and failure handling.",
        },
    },
    "blog_android": {
        "slug": "blog/android-client",
        "article": True,
        "published": "2026-07-25",
        "zh": {
            "title": "pi2web Android 客户端：构建与连接",
            "description": "构建 Kotlin + Jetpack Compose 的 pi2web Android 客户端，配置服务地址与配对码，并了解与 Web UI 的能力差异。",
        },
        "en": {
            "title": "The pi2web Android client: build and connect",
            "description": "Build the Kotlin + Jetpack Compose pi2web Android client, configure the server address and pairing code, and compare it with the web UI.",
        },
    },
    "faq": {
        "slug": "faq",
        "modified": "2026-07-25",
        "faq": True,
        "zh": {
            "title": "常见问题 — pi2web",
            "description": "关于 pi2web 的常见问题：配对码丢失怎么办、可以暴露到公网吗、是否需要 Pi 订阅、数据保存在哪里、支持哪些平台、如何升级和卸载。",
        },
        "en": {
            "title": "FAQ — pi2web",
            "description": "Common pi2web questions: lost pairing codes, public exposure, Pi requirements, where data is stored, supported platforms, upgrading, and uninstalling.",
        },
    },
    "privacy": {
        "slug": "privacy",
        "modified": "2026-07-25",
        "zh": {
            "title": "隐私与数据说明 — pi2web",
            "description": "pi2web 处理哪些数据：Session 与元数据全部保存在你自己的机器上，本站点为纯静态页面，不收集表单或账号信息。",
        },
        "en": {
            "title": "Privacy and data handling — pi2web",
            "description": "What data pi2web touches: sessions and metadata stay on your own machine, and this website is fully static with no forms or accounts.",
        },
    },
}

FAQ_ITEMS = {
    "zh": [
        ("pi2web 是什么？", "pi2web 是一个在开发机上运行 Pi Coding Agent 的服务器。它通过受配对码保护的 HTTP/WebSocket API 提供 Web UI 和 Android 原生客户端，让你用浏览器或手机继续同一个编码会话。"),
        ("怎样安装 pi2web？", "需要 Node.js 20.10 或更高版本，执行 npm install -g pi2web，然后运行 pi2web，默认监听 http://127.0.0.1:11318。"),
        ("配对码在哪里？丢失了怎么办？", "服务首次启动时在终端显示一次配对码，服务端只保存 SHA-256 hash。忘记后无法找回，可运行 pi2web --rotate-access-token 生成新的配对码，旧配对码立即失效。"),
        ("可以把 pi2web 直接暴露到公网吗？", "不建议。Terminal 是以服务进程用户身份运行的完整 Shell，获得配对码等于获得该用户的 Shell 权限。请使用 SSH 隧道、Tailscale、devtunnel 或配置 HTTPS 与访问控制的可信反向代理。"),
        ("pi2web 会提供模型或额度吗？", "不会。pi2web 只是 Pi Coding Agent 的远程外壳，模型配置、Provider 认证和额度全部复用本机 ~/.pi/agent 中的 Pi 设置。"),
        ("数据保存在什么地方？", "服务端元数据保存在 ~/.pi/remote-pi/remote-pi.db（SQLite），完整对话由 Pi 的 SessionManager 以 JSONL 保存在 ~/.pi/agent/sessions/ 下。pi2web 不会把会话上传到任何第三方。"),
        ("支持哪些平台？", "服务端支持 Linux、macOS 和 Windows 上的 Node.js 20.10+。客户端支持现代浏览器，以及仓库中的 Kotlin + Jetpack Compose Android 应用。"),
        ("语音播报和邮件通知是必须的吗？", "不是。两者默认关闭：只有配置 --voice-base-url 才启用语音，只有同时配置 MailDispatch endpoint、API key 环境变量和收件人才启用邮件通知。"),
    ],
    "en": [
        ("What is pi2web?", "pi2web is a server that runs Pi Coding Agent on your development machine and exposes it through a pairing-code protected HTTP/WebSocket API, so a browser or the Android app can drive the same coding session."),
        ("How do I install pi2web?", "Node.js 20.10 or newer is required. Run npm install -g pi2web, then run pi2web; it listens on http://127.0.0.1:11318 by default."),
        ("Where is the pairing code, and what if I lose it?", "The pairing code is printed once on first startup and only its SHA-256 hash is stored. It cannot be recovered; run pi2web --rotate-access-token to issue a new one and invalidate the old code immediately."),
        ("Can I expose pi2web directly to the internet?", "Not recommended. Terminals are full host shells running as the service user, so anyone with the pairing code effectively has shell access. Use an SSH tunnel, Tailscale, devtunnel, or a trusted HTTPS reverse proxy with access control."),
        ("Does pi2web provide models or credits?", "No. pi2web is only a remote shell around Pi Coding Agent; model configuration, provider authentication, and quota all come from your local ~/.pi/agent Pi settings."),
        ("Where is my data stored?", "Server metadata lives in ~/.pi/remote-pi/remote-pi.db (SQLite) and full conversations are stored as JSONL by the Pi SessionManager under ~/.pi/agent/sessions/. pi2web never uploads sessions to a third party."),
        ("Which platforms are supported?", "The server runs on Node.js 20.10+ on Linux, macOS, and Windows. Clients include modern browsers and the Kotlin + Jetpack Compose Android app in the repository."),
        ("Are voice and email notifications required?", "No. Both are off by default: voice is enabled only when --voice-base-url is set, and email requires the MailDispatch endpoint, API key environment variable, and recipient to be configured together."),
    ],
}

NAV = {
    "zh": {
        "features": "产品能力",
        "blog": "使用指南",
        "faq": "常见问题",
        "github": "GitHub",
        "language": "EN",
        "language_label": "Switch to English",
        "skip": "跳到主要内容",
        "footer_tagline": "在你自己的机器上运行 Pi Coding Agent，用浏览器和 Android 手机安全地远程操作。",
        "footer_note": "pi2web 不提供任何 LLM、推理服务或模型额度。模型、Provider 认证和用量全部来自你本机的 Pi 配置。",
        "privacy": "隐私说明",
        "rights": "MIT License · 独立开源项目",
        "trademark": "与 Pi、GitHub、Google 及其他相关厂商不存在隶属或背书关系；相关商标归各自所有者。",
    },
    "en": {
        "features": "Features",
        "blog": "Guides",
        "faq": "FAQ",
        "github": "GitHub",
        "language": "中文",
        "language_label": "切换到中文",
        "skip": "Skip to content",
        "footer_tagline": "Run Pi Coding Agent on your own machine and drive it safely from a browser or an Android phone.",
        "footer_note": "pi2web does not provide any LLM, inference service, or model quota. Models, provider authentication, and usage all come from your local Pi configuration.",
        "privacy": "Privacy",
        "rights": "MIT License · Independent open-source project",
        "trademark": "Not affiliated with or endorsed by Pi, GitHub, Google, or other referenced vendors. Trademarks belong to their respective owners.",
    },
}


def page_url(lang: str, slug: str) -> str:
    suffix = f"{slug}/" if slug else ""
    return f"{BASE_URL}/{lang}/{suffix}"


def build() -> None:
    if PUBLIC.exists():
        shutil.rmtree(PUBLIC)
    PUBLIC.mkdir(parents=True)

    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES)),
        autoescape=select_autoescape(["html", "xml"]),
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )

    for page_name, page in PAGES.items():
        slug = page["slug"]
        for lang in ("zh", "en"):
            other_lang = "en" if lang == "zh" else "zh"
            output_dir = PUBLIC / lang / slug
            output_dir.mkdir(parents=True, exist_ok=True)
            template = env.get_template(f"pages/{lang}/{page_name}.html")
            html = template.render(
                lang=lang,
                html_lang="zh-CN" if lang == "zh" else "en",
                page=page_name,
                meta=page[lang],
                nav=NAV[lang],
                base_url=BASE_URL,
                canonical=page_url(lang, slug),
                alternate=page_url(other_lang, slug),
                alternate_lang="en" if lang == "zh" else "zh-CN",
                x_default=page_url("en", slug),
                language_url=f"/{other_lang}/{slug + '/' if slug else ''}",
                noindex=page.get("noindex", False),
                is_article=page.get("article", False),
                is_faq=page.get("faq", False),
                faq_items=FAQ_ITEMS[lang],
                is_home=page_name == "home",
                published=page.get("published"),
                modified=page.get("modified", page.get("published")),
                blog_url=page_url(lang, "blog"),
            )
            (output_dir / "index.html").write_text(html, encoding="utf-8")

    shutil.copytree(ASSETS, PUBLIC / "assets")
    shutil.copy2(ROOT / "static" / "index.html", PUBLIC / "index.html")
    shutil.copy2(ROOT / "static" / "robots.txt", PUBLIC / "robots.txt")

    sitemap_entries = []
    for page in PAGES.values():
        if page.get("noindex"):
            continue
        slug = page["slug"]
        zh_url = page_url("zh", slug)
        en_url = page_url("en", slug)
        lastmod_date = page.get("modified", page.get("published"))
        lastmod = f"<lastmod>{lastmod_date}</lastmod>" if lastmod_date else ""
        alternates = (
            f'<xhtml:link rel="alternate" hreflang="zh-CN" href="{zh_url}"/>'
            f'<xhtml:link rel="alternate" hreflang="en" href="{en_url}"/>'
            f'<xhtml:link rel="alternate" hreflang="x-default" href="{en_url}"/>'
        )
        for loc in (zh_url, en_url):
            sitemap_entries.append(f"  <url><loc>{loc}</loc>{lastmod}{alternates}</url>")
    sitemap = "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        *sitemap_entries,
        "</urlset>",
        "",
    ])
    (PUBLIC / "sitemap.xml").write_text(sitemap, encoding="utf-8")

    print(f"Built {len(PAGES) * 2} pages in {PUBLIC}")


if __name__ == "__main__":
    build()
