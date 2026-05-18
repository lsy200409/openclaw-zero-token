#!/usr/bin/env python3
"""
Playwright-based browser control
Usage: python3 browser_control.py <command> [args...]
Commands:
  open <url>                     - 打开网页并打印标题
  screenshot <url> <output.png>  - 截图保存
  title <url>                    - 只打印网页标题
  eval <url> <js_code>           - 执行 JavaScript 代码
  click <url> <selector>         - 点击指定元素
  fill <url> <selector> <text>   - 填充输入框
  wait <url> <seconds>           - 等待几秒
  close                          - 关闭浏览器（空操作，用于兼容）
"""

import sys
import time
from playwright.sync_api import sync_playwright


def main():
    if len(sys.argv) < 2:
        print("Usage: browser_control.py <command> [args...]")
        sys.exit(1)

    cmd = sys.argv[1]

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path='/usr/bin/google-chrome',
            headless=True
        )
        page = browser.new_page()

        if cmd == "open":
            url = sys.argv[2]
            page.goto(url)
            print(f"Opened: {url}")
            print(f"Title: {page.title()}")

        elif cmd == "screenshot":
            url = sys.argv[2]
            output = sys.argv[3]
            page.goto(url)
            page.screenshot(path=output)
            print(f"Screenshot saved to {output}")

        elif cmd == "title":
            url = sys.argv[2]
            page.goto(url)
            print(page.title())

        elif cmd == "eval":
            url = sys.argv[2]
            js_code = sys.argv[3]
            page.goto(url)
            result = page.evaluate(js_code)
            print(result)

        elif cmd == "click":
            url = sys.argv[2]
            selector = sys.argv[3]
            page.goto(url)
            page.click(selector)
            print(f"Clicked element: {selector}")

        elif cmd == "fill":
            url = sys.argv[2]
            selector = sys.argv[3]
            text = sys.argv[4]
            page.goto(url)
            page.fill(selector, text)
            print(f"Filled {selector} with '{text}'")

        elif cmd == "wait":
            url = sys.argv[2]
            seconds = int(sys.argv[3])
            page.goto(url)
            time.sleep(seconds)
            print(f"Waited {seconds} seconds on {url}")

        elif cmd == "close":
            pass

        else:
            print(f"Unknown command: {cmd}")
            sys.exit(1)

        browser.close()


if __name__ == "__main__":
    main()
