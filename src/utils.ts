export class BlockingQueue<T> {
  private values: Promise<T>[] = []
  private resolvers: ((value: T) => void)[] = []

  public enqueue(value: T) {
    if (!this.resolvers.length) {
      this.addWrapper()
    }
    this.resolvers.shift()!(value)
  }

  public async dequeue(): Promise<T> {
    if (!this.values.length) {
      this.addWrapper()
    }
    return this.values.shift()!
  }

  public get length(): number {
    return this.values.length
  }

  public clear() {
    this.values = []
    this.resolvers = []
  }

  private addWrapper() {
    this.values.push(
      new Promise<T>(resolve => {
        this.resolvers.push(resolve)
      }),
    )
  }
}

export async function execTimeout<T>(
  promise: Promise<T>,
  ms: number,
  e: Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(e), ms)
      }),
    ])
  } finally {
    // Without this the timer keeps the isolate's event loop busy until it fires,
    // even though nobody is waiting for it anymore.
    clearTimeout(timer)
  }
}

const encoder = new TextEncoder()
export function encode(data: string): Uint8Array {
  return encoder.encode(data)
}
const decoder = new TextDecoder('utf-8')
export function decode(data: Uint8Array): string {
  return decoder.decode(data)
}

/** Normalizes CR, LF and CRLF to the CRLF required on the wire. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n')
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/**
 * RFC 5322 date-time, e.g. `Tue, 02 Sep 2025 20:00:00 +0000`.
 * `Date.toUTCString()` produces the obsolete `GMT` zone instead of `+0000`.
 */
export function formatDate(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ` +
    `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  )
}

/**
 * Removes CR/LF from a header value. Without this a newline in a subject or
 * display name lets the caller inject arbitrary headers into the message.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/\r\n[ \t]+/g, ' ').replace(/[\r\n]+/g, ' ')
}

/**
 * Folds a header onto multiple lines (RFC 5322 §2.2.3). Unfolded headers longer
 * than 998 characters — a `To:` with many recipients, for instance — are a
 * protocol violation and get mangled or rejected by strict servers.
 */
export function foldHeader(
  name: string,
  value: string,
  maxLength = 78,
): string {
  const clean = sanitizeHeaderValue(value)
  const start = `${name}: `
  if (start.length + clean.length <= maxLength) {
    return start + clean
  }

  const lines: string[] = []
  let current = start
  let empty = true
  for (const token of clean.split(' ')) {
    if (token === '') {
      // Keep runs of spaces intact rather than folding inside them.
      current += ' '
      continue
    }
    if (empty) {
      current += token
      empty = false
    } else if (current.length + 1 + token.length > maxLength) {
      lines.push(current)
      current = ' ' + token
    } else {
      current += ' ' + token
    }
  }
  lines.push(current)
  return lines.join('\r\n')
}

const ATTRIBUTE_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/

/**
 * Encodes a MIME parameter such as `filename`. Non-ASCII values use the
 * RFC 2231 extended syntax; `filename="Rechnung Ü.pdf"` is not valid MIME.
 */
export function encodeParameter(name: string, value: string): string {
  const clean = sanitizeHeaderValue(value)
  if (!/[^\x20-\x7E]/.test(clean)) {
    return `${name}="${clean.replace(/([\\"])/g, '\\$1')}"`
  }
  let encoded = ''
  for (const byte of encode(clean)) {
    const char = String.fromCharCode(byte)
    encoded += ATTRIBUTE_CHAR.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return `${name}*=UTF-8''${encoded}`
}

export function encodeBase64(data: Uint8Array): string {
  let binary = ''
  // String.fromCharCode(...bytes) blows the stack on large inputs.
  const step = 0x8000
  for (let i = 0; i < data.length; i += step) {
    binary += String.fromCharCode(
      ...(data.subarray(i, i + step) as unknown as number[]),
    )
  }
  return btoa(binary)
}

export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Splits base64 into wire-safe lines. Any whitespace already present in the
 * input is dropped first, otherwise the slicing produces broken lines.
 */
export function wrapBase64(base64: string, lineLength = 76): string {
  const compact = base64.replace(/\s+/g, '')
  if (compact.length <= lineLength) {
    return compact
  }
  const lines: string[] = []
  for (let i = 0; i < compact.length; i += lineLength) {
    lines.push(compact.slice(i, i + lineLength))
  }
  return lines.join('\r\n')
}

/**
 * SMTP dot-stuffing (RFC 5321 §4.5.2) that can be applied chunk by chunk, so a
 * large message never has to exist as a single string.
 */
export function createDotStuffer(): (chunk: string) => string {
  let atLineStart = true
  return (chunk: string) => {
    if (!chunk) {
      return chunk
    }
    let stuffed = chunk.replace(/\r\n\./g, '\r\n..')
    if (atLineStart && stuffed.startsWith('.')) {
      stuffed = `.${stuffed}`
    }
    atLineStart = stuffed.endsWith('\r\n')
    return stuffed
  }
}

function needsQuotedPrintable(byte: number): boolean {
  return (
    byte > 126 ||
    byte === 61 ||
    (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)
  )
}

/** Size the content would have as quoted-printable, ignoring soft line breaks. */
export function estimateQuotedPrintableSize(bytes: Uint8Array): number {
  let escapes = 0
  for (const byte of bytes) {
    if (needsQuotedPrintable(byte)) {
      escapes++
    }
  }
  return bytes.length + escapes * 2
}

export function encodeQuotedPrintable(text: string, lineLength = 76): string {
  const bytes = encode(text)
  // Reserve 3 characters so an '=XX' sequence never straddles a line break.
  const maxLine = lineLength - 3
  const out: string[] = []
  let line = ''
  let i = 0

  const softBreak = () => {
    // Whitespace immediately before a soft break may be stripped in transit.
    const last = line.charCodeAt(line.length - 1)
    if (last === 32) {
      line = line.slice(0, -1) + '=20'
    } else if (last === 9) {
      line = line.slice(0, -1) + '=09'
    }
    out.push(line, '=\r\n')
    line = ''
  }

  while (i < bytes.length) {
    const byte = bytes[i]
    let encoded: string | undefined

    // Handle line breaks (LF, CRLF) and encode a standalone CR
    if (byte === 0x0a) {
      out.push(line, '\r\n')
      line = ''
      i++
      continue
    } else if (byte === 0x0d) {
      if (i + 1 < bytes.length && bytes[i + 1] === 0x0a) {
        out.push(line, '\r\n')
        line = ''
        i += 2
        continue
      }
      encoded = '=0D'
    }

    if (encoded === undefined) {
      const isWhitespace = byte === 0x20 || byte === 0x09
      const nextIsLineBreak =
        i + 1 >= bytes.length || bytes[i + 1] === 0x0a || bytes[i + 1] === 0x0d

      // Encode control characters, non-ASCII, '=' and trailing whitespace.
      encoded =
        needsQuotedPrintable(byte) || (isWhitespace && nextIsLineBreak)
          ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
          : String.fromCharCode(byte)
    }

    if (line.length + encoded.length > maxLine) {
      softBreak()
    }

    line += encoded
    i++
  }

  out.push(line)
  return out.join('')
}
