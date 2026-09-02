import {
  createDotStuffer,
  encode,
  encodeBase64,
  encodeParameter,
  encodeQuotedPrintable,
  estimateQuotedPrintableSize,
  foldHeader,
  formatDate,
  normalizeLineEndings,
  wrapBase64,
} from './utils'

const ENCODED_WORD_PREFIX = '=?UTF-8?Q?'
const ENCODED_WORD_SUFFIX = '?='
// RFC 2047 §2: an encoded-word may not be longer than 75 characters.
const ENCODED_WORD_PAYLOAD =
  75 - ENCODED_WORD_PREFIX.length - ENCODED_WORD_SUFFIX.length

export function encodeHeader(text: string): string {
  // Anything outside printable ASCII gets encoded. This deliberately includes
  // CR and LF, which would otherwise let a display name or subject inject
  // additional headers into the message.
  if (!/[^\x20-\x7E]/.test(text)) {
    return text
  }

  const words: string[] = []
  let current = ''

  // Iterating the string yields whole code points, so a multi-byte character is
  // never split across two encoded-words.
  for (const char of text) {
    let piece = ''
    for (const byte of encode(char)) {
      // RFC 2047 specific rules for headers:
      // - Printable ASCII except ?, =, _, and space
      // - Space becomes underscore
      if (
        byte >= 33 &&
        byte <= 126 &&
        byte !== 63 &&
        byte !== 61 &&
        byte !== 95
      ) {
        // 63 = '?', 61 = '=', 95 = '_'
        piece += String.fromCharCode(byte)
      } else if (byte === 32) {
        // Space becomes underscore in headers (RFC 2047)
        piece += '_'
      } else {
        // Encode everything else
        piece += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
      }
    }
    if (current.length + piece.length > ENCODED_WORD_PAYLOAD) {
      words.push(current)
      current = ''
    }
    current += piece
  }
  if (current) {
    words.push(current)
  }

  // Adjacent encoded-words separated by whitespace are concatenated by the
  // reader, and foldHeader may later break the line at those spaces.
  return words
    .map(word => `${ENCODED_WORD_PREFIX}${word}${ENCODED_WORD_SUFFIX}`)
    .join(' ')
}

export type User = { name?: string; email: string }

export function formatAddress(user: User): string {
  if (!user.name) {
    return user.email
  }
  const encoded = encodeHeader(user.name)
  if (encoded === user.name) {
    return `"${user.name.replace(/([\\"])/g, '\\$1')}" <${user.email}>`
  }
  // RFC 2047 §5: an encoded-word must not appear inside a quoted-string.
  return `${encoded} <${user.email}>`
}

export type AttachmentContent = string | ArrayBuffer | Uint8Array

export type Attachment = {
  filename: string
  /** Base64 string, or raw bytes which are base64-encoded for you. */
  content: AttachmentContent
  mimeType?: string
}

export type DsnOptions = {
  envelopeId?: string
  RET?: {
    HEADERS?: boolean
    FULL?: boolean
  }
  NOTIFY?: {
    DELAY?: boolean
    FAILURE?: boolean
    SUCCESS?: boolean
  }
}

export type EmailOptions = {
  from: string | User
  to: string | string[] | User | User[]
  reply?: string | User
  cc?: string | string[] | User | User[]
  bcc?: string | string[] | User | User[]
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
  attachments?: Attachment[]
  dsnOverride?: DsnOptions
}

export type SendResult = {
  /** Recipients the server accepted. */
  accepted: User[]
  /** Recipients the server rejected, with the response that rejected them. */
  rejected: { user: User; response: string }[]
  /** The server's final response to the message. */
  response: string
}

export type SerializeOptions = {
  /** Set when the server advertised 8BITMIME. */
  allow8bit?: boolean
}

type TransferEncoding = '7bit' | '8bit' | 'quoted-printable' | 'base64'

type EncodedPart = {
  encoding: TransferEncoding
  render: () => string
}

/**
 * Picks the cheapest transfer encoding a part can safely use. Encoding
 * everything as quoted-printable inflates non-ASCII content to roughly three
 * times its size; base64 costs a flat 33% and 7bit/8bit cost nothing.
 */
function selectTransferEncoding(
  content: string,
  allow8bit: boolean,
): EncodedPart {
  const normalized = normalizeLineEndings(content)
  const hasControl = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)
  // Trailing whitespace is not reliably preserved by intermediate MTAs.
  const hasTrailingWhitespace = /[ \t]\r\n|[ \t]$/.test(normalized)

  let maxLine = 0
  for (const line of normalized.split('\r\n')) {
    if (line.length > maxLine) {
      maxLine = line.length
    }
  }

  if (!hasControl && !hasTrailingWhitespace) {
    // Lines must stay below 998 octets (RFC 5322 §2.1.1).
    if (maxLine <= 990 && !/[^\x00-\x7F]/.test(normalized)) {
      return { encoding: '7bit', render: () => normalized }
    }
    // A UTF-8 character is at most 4 bytes, so 240 characters cannot exceed the
    // octet limit — no second pass over the content needed to prove it.
    if (allow8bit && maxLine <= 240) {
      return { encoding: '8bit', render: () => normalized }
    }
  }

  const bytes = encode(normalized)
  const base64Size = Math.ceil(bytes.length / 3) * 4
  if (estimateQuotedPrintableSize(bytes) <= base64Size) {
    return {
      encoding: 'quoted-printable',
      render: () => encodeQuotedPrintable(normalized),
    }
  }
  return { encoding: 'base64', render: () => wrapBase64(encodeBase64(bytes)) }
}

function byteLength(content: ArrayBuffer | Uint8Array): number {
  return content instanceof Uint8Array ? content.length : content.byteLength
}

export class Email {
  public readonly from: User
  public readonly to: User[]
  public readonly reply?: User
  public readonly cc?: User[]
  public readonly bcc?: User[]

  public readonly subject: string
  public readonly text?: string
  public readonly html?: string
  public readonly dsnOverride?: DsnOptions

  public readonly attachments?: Attachment[]

  public readonly headers: Record<string, string>

  /** Populated once the server has accepted (or rejected) the message. */
  public result?: SendResult

  public setSent!: () => void
  public setSentError!: (e: unknown) => void
  public sent = new Promise<void>((resolve, reject) => {
    this.setSent = resolve
    this.setSentError = reject
  })

  constructor(options: EmailOptions) {
    if (!options.text && !options.html) {
      throw new Error('At least one of text or html must be provided')
    }

    if (typeof options.from === 'string') {
      this.from = { email: options.from }
    } else {
      this.from = options.from
    }
    if (typeof options.reply === 'string') {
      this.reply = { email: options.reply }
    } else {
      this.reply = options.reply
    }
    this.to = Email.toUsers(options.to)!
    this.cc = Email.toUsers(options.cc)
    this.bcc = Email.toUsers(options.bcc)

    this.subject = options.subject
    this.text = options.text
    this.html = options.html
    this.attachments = options.attachments
    this.dsnOverride = options.dsnOverride
    this.headers = options.headers || {}
  }

  private static toUsers(
    user: string | string[] | User | User[] | undefined,
  ): User[] | undefined {
    if (!user) {
      return
    }
    if (typeof user === 'string') {
      return [{ email: user }]
    } else if (Array.isArray(user)) {
      return user.map(user => {
        if (typeof user === 'string') {
          return { email: user }
        }
        return user
      })
    } else {
      return [user]
    }
  }

  /** Every envelope recipient, in the order they are sent to the server. */
  public get recipients(): User[] {
    return [...this.to, ...(this.cc || []), ...(this.bcc || [])]
  }

  /**
   * Rough upper bound on the wire size, used to reject a message locally when
   * the server advertised a smaller SIZE limit.
   */
  public estimateSize(): number {
    let size = 2048
    if (this.text) {
      size += Math.ceil(encode(this.text).length * 1.4)
    }
    if (this.html) {
      size += Math.ceil(encode(this.html).length * 1.4)
    }
    for (const attachment of this.attachments || []) {
      size +=
        typeof attachment.content === 'string'
          ? attachment.content.length
          : Math.ceil(byteLength(attachment.content) / 3) * 4
      size += 512
    }
    return size
  }

  /**
   * Yields the message piece by piece. Every chunk starts on a line boundary so
   * the caller can dot-stuff and write them one at a time instead of building
   * the whole message — attachments included — as a single string.
   */
  public *chunks(options: SerializeOptions = {}): Generator<string> {
    const allow8bit = !!options.allow8bit
    const headers = this.messageHeaders()
    const content = this.buildContentPart(allow8bit)

    if (!this.attachments?.length) {
      yield `${[...headers, ...content.headers].join('\r\n')}\r\n\r\n`
      yield* content.body()
      return
    }

    const boundary = generateBoundary('mixed')
    yield `${[
      ...headers,
      foldHeader('Content-Type', `multipart/mixed; boundary="${boundary}"`),
    ].join('\r\n')}\r\n\r\n`

    yield `--${boundary}\r\n${content.headers.join('\r\n')}\r\n\r\n`
    yield* content.body()

    for (const attachment of this.attachments) {
      yield* this.renderAttachment(boundary, attachment)
    }
    yield `--${boundary}--\r\n`
  }

  /** The complete, dot-stuffed message including the SMTP terminator. */
  public getEmailData(options: SerializeOptions = {}): string {
    const stuff = createDotStuffer()
    let data = ''
    for (const chunk of this.chunks(options)) {
      data += stuff(chunk)
    }
    if (!data.endsWith('\r\n')) {
      data += '\r\n'
    }
    return `${data}.\r\n`
  }

  private buildContentPart(allow8bit: boolean): {
    headers: string[]
    body: () => Generator<string>
  } {
    const text = this.text
    const html = this.html

    if (text !== undefined && html !== undefined) {
      const boundary = generateBoundary('alternative')
      const renderPart = this.renderTextPart.bind(this)
      return {
        headers: [
          foldHeader(
            'Content-Type',
            `multipart/alternative; boundary="${boundary}"`,
          ),
        ],
        *body() {
          yield* renderPart(boundary, 'text/plain', text, allow8bit)
          yield* renderPart(boundary, 'text/html', html, allow8bit)
          yield `--${boundary}--\r\n`
        },
      }
    }

    // A single body needs no multipart wrapper at all.
    const mimeType = text !== undefined ? 'text/plain' : 'text/html'
    const part = selectTransferEncoding((text ?? html)!, allow8bit)
    return {
      headers: [
        foldHeader('Content-Type', `${mimeType}; charset="UTF-8"`),
        `Content-Transfer-Encoding: ${part.encoding}`,
      ],
      *body() {
        yield `${part.render()}\r\n`
      },
    }
  }

  private *renderTextPart(
    boundary: string,
    mimeType: string,
    content: string,
    allow8bit: boolean,
  ): Generator<string> {
    const part = selectTransferEncoding(content, allow8bit)
    yield `--${boundary}\r\n` +
      foldHeader('Content-Type', `${mimeType}; charset="UTF-8"`) +
      `\r\nContent-Transfer-Encoding: ${part.encoding}\r\n\r\n`
    yield `${part.render()}\r\n`
  }

  private *renderAttachment(
    boundary: string,
    attachment: Attachment,
  ): Generator<string> {
    const mimeType = attachment.mimeType || getMimeType(attachment.filename)
    const headers = [
      foldHeader(
        'Content-Type',
        `${mimeType}; ${encodeParameter('name', attachment.filename)}`,
      ),
      // A header value carries no charset of its own, so a non-ASCII filename
      // has to be an encoded-word here rather than raw UTF-8.
      foldHeader('Content-Description', encodeHeader(attachment.filename)),
      foldHeader(
        'Content-Disposition',
        `attachment; ${encodeParameter('filename', attachment.filename)}`,
      ),
      'Content-Transfer-Encoding: base64',
    ]
    yield `--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n`

    if (typeof attachment.content === 'string') {
      yield `${wrapBase64(attachment.content)}\r\n`
      return
    }

    const bytes =
      attachment.content instanceof Uint8Array
        ? attachment.content
        : new Uint8Array(attachment.content)
    // A multiple of both 3 and 57, so each slice encodes to whole base64 lines
    // with no padding in the middle.
    const step = 57 * 96
    for (let i = 0; i < bytes.length; i += step) {
      yield `${wrapBase64(encodeBase64(bytes.subarray(i, i + step)))}\r\n`
    }
  }

  private messageHeaders(): string[] {
    this.resolveHeader()
    const headers = ['MIME-Version: 1.0']
    for (const [key, value] of Object.entries(this.headers)) {
      headers.push(foldHeader(key, value))
    }
    return headers
  }

  private hasHeader(name: string): boolean {
    const lower = name.toLowerCase()
    return Object.keys(this.headers).some(key => key.toLowerCase() === lower)
  }

  private resolveHeader() {
    this.resolveAddressHeader('From', [this.from])
    this.resolveAddressHeader('To', this.to)
    this.resolveAddressHeader('Reply-To', this.reply ? [this.reply] : undefined)
    this.resolveAddressHeader('Cc', this.cc)
    // Bcc is deliberately not written into the message: it travels in the
    // envelope only, otherwise every recipient sees the blind copies.
    this.resolveSubject()
    if (!this.hasHeader('Date')) {
      this.headers['Date'] = formatDate()
    }
    if (!this.hasHeader('Message-ID')) {
      this.headers['Message-ID'] =
        `<${crypto.randomUUID()}@${this.from.email.split('@').pop()}>`
    }
  }

  private resolveAddressHeader(name: string, users: User[] | undefined) {
    if (!users?.length || this.hasHeader(name)) {
      return
    }
    this.headers[name] = users.map(formatAddress).join(', ')
  }

  private resolveSubject() {
    if (this.hasHeader('Subject') || !this.subject) {
      return
    }
    this.headers['Subject'] = encodeHeader(this.subject)
  }
}

function generateBoundary(prefix: string): string {
  // 128 unguessable bits are plenty, and every boundary appears at least three
  // times in the message.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `${prefix}_${hex}`
}

const MIME_TYPES: Record<string, string> = {
  txt: 'text/plain',
  html: 'text/html',
  csv: 'text/csv',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  zip: 'application/zip',
}

function getMimeType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase()
  return MIME_TYPES[extension || 'txt'] || 'application/octet-stream'
}
