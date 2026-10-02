#!/usr/bin/env node
/**
 * 自动截图脚本（用来自动产出博客"成品展示"里的截图）。
 *
 * 原理：无头 Edge 以 --remote-debugging-port 启动后开放 DevTools 协议（CDP），
 * 本脚本通过 WebSocket 连接它，做三件事：
 *   1) Page.navigate 打开页面、Emulation.setDeviceMetricsOverride 设置视口与缩放；
 *   2) Runtime.evaluate 在页面里点击虚拟键盘 / 输入表达式（模拟真实操作）；
 *   3) Page.captureScreenshot 截图并保存成 PNG。
 *
 * 用法（无头浏览器由 run-capture.ps1 负责拉起，前后端服务需要已经在跑）：
 *   node capture-screenshots.mjs                      # 跑全部
 *   node capture-screenshots.mjs home-empty decimal   # 只跑指定几张
 *
 * 环境变量：
 *   CDP_PORT=9225   FRONTEND_URL=http://127.0.0.1:4173/   BACKEND_DOCS_URL=http://127.0.0.1:8000/docs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MiniWebSocket } from './mini-websocket.mjs'

const CDP_PORT = process.env.CDP_PORT || '9225'
const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://127.0.0.1:4173/'
const BACKEND_DOCS_URL = process.env.BACKEND_DOCS_URL || 'http://127.0.0.1:8000/docs'
const IMAGES_DIR = fileURLToPath(new URL('../images/', import.meta.url))

const DESKTOP = { width: 1440, height: 1150, deviceScaleFactor: 2, mobile: false }
const MOBILE = { width: 430, height: 932, deviceScaleFactor: 2, mobile: true }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 注入到页面里的操作助手：只做"点击"和"改字符串"，不参与任何计算 */
const PAGE_HELPERS = `
(() => {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  function setInputValue(selector, text) {
    const input = document.querySelector(selector);
    if (!input) throw new Error('input not found: ' + selector);
    nativeValueSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  }

  window.__t = {
    key(label) {
      const button = [...document.querySelectorAll('.keypad .key')]
        .find((node) => node.textContent.trim() === label);
      if (!button) throw new Error('key not found: ' + label);
      button.click();
      return true;
    },
    keys(labels) {
      labels.forEach((label) => window.__t.key(label));
      return true;
    },
    type(text) {
      return setInputValue('.display__input', text);
    },
    search(text) {
      return setInputValue('.history__search-input', text);
    },
    theme() {
      document.querySelector('.theme-toggle').click();
      return true;
    },
    clickButtonByText(text) {
      const button = [...document.querySelectorAll('button')]
        .find((node) => node.textContent.trim().includes(text));
      if (!button) throw new Error('button not found: ' + text);
      button.click();
      return true;
    },
    state() {
      const resultNode = document.querySelector('.display__result');
      const errorNode = document.querySelector('.display__error');
      return {
        expression: (document.querySelector('.display__input') || {}).value || '',
        result: resultNode ? resultNode.textContent.trim() : '',
        error: errorNode ? errorNode.textContent.trim() : '',
        pending: !!document.querySelector('.display__result--pending'),
        historyCount: document.querySelectorAll('.history-item').length,
        backendStatus: (document.querySelector('.status-pill span:nth-child(2)') || {}).textContent || '',
        toasts: [...document.querySelectorAll('.toast')].map((node) => node.textContent.trim()),
      };
    },
  };
  return true;
})()
`

class DevtoolsSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.on('message', (text) => {
      const message = JSON.parse(text)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`))
      else entry.resolve(message.result)
    })
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 40000)
    })
  }

  async evaluate(expression) {
    const outcome = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (outcome.exceptionDetails) {
      const description =
        outcome.exceptionDetails.exception?.description || outcome.exceptionDetails.text
      throw new Error(`page error: ${description}`)
    }
    return outcome.result.value
  }

  async waitFor(expression, { timeout = 12000, interval = 120, label = expression } = {}) {
    const deadline = Date.now() + timeout
    for (;;) {
      if (await this.evaluate(expression)) return true
      if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`)
      await sleep(interval)
    }
  }
}

async function connect() {
  const response = await fetch(`${CDP_HTTP}/json/list`)
  const targets = await response.json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('没有找到可用的 page target，浏览器是否以 --remote-debugging-port 启动？')

  const socket = new MiniWebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.on('open', resolve)
    socket.on('error', reject)
  })
  return new DevtoolsSession(socket)
}

async function main() {
  await mkdir(IMAGES_DIR, { recursive: true })
  const requested = process.argv.slice(2).filter((item) => !item.startsWith('--'))

  const session = await connect()

  await session.send('Page.enable')
  await session.send('Runtime.enable')

  async function setViewport({ width, height, deviceScaleFactor, mobile }) {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    })
  }

  async function shot(name, { beyond = false } = {}) {
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: beyond,
    })
    const file = path.join(IMAGES_DIR, `${name}.png`)
    await writeFile(file, Buffer.from(data, 'base64'))
    console.log(`  ✓ ${name}.png`)
  }

  async function gotoApp({ waitForSelector = '.keypad' } = {}) {
    await session.send('Page.navigate', { url: FRONTEND_URL })
    await session.waitFor(
      `document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(waitForSelector)})`,
      { label: `app ready (${waitForSelector})` },
    )
    await session.evaluate(PAGE_HELPERS)
    await sleep(500)
  }

  /** 点击 = 并等待后端返回（结果或错误） */
  async function submit() {
    await session.evaluate(`window.__t.key('=')`)
    await session.waitFor(
      `(() => { const s = window.__t.state(); return !s.pending && (!!s.error || !!s.result); })()`,
      { label: 'backend result' },
    )
  }

  /** 用虚拟键盘敲一串按键并提交 */
  async function calcByKeys(labels) {
    await session.evaluate(`window.__t.keys(${JSON.stringify(labels)})`)
    await sleep(120)
    await submit()
    await sleep(3400) // 等右下角提示自己消失，截图更干净
  }

  /** 直接写入表达式（模拟键盘录入，含空格等键盘区没有的字符）并提交 */
  async function calcByTyping(text) {
    await session.evaluate(`window.__t.type(${JSON.stringify(text)})`)
    await sleep(120)
    await submit()
    await sleep(3400)
  }

  const routines = {
    // ---------------------------------------------------------- 首页与基础功能
    'home-empty': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await shot('01-home-empty')
    },

    'basic-expression': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByKeys(['3', '×', '(', '2', '+', '5', ')', '−', '4', '÷', '2'])
      await shot('02-basic-expression')
    },

    'operator-priority': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByKeys(['2', '+', '3', '×', '4', '−', '6', '÷', '3'])
      await shot('03-operator-priority')
    },

    'nested-parentheses': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByKeys(['(', '(', '2', '+', '3', ')', '×', '(', '4', '−', '1', ')', ')', '÷', '5'])
      await shot('04-nested-parentheses')
    },

    decimal: async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByKeys(['0', '.', '1', '+', '0', '.', '2'])
      await shot('05-decimal')
    },

    'unary-minus': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByKeys(['3', '×', '−', '2'])
      await shot('06-unary-minus')
    },

    'unary-space': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByTyping('- 5')
      await shot('07-unary-with-space')
    },

    'power-modulo': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByTyping('7 % 3')
      await calcByTyping('2 ^ 10')
      await shot('08-power-modulo')
    },

    // ---------------------------------------------------------- 历史记录
    'history-list': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await session.waitFor(`window.__t.state().historyCount >= 5`, { label: 'history loaded' })
      await shot('09-history-list')
    },

    'history-search': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await session.waitFor(`window.__t.state().historyCount >= 5`, { label: 'history loaded' })
      await session.evaluate(`window.__t.search('2')`)
      await sleep(900)
      await shot('10-history-search')
    },

    'history-delete': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await session.waitFor(`window.__t.state().historyCount >= 5`, { label: 'history loaded' })
      await session.evaluate(`window.__t.clickButtonByText('删除')`)
      await sleep(500)
      await shot('11-history-delete-confirm')
      await session.evaluate(`window.__t.clickButtonByText('确认删除')`)
      await session.waitFor(`window.__t.state().toasts.length > 0`, { label: 'delete toast' })
      await sleep(600)
      await shot('12-history-deleted-toast')
    },

    'dark-theme': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await session.evaluate(`window.__t.theme()`)
      await sleep(700)
      await shot('13-dark-theme')
    },

    // ---------------------------------------------------------- 异常处理
    'error-division-by-zero': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByKeys(['1', '÷', '0'])
      await shot('14-error-division-by-zero')
    },

    'error-illegal-character': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByTyping('abc+1')
      await shot('15-error-illegal-character')
    },

    'error-syntax': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await calcByKeys(['3', '+'])
      await shot('16-error-syntax')
    },

    // ---------------------------------------------------------- 持久化与响应式
    'persist-after-reload': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await session.waitFor(`window.__t.state().historyCount >= 5`, { label: 'history loaded' })
      await gotoApp() // 再刷新一次，历史仍然来自后端数据库
      await session.waitFor(`window.__t.state().historyCount >= 5`, { label: 'history after reload' })
      await shot('17-persist-after-reload')
    },

    'mobile-layout': async () => {
      await setViewport(MOBILE)
      await gotoApp()
      await session.waitFor(`window.__t.state().historyCount >= 3`, { label: 'history loaded' })
      await shot('18-mobile-layout', { beyond: true })
      await session.send('Emulation.clearDeviceMetricsOverride')
    },

    // ---------------------------------------------------------- 后端离线（需先停掉后端）
    'backend-offline': async () => {
      await setViewport(DESKTOP)
      await gotoApp()
      await session.waitFor(
        `window.__t.state().backendStatus.includes('离线')`,
        { label: 'backend offline pill', timeout: 20000 },
      )
      await session.evaluate(`window.__t.type('1+1')`)
      await session.evaluate(`window.__t.key('=')`)
      await session.waitFor(`(() => { const s = window.__t.state(); return !!s.error; })()`, {
        label: 'offline error message',
        timeout: 25000,
      })
      await sleep(400)
      await shot('19-backend-offline')
    },

    // ---------------------------------------------------------- 接口文档
    'swagger-docs': async () => {
      await setViewport(DESKTOP)
      await session.send('Page.navigate', { url: BACKEND_DOCS_URL })
      await session.waitFor(`document.readyState === 'complete'`, { label: 'docs loaded' })
      await sleep(2500)
      await shot('20-swagger-api-docs')
    },
  }

  const names = requested.length > 0 ? requested : Object.keys(routines)
  for (const name of names) {
    const routine = routines[name]
    if (!routine) {
      console.warn(`  ! 跳过未知截图任务：${name}`)
      continue
    }
    console.log(`▶ ${name}`)
    await routine()
  }

  console.log(`\n完成，共处理 ${names.length} 个任务，输出目录：${IMAGES_DIR}`)
  process.exit(0)
}

main().catch((error) => {
  console.error('截图失败：', error.message)
  process.exit(1)
})
