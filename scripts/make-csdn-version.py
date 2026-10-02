"""把通用版博客转换成 CSDN 适配版。

CSDN 与本地 / GitHub 的差异，这个脚本处理三件事：

1. **图片路径**：CSDN 不认 `./images/xx.png` 这种相对路径，必须换成公网地址。
   这里换成 jsDelivr 的 GitHub CDN 外链（国内可达性比 raw.githubusercontent 好），
   CSDN 编辑器粘贴后会把这些外链图片自动转存到它自己的图床。

2. **站内锚点跳转**：原文用 `<a id="sec-1">` + `[文字](#sec-1)` 实现章节跳转，
   但 CSDN 会过滤部分内联 HTML，锚点可能失效。这里统一去掉跳转语法、保留文字，
   并在开头插入 CSDN 自带的 `@[toc](目录)` 自动生成目录。

3. **锚点标签本身**：删除残留的 `<a id="..."></a>` 行，避免在正文里显示异常。

用法（在 blog 目录下执行）：
    python scripts/make-csdn-version.py
"""

from __future__ import annotations

import re
from pathlib import Path

BLOG_DIR = Path(__file__).resolve().parents[1]
SOURCE = BLOG_DIR / "前后端分离计算器系统-作业博客.md"
TARGET = BLOG_DIR / "前后端分离计算器系统-作业博客-CSDN版.md"

CDN_PREFIX = "https://cdn.jsdelivr.net/gh/3054664804/calculator-blog@main/images/"

# 章节跳转链接：[图 3-2](#fig-2) / [第五节](#sec-5) → 图 3-2 / 第五节
ANCHOR_LINK = re.compile(r"\[([^\]]+)\]\(#(?:sec|fig|toc)[^)]*\)")
# 锚点标签行：<a id="sec-1"></a>
ANCHOR_TAG = re.compile(r'^<a id="[^"]+"></a>\s*$', re.MULTILINE)
# 手写目录：从 "## 目录" 到第一个分隔线之前
MANUAL_TOC = re.compile(r"## 目录\n.*?\n---\n", re.DOTALL)


def build_csdn_version(text: str) -> str:
    text = text.replace("](./images/", f"]({CDN_PREFIX}")
    text = ANCHOR_LINK.sub(r"\1", text)
    text = ANCHOR_TAG.sub("", text)
    text = MANUAL_TOC.sub(
        "## 目录\n\n"
        "> CSDN 会自动根据标题生成目录，见下方（若未显示，刷新或重新打开编辑器即可）。\n\n"
        "@[toc](目录)\n\n"
        "---\n",
        text,
        count=1,
    )

    banner = (
        "> **发布说明（本段发布时请删除）**\n"
        ">\n"
        "> 1. 本文为 CSDN 适配版：图片使用 CDN 外链，粘贴后 CSDN 会自动转存到你自己的图床；\n"
        ">    若某张图没显示出来，说明转存失败，用编辑器工具栏的「图片 → 上传」把\n"
        ">    `blog/images/` 里对应文件补传一次即可。\n"
        "> 2. 目录用 CSDN 的 `@[toc](目录)` 自动生成；系统架构图用 mermaid 代码块，\n"
        ">    CSDN 支持渲染；若不显示，可把 mermaid 代码块截图后替换。\n"
        "> 3. 发布前请把两处 `xxxx` 占位域名替换成真实部署地址。\n\n"
    )
    # 插到一级标题之后
    lines = text.split("\n", 1)
    return f"{lines[0]}\n\n{banner}{lines[1]}" if len(lines) == 2 else text


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"找不到源文件：{SOURCE}")

    text = SOURCE.read_text(encoding="utf-8")
    csdn_text = build_csdn_version(text)
    TARGET.write_text(csdn_text, encoding="utf-8")

    image_count = csdn_text.count(CDN_PREFIX)
    leftover_anchor = len(ANCHOR_TAG.findall(csdn_text))
    leftover_link = len(ANCHOR_LINK.findall(csdn_text))

    print(f"已生成：{TARGET.name}")
    print(f"  字符数            : {len(csdn_text)}")
    print(f"  替换为 CDN 的图片 : {image_count} 张")
    print(f"  残留锚点标签      : {leftover_anchor}")
    print(f"  残留跳转链接      : {leftover_link}")
    print(f"  含 @[toc] 自动目录: {'是' if '@[toc](目录)' in csdn_text else '否'}")


if __name__ == "__main__":
    main()
