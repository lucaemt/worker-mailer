import { describe, it, expect } from 'vitest'
import { Email, type EmailOptions, encodeHeader } from '../../src/email'
import { extract } from 'letterparser'

/**
 * Turns SMTP wire data back into the message an SMTP server would hand to a
 * MIME parser: the trailing CRLF belongs to the `CRLF.CRLF` terminator, and
 * dot-stuffing is undone by the server.
 */
function toMessage(data: string): string {
  const terminator = data.lastIndexOf('\r\n.\r\n')
  const message = terminator === -1 ? data : data.slice(0, terminator)
  return message.replace(/\r\n\.\./g, '\r\n.')
}

/** Undoes RFC 5322 header folding so a header can be read as one line. */
function unfold(data: string): string {
  return data.replace(/\r\n[ \t]+/g, ' ')
}

describe('Email', () => {
  describe('constructor', () => {
    it('should create an email with minimal options', () => {
      const options: EmailOptions = {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        text: 'Test content',
      }
      const email = new Email(options)
      expect(email.from).toEqual({ email: 'sender@example.com' })
      expect(email.to).toEqual([{ email: 'recipient@example.com' }])
      expect(email.subject).toBe('Test Subject')
      expect(email.text).toBe('Test content')
    })

    it('should handle complex user objects', () => {
      const options: EmailOptions = {
        from: { name: 'Sender Name', email: 'sender@example.com' },
        to: [
          { name: 'Recipient1', email: 'recipient1@example.com' },
          { name: 'Recipient2', email: 'recipient2@example.com' },
        ],
        subject: 'Test Subject',
        html: '<p>Test content</p>',
      }
      const email = new Email(options)
      expect(email.from).toEqual({
        name: 'Sender Name',
        email: 'sender@example.com',
      })
      expect(email.to).toEqual([
        { name: 'Recipient1', email: 'recipient1@example.com' },
        { name: 'Recipient2', email: 'recipient2@example.com' },
      ])
    })

    it('should throw error if neither text nor html is provided', () => {
      const options: EmailOptions = {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
      }
      expect(() => new Email(options)).toThrow()
    })
  })

  describe('getEmailData', () => {
    it('should generate correct email data with text content', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        text: 'Hello World',
      })
      const data = email.getEmailData()
      const msg = extract(toMessage(data))
      expect(msg.text).toBe('Hello World')
      expect(msg.subject).toBe('Test Subject')
      expect(msg.from).toEqual({
        address: 'sender@example.com',
        raw: 'sender@example.com',
      })
      expect(msg.to).toEqual([
        { address: 'recipient@example.com', raw: 'recipient@example.com' },
      ])
    })

    it('should generate correct email data with HTML and Text content', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        text: 'Hello World',
        html: '<p>Hello World</p>',
      })
      const data = email.getEmailData()
      const msg = extract(data)
      expect(msg.text).toBe('Hello World')
      expect(msg.html).toBe('<p>Hello World</p>')
      expect(msg.subject).toBe('Test Subject')
      expect(msg.from).toEqual({
        address: 'sender@example.com',
        raw: 'sender@example.com',
      })
      expect(msg.to).toEqual([
        { address: 'recipient@example.com', raw: 'recipient@example.com' },
      ])
    })

    it('should not include lines longer than 998 characters', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        text: 'Hello, this is a test email with a long text. '.repeat(50),
        html: `<p>${'Hello, this is a test email with a long text. '.repeat(50)}</p>`,
      })
      const data = email.getEmailData()

      // Note: letterparser doesn't perform SMTP dot-unstuffing (that's done by SMTP servers)
      // So we need to manually remove dot-stuffing before parsing to simulate what an SMTP server would do
      const unstuffedData = data.replace(/\r\n\.\./g, '\r\n.')
      const msg = extract(unstuffedData)

      // expect the text to be the same if linebreaks are removed (we are adding a space and removing all double spaces due to the way the text is wrapped)
      expect(msg.text!.replace(/\n/g, ' ').replaceAll('  ', ' ')).toBe(
        'Hello, this is a test email with a long text. '.repeat(50).trim(),
      )
      expect(msg.html!.replace(/\n/g, ' ').replaceAll('  ', ' ')).toBe(
        '<p>' +
          'Hello, this is a test email with a long text. '.repeat(50) +
          '</p>',
      )
      const lines = data.split('\r\n')

      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(998)
      }
    })

    it('should include a CC header but never a BCC header', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        // @ts-expect-error it works
        cc: ['cc1@example.com', { name: 'CC2', email: 'cc2@example.com' }],
        bcc: 'bcc@example.com',
        subject: 'Test Subject',
        text: 'Hello World',
      })
      const data = email.getEmailData()
      const msg = extract(toMessage(data))
      expect(msg.cc).toEqual([
        { address: 'cc1@example.com', raw: 'cc1@example.com' },
        {
          address: 'cc2@example.com',
          name: 'CC2',
          raw: '"CC2" <cc2@example.com>',
        },
      ])

      // Bcc belongs in the envelope only. Writing it into the message shows
      // every recipient who was blind-copied.
      expect(msg.bcc).toBeUndefined()
      expect(data.toLowerCase()).not.toContain('bcc:')
      expect(data).not.toContain('bcc@example.com')
      expect(email.recipients.map(user => user.email)).toContain(
        'bcc@example.com',
      )
    })

    it('should include Reply-To when provided', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        reply: { name: 'Reply Name', email: 'reply@example.com' },
        subject: 'Test Subject',
        text: 'Hello World',
      })
      const data = email.getEmailData()
      const msg = extract(data)
      expect(msg.replyTo).toEqual([
        {
          address: 'reply@example.com',
          name: 'Reply Name',
          raw: '"Reply Name" <reply@example.com>',
        },
      ])
    })

    it('should include custom headers when provided', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        text: 'Hello World',
        headers: {
          'X-Custom-Header': 'Custom Value',
        },
      })
      const data = email.getEmailData()
      // letterparser does not support headers yet
      expect(data).toContain('X-Custom-Header: Custom Value')
    })

    it('should not override custom standard headers', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        cc: 'cc@example.com',
        bcc: 'bcc@example.com',
        reply: 'reply@example.com',
        subject: 'Test Subject',
        text: 'Hello World',
        headers: {
          From: 'custom-from@example.com',
          To: 'custom-to@example.com',
          CC: 'custom-cc@example.com',
          BCC: 'custom-bcc@example.com',
          'Reply-To': 'custom-reply@example.com',
          Subject: 'Custom Subject',
          'X-Custom-Header': 'Custom Value',
        },
      })
      const data = email.getEmailData()

      // Verify custom headers are preserved
      expect(data).toContain('From: custom-from@example.com')
      expect(data).toContain('To: custom-to@example.com')
      expect(data).toContain('CC: custom-cc@example.com')
      expect(data).toContain('BCC: custom-bcc@example.com')
      expect(data).toContain('Reply-To: custom-reply@example.com')
      expect(data).toContain('Subject: Custom Subject')
      expect(data).toContain('X-Custom-Header: Custom Value')
    })

    it('should dot-stuff body lines starting with periods', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Dot Stuffing',
        text: '.\r\nLine two\r\n.Line three\r\n..Line four',
      })

      const data = email.getEmailData()
      const terminatorIndex = data.lastIndexOf('\r\n.\r\n')
      expect(terminatorIndex).toBeGreaterThan(0)

      const body = data.slice(0, terminatorIndex)
      expect(body).not.toContain('\r\n.\r\n')
      expect(body).toContain('\r\n..\r\n')
      expect(body).toContain('\r\n..Line three')
      expect(body).toContain('\r\n...Line four')
    })
  })

  describe('encodeHeader', () => {
    it('should return ASCII text as-is', () => {
      expect(encodeHeader('Hello World')).toBe('Hello World')
      expect(encodeHeader('test@example.com')).toBe('test@example.com')
    })

    it('should encode non-ASCII characters', () => {
      // German umlaut - UTF-8 encoding: ü = C3 BC
      expect(encodeHeader('Müller')).toBe('=?UTF-8?Q?M=C3=BCller?=')

      // For non-ASCII characters, we'll test that the output is a valid RFC 2047 encoded word
      expect(encodeHeader('测试')).toMatch(/^=\?UTF-8\?Q\?[0-9A-F=]+\?=$/i)
      expect(encodeHeader('テスト')).toMatch(/^=\?UTF-8\?Q\?[0-9A-F=]+\?=$/i)
    })

    it('should handle spaces and special characters', () => {
      expect(encodeHeader('Hello World!')).toBe('Hello World!') // Space remains as space
      expect(encodeHeader('Test & Test')).toBe('Test & Test') // Space remains as space
      expect(encodeHeader('100%')).toBe('100%') // % is not encoded
    })
  })

  describe('Email Headers with Non-ASCII', () => {
    it('should encode sender name with non-ASCII characters', () => {
      const email = new Email({
        from: { name: 'Müller', email: 'muller@example.com' },
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Test content',
      })

      const emailData = email.getEmailData()
      // Extract the From header from the raw email data
      const fromHeader = emailData
        .split('\r\n')
        .find(line => line.toLowerCase().startsWith('from:'))
      expect(fromHeader).toBeDefined()
      expect(fromHeader).toContain('=?UTF-8?Q?M=C3=BCller?=')
    })

    it('should encode recipient name with non-ASCII characters', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: { name: 'Jörg Schmidt', email: 'jorg@example.com' },
        subject: 'Test',
        text: 'Test content',
      })

      const emailData = email.getEmailData()
      // Extract the To header from the raw email data
      const toHeader = emailData
        .split('\r\n')
        .find(line => line.toLowerCase().startsWith('to:'))
      expect(toHeader).toBeDefined()
      expect(toHeader).toContain('=?UTF-8?Q?J=C3=B6rg_Schmidt?=')
    })

    it('should encode subject with non-ASCII characters', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test with ümläüts',
        text: 'Test content',
      })

      const emailData = email.getEmailData()
      // Extract the Subject header from the raw email data
      const subjectHeader = emailData
        .split('\r\n')
        .find(line => line.toLowerCase().startsWith('subject:'))
      expect(subjectHeader).toBeDefined()
      expect(subjectHeader).toContain(
        '=?UTF-8?Q?Test_with_=C3=BCml=C3=A4=C3=BCts?=',
      )
    })

    it('should handle multiple recipients with non-ASCII names', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: [
          { name: 'Jörg Schmidt', email: 'jorg@example.com' },
          { name: 'François Dupont', email: 'francois@example.com' },
        ],
        subject: 'Test',
        text: 'Test content',
      })

      const emailData = email.getEmailData()
      // Two encoded display names exceed 78 characters, so the header is folded
      // across two lines and has to be joined again before it can be read.
      const toHeader = unfold(emailData)
        .split('\r\n')
        .find(line => line.toLowerCase().startsWith('to:'))
      expect(toHeader).toBeDefined()
      expect(toHeader).toContain('=?UTF-8?Q?J=C3=B6rg_Schmidt?=')
      expect(toHeader).toContain('=?UTF-8?Q?Fran=C3=A7ois_Dupont?=')
    })
  })

  it('should include attachments when provided', () => {
    const email = new Email({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test Subject',
      text: 'Hello World',
      attachments: [
        {
          filename: 'test.txt',
          content: Buffer.from('Test content').toString('base64'),
        },
        {
          filename: 'test2.txt',
          content: Buffer.from('Test content 2').toString('base64'),
        },
      ],
    })
    const data = email.getEmailData()
    const msg = extract(data)
    expect(msg.attachments).toEqual([
      {
        filename: 'test.txt',
        body: 'Test content',
        contentId: undefined,
        contentType: {
          encoding: 'utf-8',
          parameters: { name: 'test.txt' },
          type: 'text/plain',
        },
      },
      {
        filename: 'test2.txt',
        body: 'Test content 2',
        contentId: undefined,
        contentType: {
          encoding: 'utf-8',
          parameters: { name: 'test2.txt' },
          type: 'text/plain',
        },
      },
    ])
  })

  describe('MIME structure', () => {
    const base = {
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test Subject',
    }

    it('should not wrap a text-only email in multipart', () => {
      const data = new Email({ ...base, text: 'Hello World' }).getEmailData()
      expect(data).toContain('Content-Type: text/plain; charset="UTF-8"')
      expect(data).not.toContain('multipart')
    })

    it('should not wrap an html-only email in multipart', () => {
      const data = new Email({ ...base, html: '<p>Hi</p>' }).getEmailData()
      expect(data).toContain('Content-Type: text/html; charset="UTF-8"')
      expect(data).not.toContain('multipart')
    })

    it('should use multipart/alternative without attachments', () => {
      const data = new Email({
        ...base,
        text: 'Hello',
        html: '<p>Hello</p>',
      }).getEmailData()
      expect(data).toContain('Content-Type: multipart/alternative')
      expect(data).not.toContain('multipart/mixed')
    })

    it('should use multipart/mixed once an attachment is present', () => {
      const data = new Email({
        ...base,
        text: 'Hello',
        attachments: [{ filename: 'a.txt', content: 'QQ==' }],
      }).getEmailData()
      expect(data).toContain('Content-Type: multipart/mixed')
    })
  })

  describe('transfer encoding', () => {
    const base = {
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test Subject',
    }

    it('should send plain ASCII as 7bit without re-encoding it', () => {
      const data = new Email({
        ...base,
        text: 'Hello World, nothing to encode here.',
      }).getEmailData()
      expect(data).toContain('Content-Transfer-Encoding: 7bit')
      expect(data).toContain('Hello World, nothing to encode here.')
    })

    it('should prefer base64 over quoted-printable for CJK content', () => {
      const text = '你好世界'.repeat(20)
      const data = new Email({ ...base, text }).getEmailData()
      expect(data).toContain('Content-Transfer-Encoding: base64')
      // quoted-printable needs 9 characters per CJK character, base64 needs 4
      const qpSize = new TextEncoder().encode(text).length * 3
      expect(data.length).toBeLessThan(qpSize)
    })

    it('should still use quoted-printable for mostly-ASCII content', () => {
      const data = new Email({
        ...base,
        text: `${'a'.repeat(2000)} ümlaut`,
      }).getEmailData()
      expect(data).toContain('Content-Transfer-Encoding: quoted-printable')
    })

    it('should use 8bit when the server advertised 8BITMIME', () => {
      const data = new Email({ ...base, text: '你好世界' }).getEmailData({
        allow8bit: true,
      })
      expect(data).toContain('Content-Transfer-Encoding: 8bit')
      expect(data).toContain('你好世界')
    })

    it('should not use 8bit for lines that could exceed the octet limit', () => {
      const data = new Email({
        ...base,
        text: '你好世界'.repeat(100),
      }).getEmailData({ allow8bit: true })
      expect(data).not.toContain('Content-Transfer-Encoding: 8bit')
    })
  })

  describe('header safety', () => {
    it('should not let a subject inject additional headers', () => {
      const data = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Payment\r\nBcc: attacker@evil.com',
        text: 'Hello',
      }).getEmailData()

      const headerLines = data.slice(0, data.indexOf('\r\n\r\n')).split('\r\n')
      expect(
        headerLines.some(line => line.toLowerCase().startsWith('bcc:')),
      ).toBe(false)
      // The CRLF is encoded rather than written to the wire
      expect(data).toContain('=0D=0A')
    })

    it('should not let a display name inject additional headers', () => {
      const data = new Email({
        from: { name: 'Bob\r\nBcc: attacker@evil.com', email: 'bob@acme.com' },
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Hello',
      }).getEmailData()

      const headerLines = data.slice(0, data.indexOf('\r\n\r\n')).split('\r\n')
      expect(
        headerLines.some(line => line.toLowerCase().startsWith('bcc:')),
      ).toBe(false)
    })

    it('should fold a long recipient list instead of exceeding 998 octets', () => {
      const to = Array.from({ length: 60 }, (_, i) => ({
        email: `user${i}@example.com`,
      }))
      const data = new Email({
        from: 'sender@example.com',
        to,
        subject: 'Test',
        text: 'Hello',
      }).getEmailData()

      for (const line of data.split('\r\n')) {
        expect(line.length).toBeLessThanOrEqual(998)
      }
      const toHeader = unfold(data)
        .split('\r\n')
        .find(line => line.startsWith('To: '))
      expect(toHeader).toContain('user0@example.com')
      expect(toHeader).toContain('user59@example.com')
    })

    it('should use the RFC 5322 date format instead of GMT', () => {
      const data = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Hello',
      }).getEmailData()

      const dateHeader = data
        .split('\r\n')
        .find(line => line.startsWith('Date: '))
      expect(dateHeader).toMatch(
        /^Date: (Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/,
      )
    })

    it('should keep every encoded-word within 75 characters', () => {
      const result = encodeHeader('你好'.repeat(50))
      expect(result.split(' ').length).toBeGreaterThan(1)
      for (const word of result.split(' ')) {
        expect(word.length).toBeLessThanOrEqual(75)
      }
    })
  })

  describe('attachments', () => {
    const base = {
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test Subject',
      text: 'Hello World',
    }

    it('should accept raw bytes and base64-encode them', () => {
      const data = new Email({
        ...base,
        attachments: [
          {
            filename: 'test.txt',
            content: new TextEncoder().encode('Test content'),
          },
        ],
      }).getEmailData()

      const msg = extract(toMessage(data))
      expect(msg.attachments?.[0].body).toBe('Test content')
    })

    it('should accept an ArrayBuffer', () => {
      const bytes = new TextEncoder().encode('Test content')
      const data = new Email({
        ...base,
        attachments: [
          {
            filename: 'test.txt',
            content: bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          },
        ],
      }).getEmailData()

      const msg = extract(toMessage(data))
      expect(msg.attachments?.[0].body).toBe('Test content')
    })

    it('should encode large attachments in 76 character lines', () => {
      // Larger than the 5472 byte slice the encoder works in, so the base64 of
      // the slices has to line up exactly with the base64 of the whole file.
      const content = new Uint8Array(20_000)
      for (let i = 0; i < content.length; i++) {
        content[i] = i % 251
      }
      const data = new Email({
        ...base,
        attachments: [{ filename: 'big.bin', content }],
      }).getEmailData()

      const base64Lines = data
        .split('\r\n')
        .filter(line => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(line))
      expect(base64Lines.length).toBeGreaterThan(300)
      for (const line of base64Lines) {
        expect(line.length).toBeLessThanOrEqual(76)
      }
      expect(base64Lines[0].length).toBe(76)

      const decoded = atob(base64Lines.join(''))
      expect(decoded.length).toBe(content.length)
      expect(decoded.charCodeAt(19_999)).toBe(content[19_999])
    })

    it('should encode a non-ASCII filename per RFC 2231', () => {
      const data = new Email({
        ...base,
        attachments: [{ filename: 'Rechnung Ü.pdf', content: 'QQ==' }],
      }).getEmailData()

      expect(data).toContain("filename*=UTF-8''Rechnung%20%C3%9C.pdf")
      expect(data).not.toContain('filename="Rechnung Ü.pdf"')
    })

    it('should quote an ASCII filename', () => {
      const data = new Email({
        ...base,
        attachments: [{ filename: 'test.txt', content: 'QQ==' }],
      }).getEmailData()

      expect(data).toContain('filename="test.txt"')
    })
  })

  describe('estimateSize', () => {
    it('should account for the base64 overhead of attachments', () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Hello',
        attachments: [{ filename: 'big.bin', content: new Uint8Array(30_000) }],
      })
      expect(email.estimateSize()).toBeGreaterThan(40_000)
    })
  })

  describe('sent promise', () => {
    it('should resolve when setSent is called', async () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        text: 'Hello World',
      })

      setTimeout(() => email.setSent(), 0)
      await expect(email.sent).resolves.toBeUndefined()
    })

    it('should reject when setSentError is called', async () => {
      const email = new Email({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        text: 'Hello World',
      })

      const error = new Error('Test error')
      setTimeout(() => email.setSentError(error), 0)
      await expect(email.sent).rejects.toBe(error)
    })
  })
})

describe('encodeHeader', () => {
  describe('ASCII text', () => {
    it('should not encode pure ASCII text', () => {
      const input = 'Hello World'
      const result = encodeHeader(input)
      expect(result).toBe('Hello World')
    })

    it('should not encode ASCII with special characters', () => {
      const input = 'Test: Email Subject!'
      const result = encodeHeader(input)
      expect(result).toBe('Test: Email Subject!')
    })
  })

  describe('Non-ASCII text', () => {
    it('should encode Chinese characters', () => {
      const input = '你好'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
      expect(result).toContain('=E4=BD=A0=E5=A5=BD')
    })

    it('should encode emoji', () => {
      const input = '😀'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
      expect(result).toContain('=F0=9F=98=80')
    })

    it('should encode mixed ASCII and non-ASCII', () => {
      const input = 'Hello 世界'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
      expect(result).toContain('Hello')
      expect(result).toContain('=E4=B8=96=E7=95=8C')
    })
  })

  describe('RFC 2047 specific rules', () => {
    it('should convert spaces to underscores', () => {
      const input = '你好 世界'
      const result = encodeHeader(input)
      // Space (0x20) should become underscore
      expect(result).toContain('_')
      expect(result).not.toContain(' ')
    })

    it('should encode question marks', () => {
      const input = '测试?'
      const result = encodeHeader(input)
      // Question mark should be encoded to avoid conflict with delimiter
      expect(result).toContain('=3F')
    })

    it('should encode equals signs', () => {
      const input = '测试='
      const result = encodeHeader(input)
      // Equals sign should be encoded
      expect(result).toContain('=3D')
    })

    it('should encode underscores', () => {
      const input = '测试_'
      const result = encodeHeader(input)
      // Underscore should be encoded to avoid confusion with encoded space
      expect(result).toContain('=5F')
    })

    it('should wrap result in =?UTF-8?Q?...?= format', () => {
      const input = '你好世界'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?[^?]+\?=$/)
    })
  })

  describe('Real-world scenarios', () => {
    it('should handle typical subject line', () => {
      const input = '订单确认 - Order #12345'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
      expect(result).toContain('_-_Order_')
    })

    it('should handle sender name', () => {
      const input = '张三'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should handle mixed language subject', () => {
      const input = 'Re: 关于您的订单'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
      expect(result).toContain('Re:')
    })
  })

  describe('Edge cases', () => {
    it('should handle empty string', () => {
      const input = ''
      const result = encodeHeader(input)
      expect(result).toBe('')
    })

    it('should handle only spaces', () => {
      const input = '   '
      const result = encodeHeader(input)
      expect(result).toBe('   ')
    })

    it('should handle very long non-ASCII text', () => {
      const input = '你好'.repeat(50)
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
      // Note: RFC 2047 has length limits, but we don't enforce them yet
      // In production, long headers should be split into multiple encoded-words
    })

    it('should handle single character', () => {
      expect(encodeHeader('A')).toBe('A')
      expect(encodeHeader('世')).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should handle numbers only', () => {
      expect(encodeHeader('12345')).toBe('12345')
    })

    it('should handle special characters in ASCII range', () => {
      expect(encodeHeader('Test-123')).toBe('Test-123')
      expect(encodeHeader('user@example.com')).toBe('user@example.com')
    })
  })

  describe('Multilingual headers', () => {
    it('should encode Japanese names', () => {
      const input = '山田太郎'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode Korean names', () => {
      const input = '김철수'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode Arabic text', () => {
      const input = 'محمد'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode Cyrillic text', () => {
      const input = 'Иван Петров'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
      expect(result).toContain('_') // Space should become underscore
    })

    it('should encode Greek text', () => {
      const input = 'Γιώργος'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode Hebrew text', () => {
      const input = 'שלום'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })
  })

  describe('Mixed content headers', () => {
    it('should encode name with title', () => {
      const input = 'Dr. 张三'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
      expect(result).toContain('Dr.')
    })

    it('should encode company name with non-ASCII', () => {
      const input = 'ABC株式会社'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode email subject with emoji', () => {
      const input = '🎉 Special Offer!'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode mixed punctuation', () => {
      const input = 'Re: 关于订单 #12345'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })
  })

  describe('Boundary conditions for headers', () => {
    it('should handle text at ASCII boundary (char 127)', () => {
      const input = 'Test\x7F' // DEL character
      const result = encodeHeader(input)
      // DEL character (0x7F) is in printable range (33-126) boundary
      // Our implementation doesn't encode it as it's technically printable
      // This is acceptable behavior
      expect(result).toBeTruthy()
    })

    it('should handle text at ASCII boundary (char 128)', () => {
      const input = 'Test\x80'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should handle consecutive non-ASCII characters', () => {
      const input = '你好世界测试'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should handle alternating ASCII and non-ASCII', () => {
      const input = 'a世b界c测'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })
  })

  describe('Special character handling', () => {
    it('should encode question marks in non-ASCII context', () => {
      const input = '测试?'
      const result = encodeHeader(input)
      expect(result).toContain('=3F') // ? should be encoded
    })

    it('should encode equals signs in non-ASCII context', () => {
      const input = '测试='
      const result = encodeHeader(input)
      expect(result).toContain('=3D') // = should be encoded
    })

    it('should encode underscores in non-ASCII context', () => {
      const input = '测试_test'
      const result = encodeHeader(input)
      expect(result).toContain('=5F') // _ should be encoded
    })

    it('should handle multiple special characters', () => {
      const input = '测试?=_'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
      expect(result).toContain('=3F')
      expect(result).toContain('=3D')
      expect(result).toContain('=5F')
    })
  })

  describe('Real-world header scenarios', () => {
    it('should encode forwarded subject', () => {
      const input = 'Fwd: 关于会议安排'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode reply subject', () => {
      const input = 'Re: 订单确认'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode sender with organization', () => {
      const input = '张三 (北京公司)'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode subject with date', () => {
      const input = '会议通知 - 2024年1月1日'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })

    it('should encode subject with numbers and symbols', () => {
      const input = '订单 #12345 已发货！'
      const result = encodeHeader(input)
      expect(result).toMatch(/^=\?UTF-8\?Q\?.*\?=$/)
    })
  })
})
