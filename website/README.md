# pi2web 产品站点 / Product website

面向 <https://pi2web.es2q.com> 的双语（中文 / English）静态站点。没有后端、表单或第三方脚本，构建产物就是 `public/`。

## 结构

```
website/
├── site_src/            # 站点源码
│   ├── build.py         # Jinja2 构建脚本（页面元数据、hreflang、sitemap）
│   ├── templates/
│   │   ├── base.html         # 布局、SEO meta、JSON-LD
│   │   ├── blog_article.html # 指南文章布局
│   │   └── pages/{zh,en}/    # 每种语言的页面
│   ├── assets/          # CSS / JS / 图标，直接复制到 public/assets
│   ├── static/          # 根 index.html（语言选择）与 robots.txt
│   └── requirements.txt # Jinja2
├── nginx/               # 生产环境 nginx 配置与安全响应头
├── public/              # 构建产物（提交到仓库，便于直接部署）
└── Makefile
```

## 构建

```bash
cd website
python3 -m pip install -r site_src/requirements.txt
make build      # 输出到 public/
make serve      # 构建后在 http://127.0.0.1:8080 预览
```

## 页面

| 路径 | 说明 |
| --- | --- |
| `/zh/`、`/en/` | 首页 |
| `/{lang}/features/` | 产品能力 |
| `/{lang}/blog/` | 指南索引 |
| `/{lang}/blog/install-and-configure/` | **安装与配置指南**（核心配置文档） |
| `/{lang}/blog/web-ui/` | Web UI 使用说明 |
| `/{lang}/blog/remote-access/` | 安全远程访问 |
| `/{lang}/blog/voice/` | 语音摘要与语音输入 |
| `/{lang}/blog/mail-notifications/` | Agent 完成邮件通知 |
| `/{lang}/blog/android-client/` | Android 客户端 |
| `/{lang}/faq/` | 常见问题（含 FAQPage 结构化数据） |
| `/{lang}/privacy/` | 隐私与数据说明 |

## SEO

- 每个页面都有唯一 title / description、canonical、`hreflang`（zh-CN / en / x-default）。
- Open Graph 与 Twitter Card，OG 图为 `/assets/icons/og-cover.svg`。
- JSON-LD：首页 `SoftwareApplication`，指南 `TechArticle` + `BreadcrumbList`，FAQ 页 `FAQPage`，其余 `WebPage`。
- 自动生成 `sitemap.xml`（含 `lastmod` 与语言 alternate）与 `robots.txt`。
- 根路径由 nginx 按 `Accept-Language` 302 到 `/zh/` 或 `/en/`，同时保留静态 `index.html` 作为兜底（noindex）。

新增页面时在 `site_src/build.py` 的 `PAGES` 中登记 slug 与两种语言的 title/description，并在 `templates/pages/zh|en/` 下创建同名模板，sitemap 会自动更新。

## 部署

```bash
rsync -av --delete public/ server:/srv/pi2web-website/public/
scp nginx/security-headers.conf server:/etc/nginx/snippets/pi2web-site-security-headers.conf
scp nginx/pi2web.es2q.com.conf server:/etc/nginx/sites-available/
# 记得把 nginx/pi2web.es2q.com.conf 顶部的 map 指令放进 http {} 上下文
```
