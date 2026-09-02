import { connect } from 'cloudflare:sockets'
import {
  BlockingQueue,
  createDotStuffer,
  decodeBase64,
  encode,
  encodeBase64,
  execTimeout,
} from './utils'
import {
  DsnOptions,
  Email,
  EmailOptions,
  SendResult,
  SerializeOptions,
  User,
} from './email'
import Logger, { LogLevel } from './logger'

export type AuthType = 'plain' | 'login' | 'cram-md5' | 'xoauth2'
export type Credentials = {
  username: string
  password?: string
  /** OAuth 2.0 bearer token. Required for `xoauth2`, ignored otherwise. */
  accessToken?: string
}

export type WorkerMailerOptions = {
  host: string
  port: number
  secure?: boolean
  startTls?: boolean
  /** Refuse to authenticate or send over an unencrypted connection. */
  requireTls?: boolean
  /**
   * The name announced in EHLO. Should be a domain you control — receiving
   * servers score it, and some reject a HELO name that is not a FQDN.
   * A bare IP address is wrapped in the address literal syntax RFC 5321 wants.
   */
  ehloName?: string
  credentials?: Credentials
  authType?: AuthType | AuthType[]
  logLevel?: LogLevel
  dsn?: DsnOptions | undefined
  socketTimeoutMs?: number
  responseTimeoutMs?: number
  /**
   * Send MAIL FROM and RCPT TO as one batch when the server advertises
   * PIPELINING (RFC 2920). Defaults to true.
   */
  pipelining?: boolean
  /**
   * Transfer the message with BDAT when the server advertises CHUNKING
   * (RFC 3030), which avoids the dot-stuffing pass over the whole message.
   * Defaults to false, because far fewer servers see BDAT traffic than DATA.
   */
  chunking?: boolean
  /**
   * Deliver to the recipients the server accepted even if it rejected others.
   * Defaults to false, so a rejected recipient still fails the whole message.
   */
  allowPartialRecipients?: boolean
}

/** Data written per BDAT command. */
const CHUNK_SIZE = 262_144
/** Body bytes buffered before a socket write in the DATA path. */
const WRITE_BUFFER_SIZE = 32_768

export class WorkerMailer {
  private socket: Socket

  private readonly host: string
  private readonly port: number
  private readonly secure: boolean
  private readonly startTls: boolean
  private readonly requireTls: boolean
  private readonly ehloName: string
  private readonly authType: AuthType[]
  private readonly credentials?: Credentials

  private readonly socketTimeoutMs: number
  private readonly responseTimeoutMs: number
  private readonly pipelining: boolean
  private readonly chunking: boolean
  private readonly allowPartialRecipients: boolean

  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private decoder = new TextDecoder('utf-8')
  /** Bytes received but not yet consumed as a complete response. */
  private buffer = ''
  private streamClosed = false

  private readonly logger: Logger

  private readonly dsn: DsnOptions | undefined

  private active = false
  private tlsActive = false

  private emailSending: Email | null = null
  private emailToBeSent = new BlockingQueue<Email>()

  /** SMTP server capabilities **/
  private supportsDSN = false
  private allowAuth = false
  private authTypeSupported: AuthType[] = []
  private supportsStartTls = false
  private supportsPipelining = false
  private supportsChunking = false
  private supports8BitMime = false
  private maxMessageSize = 0

  private constructor(options: WorkerMailerOptions) {
    this.port = options.port
    this.host = options.host
    this.secure = !!options.secure
    if (Array.isArray(options.authType)) {
      this.authType = options.authType
    } else if (typeof options.authType === 'string') {
      this.authType = [options.authType]
    } else {
      this.authType = []
    }
    this.startTls = options.startTls === undefined ? true : options.startTls
    this.requireTls = !!options.requireTls
    this.credentials = options.credentials
    this.dsn = options.dsn || {}
    this.pipelining = options.pipelining !== false
    this.chunking = !!options.chunking
    this.allowPartialRecipients = !!options.allowPartialRecipients

    this.socketTimeoutMs = options.socketTimeoutMs || 60_000
    this.responseTimeoutMs = options.responseTimeoutMs || 30_000
    this.tlsActive = this.secure
    this.socket = connect(
      {
        hostname: this.host,
        port: this.port,
      },
      {
        secureTransport: this.secure
          ? 'on'
          : this.startTls
            ? 'starttls'
            : 'off',
        allowHalfOpen: false,
      },
    )
    this.reader = this.socket.readable.getReader()
    this.writer = this.socket.writable.getWriter()

    this.logger = new Logger(
      options.logLevel,
      `[WorkerMailer:${this.host}:${this.port}]`,
    )

    this.ehloName = WorkerMailer.resolveEhloName(options.ehloName)
    if (!options.ehloName) {
      this.logger.warn(
        'No ehloName set, announcing [127.0.0.1]. Set ehloName to a domain you ' +
          'control — receiving servers use it for spam scoring.',
      )
    }
  }

  /**
   * RFC 5321 §4.1.3 wants either a fully qualified domain or a bracketed
   * address literal. A bare `127.0.0.1` is neither, and strict servers say so.
   */
  private static resolveEhloName(name?: string): string {
    const trimmed = name?.trim()
    if (!trimmed) {
      return '[127.0.0.1]'
    }
    if (/^\[.+\]$/.test(trimmed)) {
      return trimmed
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
      return `[${trimmed}]`
    }
    if (trimmed.includes(':')) {
      // A domain never contains a colon, so this is a bare IPv6 address.
      return `[IPv6:${trimmed}]`
    }
    return trimmed
  }

  static async connect(options: WorkerMailerOptions): Promise<WorkerMailer> {
    const mailer = new WorkerMailer(options)
    await mailer.initializeSmtpSession()
    mailer.start().catch(console.error)
    return mailer
  }

  public async send(options: EmailOptions): Promise<SendResult> {
    if (!this.active) {
      throw new Error('WorkerMailer is not connected')
    }
    const email = new Email(options)
    this.emailToBeSent.enqueue(email)
    await email.sent
    return email.result!
  }

  static async send(
    options: WorkerMailerOptions,
    email: EmailOptions,
  ): Promise<SendResult> {
    const mailer = await WorkerMailer.connect(options)
    try {
      return await mailer.send(email)
    } finally {
      await mailer.close()
    }
  }

  private async readTimeout(): Promise<string> {
    return execTimeout(
      this.readResponse(),
      this.responseTimeoutMs,
      new Error('Timeout while waiting for smtp server response'),
    )
  }

  /**
   * Reads exactly one SMTP response. Anything the server sent beyond it stays
   * buffered — with pipelining several responses routinely arrive in a single
   * TCP segment, and dropping the remainder desynchronizes the connection.
   */
  private async readResponse(): Promise<string> {
    while (true) {
      const response = this.takeResponse()
      if (response !== null) {
        return response
      }
      if (this.streamClosed) {
        throw new Error('SMTP server closed the connection')
      }
      const { value, done } = await this.reader.read()
      if (done) {
        this.streamClosed = true
        continue
      }
      if (!value) {
        continue
      }
      const data = this.decoder.decode(value, { stream: true })
      this.logger.debug('SMTP server response:\n' + data)
      this.buffer += data
    }
  }

  /** Removes one complete response from the buffer, or null if none is ready. */
  private takeResponse(): string | null {
    let from = 0
    while (true) {
      const index = this.buffer.indexOf('\n', from)
      if (index === -1) {
        return null
      }
      // `250-` continues, `250 ` (or `250`) terminates the response.
      if (!/^\d{3}-/.test(this.buffer.slice(from, index))) {
        const response = this.buffer.slice(0, index + 1)
        this.buffer = this.buffer.slice(index + 1)
        return response
      }
      from = index + 1
    }
  }

  private async writeLine(line: string) {
    await this.write(`${line}\r\n`)
  }

  private async write(data: string, logData = true) {
    this.logger.debug(
      logData
        ? 'Write to socket:\n' + data
        : `Write to socket: ${data.length} characters`,
    )
    await this.writer.write(encode(data))
  }

  private async writeBytes(data: Uint8Array) {
    this.logger.debug(`Write to socket: ${data.byteLength} bytes`)
    await this.writer.write(data)
  }

  private async initializeSmtpSession() {
    await this.waitForSocketConnected()
    await this.greet()
    await this.ehlo()

    // Handle STARTTLS if needed
    if (this.startTls && !this.secure && this.supportsStartTls) {
      await this.tls()
      // Re-issue EHLO after STARTTLS as required by RFC 3207
      await this.ehlo()
    }

    if (this.requireTls && !this.tlsActive) {
      throw new Error(
        'requireTls is set but the connection is not encrypted (server does not support STARTTLS)',
      )
    }

    await this.auth()
    this.active = true
  }

  private async start() {
    while (this.active) {
      this.emailSending = await this.emailToBeSent.dequeue()
      try {
        this.emailSending.result = await this.transaction(this.emailSending)
        this.emailSending.setSent()
      } catch (e: any) {
        this.logger.error('Failed to send email: ' + e.message)
        if (!this.active) {
          return
        }
        this.emailSending.setSentError(e)
        try {
          await this.rset()
        } catch (e: any) {
          await this.close(e)
        }
        // If reset successfully, try to send next email
        // otherwise `this.active` will be set to false in `close` function, and loop will be stopped
      }
      this.emailSending = null
    }
  }

  public async close(error?: Error) {
    this.active = false
    this.logger.info('WorkerMailer is closed', error?.message || '')
    this.emailSending?.setSentError?.(
      error || new Error('WorkerMailer is shutting down'),
    )
    while (this.emailToBeSent.length) {
      const email = await this.emailToBeSent.dequeue()
      email.setSentError(error || new Error('WorkerMailer is shutting down'))
    }

    try {
      await this.writeLine('QUIT')
      await this.readTimeout()
      this.socket
        .close()
        .catch(() => this.logger.error('Failed to close socket')) // If server-side close socket first it will never be solved, so just fire and forget
    } catch (ignore) {
      // maybe socket is closed now
      // anyway, just keep it simple
    }
  }

  private async waitForSocketConnected() {
    this.logger.info(`Connecting to SMTP server`)
    await execTimeout(
      this.socket.opened,
      this.socketTimeoutMs,
      new Error('Socket timeout!'),
    )
    this.logger.info('SMTP server connected')
  }

  private async greet() {
    const response = await this.readTimeout()
    if (!response.startsWith('220')) {
      throw new Error('Failed to connect to SMTP server: ' + response)
    }
  }

  private async ehlo() {
    await this.writeLine(`EHLO ${this.ehloName}`)
    const response = await this.readTimeout()
    if (response.startsWith('421')) {
      throw new Error(`Failed to EHLO. ${response}`)
    }
    if (!response.startsWith('2')) {
      // falling back to HELO
      await this.helo()
      return
    }
    this.parseCapabilities(response)
  }

  private async helo() {
    await this.writeLine(`HELO ${this.ehloName}`)
    const response = await this.readTimeout()
    if (response.startsWith('2')) {
      return
    }
    throw new Error(`Failed to HELO. ${response}`)
  }

  private async tls() {
    await this.writeLine('STARTTLS')
    const response = await this.readTimeout()
    if (!response.startsWith('220')) {
      throw new Error('Failed to start TLS: ' + response)
    }

    // Upgrade the socket to TLS
    this.reader.releaseLock()
    this.writer.releaseLock()
    this.socket = this.socket.startTls()
    this.reader = this.socket.readable.getReader()
    this.writer = this.socket.writable.getWriter()
    // RFC 3207 §4.2: discard anything the server sent before the handshake.
    this.decoder = new TextDecoder('utf-8')
    this.buffer = ''
    this.tlsActive = true
  }

  private parseCapabilities(response: string) {
    // EHLO is issued again after STARTTLS, and the second answer replaces the
    // first — capabilities must not accumulate across the two.
    this.allowAuth = false
    this.authTypeSupported = []
    this.supportsStartTls = false
    this.supportsDSN = false
    this.supportsPipelining = false
    this.supportsChunking = false
    this.supports8BitMime = false
    this.maxMessageSize = 0

    const authTypes = new Set<AuthType>()
    for (const line of response.split(/\r?\n/)) {
      const keywords = line.replace(/^\d{3}[- ]?/, '').trim()
      if (!keywords) {
        continue
      }
      const [name, ...params] = keywords.split(/[ =]+/)
      switch (name.toUpperCase()) {
        case 'AUTH':
          this.allowAuth = true
          for (const param of params) {
            switch (param.toUpperCase()) {
              case 'PLAIN':
                authTypes.add('plain')
                break
              case 'LOGIN':
                authTypes.add('login')
                break
              case 'CRAM-MD5':
                authTypes.add('cram-md5')
                break
              case 'XOAUTH2':
                authTypes.add('xoauth2')
                break
            }
          }
          break
        case 'STARTTLS':
          this.supportsStartTls = true
          break
        case 'DSN':
          this.supportsDSN = true
          break
        case 'PIPELINING':
          this.supportsPipelining = true
          break
        case 'CHUNKING':
          this.supportsChunking = true
          break
        case '8BITMIME':
          this.supports8BitMime = true
          break
        case 'SIZE':
          this.maxMessageSize = Number(params[0]) || 0
          break
      }
    }
    this.authTypeSupported = [...authTypes]
  }

  private defaultAuthOrder(): AuthType[] {
    // Without TLS, prefer the method that keeps the password off the wire.
    return this.tlsActive
      ? ['plain', 'login', 'cram-md5']
      : ['cram-md5', 'plain', 'login']
  }

  private selectAuthType(): AuthType | undefined {
    // The caller's order is a preference order, not just a set.
    const preferred = this.authType.length
      ? this.authType
      : this.defaultAuthOrder()
    return preferred.find(type => this.authTypeSupported.includes(type))
  }

  private async auth() {
    if (!this.allowAuth) {
      return
    }
    if (!this.credentials) {
      throw new Error(
        'smtp server requires authentication, but no credentials found',
      )
    }
    if (!this.tlsActive) {
      this.logger.warn(
        'Authenticating over an unencrypted connection, credentials are sent in the clear',
      )
    }
    switch (this.selectAuthType()) {
      case 'plain':
        return this.authWithPlain()
      case 'login':
        return this.authWithLogin()
      case 'cram-md5':
        return this.authWithCramMD5()
      case 'xoauth2':
        return this.authWithXOAuth2()
      default:
        throw new Error('No supported auth method found.')
    }
  }

  private requirePassword(): string {
    const password = this.credentials?.password
    if (password === undefined) {
      throw new Error('credentials.password is required for this auth method')
    }
    return password
  }

  private async authWithPlain() {
    const password = this.requirePassword()
    // btoa() throws on anything outside Latin-1, so encode as UTF-8 first.
    const userPassBase64 = encodeBase64(
      encode(`\u0000${this.credentials!.username}\u0000${password}`),
    )
    await this.writeLine(`AUTH PLAIN ${userPassBase64}`)
    const authResult = await this.readTimeout()
    if (!authResult.startsWith('2')) {
      throw new Error(`Failed to plain authentication: ${authResult}`)
    }
  }

  private async authWithLogin() {
    const password = this.requirePassword()
    await this.writeLine(`AUTH LOGIN`)
    const startLoginResponse = await this.readTimeout()
    if (!startLoginResponse.startsWith('3')) {
      throw new Error('Invalid login: ' + startLoginResponse)
    }

    await this.writeLine(encodeBase64(encode(this.credentials!.username)))
    const userResponse = await this.readTimeout()
    if (!userResponse.startsWith('3')) {
      throw new Error('Failed to login authentication: ' + userResponse)
    }

    await this.writeLine(encodeBase64(encode(password)))
    const authResult = await this.readTimeout()
    if (!authResult.startsWith('2')) {
      throw new Error('Failed to login authentication: ' + authResult)
    }
  }

  private async authWithCramMD5() {
    const password = this.requirePassword()
    await this.writeLine('AUTH CRAM-MD5')
    const challengeResponse = await this.readTimeout()
    const challengeWithBase64Encoded = challengeResponse
      .match(/^334\s+(.+)$/m)
      ?.pop()
      ?.trim()
    if (!challengeWithBase64Encoded) {
      throw new Error('Invalid CRAM-MD5 challenge: ' + challengeResponse)
    }

    // Import password as key
    const key = await crypto.subtle.importKey(
      'raw',
      encode(password),
      { name: 'HMAC', hash: 'MD5' },
      false,
      ['sign'],
    )

    // Sign the challenge, which is base64 of raw bytes rather than of text
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      decodeBase64(challengeWithBase64Encoded),
    )

    // Convert to hex
    const challengeSolved = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    await this.writeLine(
      encodeBase64(encode(`${this.credentials!.username} ${challengeSolved}`)),
    )
    const authResult = await this.readTimeout()
    if (!authResult.startsWith('2')) {
      throw new Error(`Failed to cram-md5 authentication: ${authResult}`)
    }
  }

  private async authWithXOAuth2() {
    const accessToken = this.credentials?.accessToken
    if (!accessToken) {
      throw new Error('credentials.accessToken is required for xoauth2')
    }
    const value = encodeBase64(
      encode(
        `user=${this.credentials!.username}\u0001auth=Bearer ${accessToken}\u0001\u0001`,
      ),
    )
    await this.writeLine(`AUTH XOAUTH2 ${value}`)
    const authResult = await this.readTimeout()
    if (authResult.startsWith('2')) {
      return
    }
    if (authResult.startsWith('3')) {
      // The server sent a base64 error payload and waits for an empty line
      // before it reports the final status.
      await this.writeLine('')
      throw new Error(
        `Failed to xoauth2 authentication: ${await this.readTimeout()}`,
      )
    }
    throw new Error(`Failed to xoauth2 authentication: ${authResult}`)
  }

  /**
   * Runs one mail transaction. MAIL FROM and every RCPT TO go out as a single
   * batch when the server supports pipelining, turning N+2 round trips into 2.
   */
  private async transaction(email: Email): Promise<SendResult> {
    const recipients = email.recipients
    if (!recipients.length) {
      throw new Error('Email has no recipients')
    }
    this.checkSize(email)

    const useChunking = this.chunking && this.supportsChunking
    const mailCommand = this.mailFromCommand(email)
    const rcptCommands = recipients.map(user => this.rcptToCommand(email, user))
    // DATA can join the batch only when a rejected recipient would not force us
    // to abort — once the server answered 354 there is no way back out.
    const pipelineData =
      !useChunking && (this.allowPartialRecipients || recipients.length === 1)

    let mailResponse: string
    const rcptResponses: string[] = []
    let dataResponse: string | null = null

    if (this.pipelining && this.supportsPipelining) {
      const batch = [mailCommand, ...rcptCommands]
      if (pipelineData) {
        batch.push('DATA')
      }
      await this.write(batch.map(command => `${command}\r\n`).join(''))
      // Every queued command is answered even if an earlier one failed, so all
      // responses have to be read to keep the connection in sync.
      mailResponse = await this.readTimeout()
      for (const _ of rcptCommands) {
        rcptResponses.push(await this.readTimeout())
      }
      if (pipelineData) {
        dataResponse = await this.readTimeout()
      }
    } else {
      await this.writeLine(mailCommand)
      mailResponse = await this.readTimeout()
      if (mailResponse.startsWith('2')) {
        for (const command of rcptCommands) {
          await this.writeLine(command)
          rcptResponses.push(await this.readTimeout())
        }
      }
    }

    if (!mailResponse.startsWith('2')) {
      throw new Error(`Invalid ${mailCommand} ${mailResponse}`)
    }

    const accepted: User[] = []
    const rejected: { user: User; response: string }[] = []
    recipients.forEach((user, index) => {
      const response = rcptResponses[index]
      if (response?.startsWith('2')) {
        accepted.push(user)
      } else {
        rejected.push({ user, response: (response || '').trim() })
      }
    })

    if (rejected.length && (!accepted.length || !this.allowPartialRecipients)) {
      if (dataResponse?.startsWith('3')) {
        await this.abortData()
      }
      const { user, response } = rejected[0]
      throw new Error(`Invalid RCPT TO: <${user.email}> ${response}`)
    }
    if (rejected.length) {
      this.logger.warn(
        `Server rejected ${rejected.length} of ${recipients.length} recipients`,
      )
    }

    const response = useChunking
      ? await this.sendWithChunking(email)
      : await this.sendWithData(email, dataResponse)

    return { accepted, rejected, response: response.trim() }
  }

  private mailFromCommand(email: Email): string {
    let command = `MAIL FROM: <${email.from.email}>`
    if (this.supportsDSN) {
      const ret = this.retBuilder(email)
      if (ret) {
        command += ` ${ret}`
      }
      if (email.dsnOverride?.envelopeId) {
        command += ` ENVID=${email.dsnOverride.envelopeId}`
      }
    }
    return command
  }

  private rcptToCommand(email: Email, user: User): string {
    let command = `RCPT TO: <${user.email}>`
    if (this.supportsDSN) {
      command += this.notificationBuilder(email)
    }
    return command
  }

  private checkSize(email: Email) {
    if (!this.maxMessageSize) {
      return
    }
    const estimate = email.estimateSize()
    if (estimate > this.maxMessageSize) {
      throw new Error(
        `Message is roughly ${estimate} bytes but the server accepts at most ${this.maxMessageSize} bytes`,
      )
    }
  }

  private serializeOptions(): SerializeOptions {
    return { allow8bit: this.supports8BitMime }
  }

  /** Ends a data phase we entered but do not want to complete. */
  private async abortData() {
    await this.write('\r\n.\r\n')
    await this.readTimeout()
  }

  private async sendWithData(
    email: Email,
    pipelinedResponse: string | null,
  ): Promise<string> {
    let dataResponse = pipelinedResponse
    if (dataResponse === null) {
      await this.writeLine('DATA')
      dataResponse = await this.readTimeout()
    }
    if (!dataResponse.startsWith('3')) {
      throw new Error(`Failed to send DATA: ${dataResponse}`)
    }

    const stuff = createDotStuffer()
    let buffer = ''
    let endsWithNewline = true
    for (const chunk of email.chunks(this.serializeOptions())) {
      const stuffed = stuff(chunk)
      endsWithNewline = stuffed.endsWith('\r\n')
      buffer += stuffed
      if (buffer.length >= WRITE_BUFFER_SIZE) {
        await this.write(buffer, false)
        buffer = ''
      }
    }
    buffer += endsWithNewline ? '.\r\n' : '\r\n.\r\n'
    await this.write(buffer, false)

    const response = await this.readTimeout()
    if (!response.startsWith('2')) {
      throw new Error('Failed send email body: ' + response)
    }
    return response
  }

  /**
   * RFC 3030 BDAT. The message is length-delimited, so it needs no dot-stuffing
   * and no terminator scan. Commands are pipelined; responses are tiny and read
   * once everything is on the wire.
   */
  private async sendWithChunking(email: Email): Promise<string> {
    let buffer = ''
    let pending = 0

    const flush = async (last: boolean) => {
      const data = encode(buffer)
      buffer = ''
      await this.write(`BDAT ${data.byteLength}${last ? ' LAST' : ''}\r\n`)
      await this.writeBytes(data)
      pending++
    }

    for (const chunk of email.chunks(this.serializeOptions())) {
      buffer += chunk
      if (buffer.length >= CHUNK_SIZE) {
        await flush(false)
      }
    }
    await flush(true)

    let response = ''
    for (let i = 0; i < pending; i++) {
      response = await this.readTimeout()
      if (!response.startsWith('2')) {
        throw new Error('Failed send email body: ' + response)
      }
    }
    return response
  }

  private async rset() {
    await this.writeLine('RSET')
    const response = await this.readTimeout()
    if (!response.startsWith('2')) {
      throw new Error(`Failed to reset: ${response}`)
    }
  }

  private notificationBuilder(email: Email) {
    const override = email.dsnOverride?.NOTIFY
    const fallback = override ? undefined : this.dsn?.NOTIFY
    const notifications: string[] = []
    if (override?.SUCCESS || fallback?.SUCCESS) {
      notifications.push('SUCCESS')
    }
    if (override?.FAILURE || fallback?.FAILURE) {
      notifications.push('FAILURE')
    }
    if (override?.DELAY || fallback?.DELAY) {
      notifications.push('DELAY')
    }
    return notifications.length > 0
      ? ` NOTIFY=${notifications.join(',')}`
      : ' NOTIFY=NEVER'
  }

  private retBuilder(email: Email) {
    const override = email.dsnOverride?.RET
    const fallback = override ? undefined : this.dsn?.RET
    const ret: string[] = []
    if (override?.HEADERS || fallback?.HEADERS) {
      ret.push('HDRS')
    }
    if (override?.FULL || fallback?.FULL) {
      ret.push('FULL')
    }
    return ret.length > 0 ? `RET=${ret.join(',')}` : ''
  }
}
