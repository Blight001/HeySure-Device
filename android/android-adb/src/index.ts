import 'dotenv/config'
import * as adb from './adb'
import { login } from './server-api'
import { AdbAgent, AgentConfig } from './agent'

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString()
  console.log(`[${ts}] ${msg}`)
}

async function main(): Promise<void> {
  const serverUrl = process.env.HEYSURE_SERVER_URL || ''
  const account = process.env.HEYSURE_ACCOUNT || ''
  const password = process.env.HEYSURE_PASSWORD || ''
  if (!serverUrl || !account || !password) {
    log('请在 .env 配置 HEYSURE_SERVER_URL / HEYSURE_ACCOUNT / HEYSURE_PASSWORD（参考 .env.example）')
    process.exit(1)
  }

  // 1) Pick the phone to drive.
  const serial = await adb.resolveSerial(process.env.ANDROID_SERIAL || '')
  const model = await adb.deviceModel({ serial }).catch(() => 'Android')
  const size = await adb.screenSize({ serial }).catch(() => ({ width: 0, height: 0 }))
  log(`目标设备: ${serial}（${model}, ${size.width}x${size.height}）`)

  // 2) Authenticate, exactly like the app's login.
  const auth = await login(serverUrl, account, password)
  log(`登录成功: ${auth.userName}`)

  const cfg: AgentConfig = {
    agentSocketUrl: auth.agentSocketUrl,
    authToken: auth.accessToken,
    userId: auth.userId,
    deviceId: `android-adb-${serial.replace(/[^a-zA-Z0-9]/g, '-')}`,
    agentName: process.env.HEYSURE_AGENT_NAME || `安卓设备 (ADB-${model})`,
    serial,
    model,
  }

  // 3) Connect + register; the rest is event-driven.
  const agent = new AdbAgent(cfg, log)
  agent.connect()

  const shutdown = () => { log('退出…'); agent.disconnect(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  log(`启动失败: ${err?.message || err}`)
  process.exit(1)
})
