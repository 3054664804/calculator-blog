# calculator-blog · 作业博客与截图素材

> 软件工程课程作业「前后端分离计算器系统」的**博客正文与成品截图**仓库。
> 代码仓库单独分开，保持整洁：
> * 后端代码 → <https://github.com/3054664804/calculator-backend>
> * 前端代码 → <https://github.com/3054664804/calculator-frontend>

## 为什么单独建这个仓库

1. **博客图片需要一个公网地址**：CSDN 等博客平台不认本地相对路径 `./images/xx.png`，
   把截图放在公开仓库里，就能用 CDN 外链（jsDelivr）引用，平台会自动转存到自己的图床。
2. **博客有在线备份**：Markdown 原文放在版本库里，改起来有记录、不怕本地误删。
3. **代码仓库保持干净**：评分看的是前后端两个代码仓库，不希望里面混入 13 MB 的截图。

## 目录内容

```
blog/
├── 前后端分离计算器系统-作业博客.md          # 博客正文（通用版，图片用相对路径）
├── 前后端分离计算器系统-作业博客-CSDN版.md    # 博客正文（CSDN 适配版：CDN 图片 + @[toc] 目录）
├── images/                                  # 20 张成品截图（01-home-empty.png ~ 20-swagger-api-docs.png）
└── scripts/                                 # 自动截图脚本（CDP 驱动无头浏览器）
    ├── run-capture.ps1
    ├── capture-screenshots.mjs
    ├── mini-websocket.mjs
    └── make-csdn-version.py                 # 由通用版生成 CSDN 适配版
```

## 截图外链格式

```
https://cdn.jsdelivr.net/gh/3054664804/calculator-blog@main/images/01-home-empty.png
```

同源备用地址（若 CDN 不可达）：

```
https://raw.githubusercontent.com/3054664804/calculator-blog/main/images/01-home-empty.png
```

## 20 张截图清单

| 文件 | 展示内容 |
| --- | --- |
| `01-home-empty.png` | 首页与空历史（默认深色主题） |
| `02-basic-expression.png` | `3×(2+5)−4÷2 = 19` |
| `03-operator-priority.png` | `2+3×4−6÷3 = 12` |
| `04-nested-parentheses.png` | `((2+3)×(4−1))÷5 = 3` |
| `05-decimal.png` | `0.1+0.2 = 0.3` |
| `06-unary-minus.png` | `3×−2 = −6` |
| `07-unary-with-space.png` | `- 5 = -5` |
| `08-power-modulo.png` | `7%3 = 1`、`2^10 = 1024` |
| `09-history-list.png` | 历史列表（最新在最前） |
| `10-history-search.png` | 关键字搜索历史 |
| `11-history-delete-confirm.png` | 删除两步确认 |
| `12-history-deleted-toast.png` | 删除成功提示与列表刷新 |
| `13-light-theme.png` | 浅色主题 |
| `14-error-division-by-zero.png` | 除零错误（不写库） |
| `15-error-illegal-character.png` | 非法字符错误 |
| `16-error-syntax.png` | 语法错误 |
| `17-persist-after-reload.png` | 刷新后历史仍在 |
| `18-mobile-layout.png` | 移动端单栏布局 |
| `19-backend-offline.png` | 关闭后端后前端算不出结果 |
| `20-swagger-api-docs.png` | Swagger 接口文档 |

## 重新生成 CSDN 适配版

```bash
cd blog
python scripts/make-csdn-version.py
```

脚本会：把图片路径换成 CDN 外链、把手写目录换成 CSDN 的 `@[toc]`、去掉平台可能不支持的锚点跳转。

---

最后更新：2026-10-02
