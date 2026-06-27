import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import protobuf from 'protobufjs'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { z } from 'zod'

const DAY_MS = 24 * 60 * 60 * 1000
const RITHMIC_SYSTEM_INFO_TEMPLATE_ID = 16
const RITHMIC_LOGIN_TEMPLATE_ID = 10
const RITHMIC_LOGOUT_TEMPLATE_ID = 12
const RITHMIC_HEARTBEAT_TEMPLATE_ID = 18
const RITHMIC_TIME_BAR_REPLAY_TEMPLATE_ID = 202
const RITHMIC_TIME_BAR_REPLAY_RESPONSE_TEMPLATE_ID = 203
const RITHMIC_RESPONSE_TIMEOUT_MS = 20_000
const RITHMIC_CONNECT_POINT = 'wss://rituz00100.rithmic.com:443'
const RITHMIC_SYSTEM_NAME = 'Rithmic Test'
const RITHMIC_APP_NAME = 'PulseTrading'
const RITHMIC_APP_VERSION = '0.1.0'
const RITHMIC_LENGTH_PREFIXED_MESSAGES = false
const NQ_EXCHANGE = 'CME'
const NQ_SYMBOL = 'NQU6'

const RITHMIC_PROTO_FILES = [
  'message_type.proto',
  'request_heartbeat.proto',
  'response_heartbeat.proto',
  'request_rithmic_system_info.proto',
  'response_rithmic_system_info.proto',
  'request_login.proto',
  'response_login.proto',
  'request_logout.proto',
  'response_logout.proto',
  'request_time_bar_replay.proto',
  'response_time_bar_replay.proto',
  'time_bar.proto',
]

const NonEmptyStringSchema = z.string().trim().min(1)

const RithmicCredentialsSchema = z.object({
  password: NonEmptyStringSchema,
  userId: NonEmptyStringSchema,
})

type RithmicCredentials = z.infer<typeof RithmicCredentialsSchema>

type RithmicConfig = RithmicCredentials & {
  appName: string
  appVersion: string
  connectPoint: string
  exchange: string
  lengthPrefixedMessages: boolean
  requestTimeoutMs: number
  symbol: string
  systemName: string
}

type RithmicCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type DecodedMessage = {
  templateId?: number
  rpCode?: string[]
  rqHandlerRpCode?: string[]
  marker?: number
  openPrice?: number
  highPrice?: number
  lowPrice?: number
  closePrice?: number
  volume?: unknown
  systemName?: string[]
}

let rithmicRoot: protobuf.Root | null = null

function requireRithmicConfig() {
  const result = RithmicCredentialsSchema.safeParse({
    password: process.env.RITHMIC_PASSWORD,
    userId: process.env.RITHMIC_USER_ID,
  })

  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join('.'))
      .filter(Boolean)
      .join(', ')

    throw new Error(`Missing or invalid Rithmic configuration: ${fields}`)
  }

  return {
    appName: RITHMIC_APP_NAME,
    appVersion: RITHMIC_APP_VERSION,
    connectPoint: RITHMIC_CONNECT_POINT,
    exchange: NQ_EXCHANGE,
    lengthPrefixedMessages: RITHMIC_LENGTH_PREFIXED_MESSAGES,
    requestTimeoutMs: RITHMIC_RESPONSE_TIMEOUT_MS,
    symbol: NQ_SYMBOL,
    systemName: RITHMIC_SYSTEM_NAME,
    ...result.data,
  }
}

function resolveRithmicProtoDir() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.RITHMIC_PROTO_DIR,
    path.resolve(process.cwd(), 'r-protocol/proto'),
    path.resolve(process.cwd(), '../r-protocol/proto'),
    path.resolve(moduleDir, '../r-protocol/proto'),
    path.resolve(moduleDir, '../../r-protocol/proto'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  const protoDir = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'request_time_bar_replay.proto')),
  )

  if (!protoDir) {
    throw new Error(
      `Could not find r-protocol/proto. Set RITHMIC_PROTO_DIR to the local proto directory.`,
    )
  }

  return protoDir
}

function getRithmicRoot() {
  if (rithmicRoot) {
    return rithmicRoot
  }

  const protoDir = resolveRithmicProtoDir()
  const root = new protobuf.Root()
  root.resolvePath = (_, target) =>
    path.isAbsolute(target) ? target : path.join(protoDir, target)
  root.loadSync(RITHMIC_PROTO_FILES.map((file) => path.join(protoDir, file)))

  rithmicRoot = root
  return root
}

function toBuffer(data: RawData) {
  if (Buffer.isBuffer(data)) {
    return data
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }

  return Buffer.from(data)
}

function unwrapRithmicMessage(data: RawData) {
  const buffer = toBuffer(data)

  if (buffer.length > 4) {
    const framedLength = buffer.readInt32BE(0)

    if (framedLength === buffer.length - 4) {
      return buffer.subarray(4)
    }
  }

  return buffer
}

function maybeWrapRithmicMessage(buffer: Buffer, config: RithmicConfig) {
  if (!config.lengthPrefixedMessages) {
    return buffer
  }

  const frame = Buffer.alloc(4)
  frame.writeInt32BE(buffer.length)
  return Buffer.concat([frame, buffer])
}

function serializeMessage(
  root: protobuf.Root,
  typeName: string,
  value: Record<string, unknown>,
  config: RithmicConfig,
) {
  const messageType = root.lookupType(typeName)
  const serialized = messageType.encode(messageType.create(value)).finish()

  return maybeWrapRithmicMessage(Buffer.from(serialized), config)
}

function toNumber(value: unknown) {
  if (typeof value === 'number') {
    return value
  }

  if (typeof value === 'bigint') {
    return Number(value)
  }

  if (
    value &&
    typeof value === 'object' &&
    'toNumber' in value &&
    typeof value.toNumber === 'function'
  ) {
    return value.toNumber()
  }

  return Number(value)
}

function getFirstResponseCode(message: DecodedMessage) {
  const code = message.rpCode?.[0] ?? message.rqHandlerRpCode?.[0]
  return code && code.length > 0 ? code : undefined
}

function isDoneMessage(message: DecodedMessage) {
  return (
    (message.rqHandlerRpCode?.length ?? 0) === 0 &&
    (message.rpCode?.length ?? 0) > 0
  )
}

function isSuccessCode(code: string | undefined) {
  return code === undefined || code === '0'
}

function isValidCandle(candle: RithmicCandle) {
  return (
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.volume) &&
    candle.time > 0
  )
}

async function sendMessage(ws: WebSocket, buffer: Buffer) {
  await new Promise<void>((resolve, reject) => {
    ws.send(buffer, (err) => {
      if (err) {
        reject(err)
        return
      }

      resolve()
    })
  })
}

async function connectToRithmic(config: RithmicConfig) {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(config.connectPoint, {
      rejectUnauthorized: false,
    })

    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function readNextMessage(ws: WebSocket, timeoutMs: number) {
  return await new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for Rithmic after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('error', onError)
      ws.off('close', onClose)
    }

    const onMessage = (data: RawData) => {
      cleanup()
      resolve(unwrapRithmicMessage(data))
    }

    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }

    const onClose = () => {
      cleanup()
      reject(new Error('Rithmic websocket closed before response arrived'))
    }

    ws.once('message', onMessage)
    ws.once('error', onError)
    ws.once('close', onClose)
  })
}

async function loginToRithmic(
  ws: WebSocket,
  root: protobuf.Root,
  config: RithmicConfig,
) {
  const RequestLogin = root.lookupType('RequestLogin')
  const infraType = RequestLogin.lookupEnum('SysInfraType').values.HISTORY_PLANT
  const loginRequest = serializeMessage(
    root,
    'RequestLogin',
    {
      templateId: RITHMIC_LOGIN_TEMPLATE_ID,
      templateVersion: '3.9',
      userMsg: ['pulse-login'],
      user: config.userId,
      password: config.password,
      appName: config.appName,
      appVersion: config.appVersion,
      systemName: config.systemName,
      infraType,
    },
    config,
  )

  await sendMessage(ws, loginRequest)

  const response = await readNextMessage(ws, config.requestTimeoutMs)
  const ResponseLogin = root.lookupType('ResponseLogin')
  const decoded = ResponseLogin.decode(response) as DecodedMessage
  const responseCode = getFirstResponseCode(decoded)

  if (!isSuccessCode(responseCode)) {
    throw new Error(`Rithmic login failed with rp_code ${responseCode}`)
  }
}

async function fetchAvailableRithmicSystems(
  root: protobuf.Root,
  config: RithmicConfig,
) {
  const ws = await connectToRithmic(config)

  try {
    await sendMessage(
      ws,
      serializeMessage(
        root,
        'RequestRithmicSystemInfo',
        {
          templateId: RITHMIC_SYSTEM_INFO_TEMPLATE_ID,
          userMsg: ['pulse-system-info'],
        },
        config,
      ),
    )

    const response = await readNextMessage(ws, config.requestTimeoutMs)
    const ResponseRithmicSystemInfo = root.lookupType(
      'ResponseRithmicSystemInfo',
    )
    const decoded = ResponseRithmicSystemInfo.decode(response) as DecodedMessage
    const responseCode = getFirstResponseCode(decoded)

    if (!isSuccessCode(responseCode)) {
      throw new Error(`Rithmic system info failed with rp_code ${responseCode}`)
    }

    return decoded.systemName ?? []
  } finally {
    ws.close(1000, 'system info complete')
  }
}

async function sendHeartbeat(
  ws: WebSocket,
  root: protobuf.Root,
  config: RithmicConfig,
) {
  await sendMessage(
    ws,
    serializeMessage(
      root,
      'RequestHeartbeat',
      {
        templateId: RITHMIC_HEARTBEAT_TEMPLATE_ID,
        userMsg: ['pulse-heartbeat'],
      },
      config,
    ),
  )
}

async function requestTimeBars(
  ws: WebSocket,
  root: protobuf.Root,
  config: RithmicConfig,
  start: Date,
  end: Date,
) {
  const RequestTimeBarReplay = root.lookupType('RequestTimeBarReplay')
  const barType = RequestTimeBarReplay.lookupEnum('BarType').values.MINUTE_BAR
  const direction = RequestTimeBarReplay.lookupEnum('Direction').values.FIRST
  const timeOrder = RequestTimeBarReplay.lookupEnum('TimeOrder').values.FORWARDS
  const startIndex = Math.floor(start.getTime() / 1000)
  const finishIndex = Math.floor(end.getTime() / 1000)
  const userMaxCount = Math.ceil((finishIndex - startIndex) / 60) + 10

  await sendMessage(
    ws,
    serializeMessage(
      root,
      'RequestTimeBarReplay',
      {
        templateId: RITHMIC_TIME_BAR_REPLAY_TEMPLATE_ID,
        userMsg: ['pulse-nq-bars'],
        symbol: config.symbol,
        exchange: config.exchange,
        barType,
        barTypePeriod: 1,
        startIndex,
        finishIndex,
        userMaxCount,
        direction,
        timeOrder,
      },
      config,
    ),
  )
}

async function logoutFromRithmic(
  ws: WebSocket,
  root: protobuf.Root,
  config: RithmicConfig,
) {
  if (ws.readyState !== WebSocket.OPEN) {
    return
  }

  await sendMessage(
    ws,
    serializeMessage(
      root,
      'RequestLogout',
      {
        templateId: RITHMIC_LOGOUT_TEMPLATE_ID,
        userMsg: ['pulse-logout'],
      },
      config,
    ),
  )
}

async function readTimeBars(
  ws: WebSocket,
  root: protobuf.Root,
  config: RithmicConfig,
) {
  const MessageType = root.lookupType('MessageType')
  const ResponseTimeBarReplay = root.lookupType('ResponseTimeBarReplay')
  const candles: RithmicCandle[] = []

  while (true) {
    const message = await readNextMessage(ws, config.requestTimeoutMs)
    const messageType = MessageType.decode(message) as DecodedMessage

    if (messageType.templateId === 19) {
      continue
    }

    if (
      messageType.templateId !== RITHMIC_TIME_BAR_REPLAY_RESPONSE_TEMPLATE_ID
    ) {
      continue
    }

    const decoded = ResponseTimeBarReplay.decode(message) as DecodedMessage
    const responseCode = getFirstResponseCode(decoded)

    if (responseCode && !isSuccessCode(responseCode)) {
      throw new Error(
        `Rithmic time bar replay failed with rp_code ${responseCode}`,
      )
    }

    if (isDoneMessage(decoded)) {
      break
    }

    const candle = {
      time: toNumber(decoded.marker),
      open: toNumber(decoded.openPrice),
      high: toNumber(decoded.highPrice),
      low: toNumber(decoded.lowPrice),
      close: toNumber(decoded.closePrice),
      volume: toNumber(decoded.volume ?? 0),
    }

    if (isValidCandle(candle)) {
      candles.push(candle)
    }
  }

  return candles.sort((left, right) => left.time - right.time)
}

export async function fetchNqCandlesFromRithmic() {
  const config = requireRithmicConfig()
  const root = getRithmicRoot()
  const end = new Date()
  const start = new Date(end.getTime() - DAY_MS)
  const availableSystems = await fetchAvailableRithmicSystems(root, config)

  if (!availableSystems.includes(config.systemName)) {
    throw new Error(
      `Rithmic system "${config.systemName}" is not available. Available systems: ${availableSystems.join(', ')}`,
    )
  }

  const ws = await connectToRithmic(config)

  try {
    await loginToRithmic(ws, root, config)
    await sendHeartbeat(ws, root, config)
    await requestTimeBars(ws, root, config, start, end)

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      candles: await readTimeBars(ws, root, config),
    }
  } finally {
    try {
      await logoutFromRithmic(ws, root, config)
    } finally {
      ws.close(1000, 'done')
    }
  }
}
