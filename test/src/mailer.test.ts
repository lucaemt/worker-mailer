import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkerMailer } from '../../src/mailer'
import { connect } from 'cloudflare:sockets'

vi.mock('cloudflare:sockets', () => ({
  connect: vi.fn(),
}))

describe('WorkerMailer', () => {
  let mockSocket: any
  let mockReader: any
  let mockWriter: any

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks()

    // Setup mock socket and reader/writer
    mockReader = {
      read: vi.fn(),
      releaseLock: vi.fn(),
    }
    mockWriter = {
      write: vi.fn(),
      releaseLock: vi.fn(),
    }
    mockSocket = {
      readable: { getReader: () => mockReader },
      writable: { getWriter: () => mockWriter },
      opened: Promise.resolve(),
      close: vi.fn(),
      startTls: vi.fn().mockReturnValue({
        readable: { getReader: () => mockReader },
        writable: { getWriter: () => mockWriter },
      }),
    }

    // Setup connect mock
    ;(connect as any).mockReturnValue(mockSocket)
  })

  const encoder = new TextEncoder()
  const GREETING = '220 smtp.example.com ready\r\n'
  const AUTH_OK = '235 Authentication successful\r\n'
  const credentials = { username: 'test@example.com', password: 'password' }

  /** Queues one socket read per argument, in order. */
  function queueReads(...responses: string[]) {
    for (const response of responses) {
      mockReader.read.mockResolvedValueOnce({ value: encoder.encode(response) })
    }
  }

  /** Builds a multiline EHLO answer from the given capability lines. */
  function ehloResponse(...capabilities: string[]): string {
    const lines = ['smtp.example.com', ...capabilities]
    return lines
      .map(
        (line, index) =>
          `250${index === lines.length - 1 ? ' ' : '-'}${line}\r\n`,
      )
      .join('')
  }

  function writtenData(): string[] {
    return mockWriter.write.mock.calls.map(([data]: any[]) =>
      Buffer.from(data).toString(),
    )
  }

  describe('ehloName', () => {
    it('should announce a valid address literal by default', async () => {
      queueReads(GREETING, ehloResponse('AUTH PLAIN LOGIN'), AUTH_OK)

      await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
      })

      // A bare `127.0.0.1` is neither a FQDN nor an address literal
      expect(writtenData()).toContain('EHLO [127.0.0.1]\r\n')
    })

    it('should announce a configured domain', async () => {
      queueReads(GREETING, ehloResponse('AUTH PLAIN LOGIN'), AUTH_OK)

      await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        ehloName: 'mail.acme.com',
        credentials,
        authType: ['plain'],
      })

      expect(writtenData()).toContain('EHLO mail.acme.com\r\n')
    })

    it('should wrap a bare IP address in brackets', async () => {
      queueReads(GREETING, ehloResponse('AUTH PLAIN LOGIN'), AUTH_OK)

      await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        ehloName: '203.0.113.7',
        credentials,
        authType: ['plain'],
      })

      expect(writtenData()).toContain('EHLO [203.0.113.7]\r\n')
    })

    it('should leave an address literal untouched', async () => {
      queueReads(GREETING, ehloResponse('AUTH PLAIN LOGIN'), AUTH_OK)

      await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        ehloName: '[203.0.113.7]',
        credentials,
        authType: ['plain'],
      })

      expect(writtenData()).toContain('EHLO [203.0.113.7]\r\n')
    })

    it('should use the same name when falling back to HELO', async () => {
      queueReads(GREETING, '500 Command not implemented\r\n', '250 OK\r\n')

      await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        ehloName: 'mail.acme.com',
      })

      expect(writtenData()).toContain('HELO mail.acme.com\r\n')
    })
  })

  describe('pipelining', () => {
    it('should batch MAIL FROM, RCPT TO and DATA into one write', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN', 'PIPELINING'),
        AUTH_OK,
        // The three answers arrive together in a single TCP segment
        '250 Sender OK\r\n250 Recipient OK\r\n354 Start mail input\r\n',
        '250 Message accepted\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
      })
      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Hello World',
      })

      expect(writtenData()).toContain(
        'MAIL FROM: <sender@example.com>\r\n' +
          'RCPT TO: <recipient@example.com>\r\n' +
          'DATA\r\n',
      )
    })

    it('should batch every recipient of a multi-recipient message', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN', 'PIPELINING'),
        AUTH_OK,
        '250 Sender OK\r\n250 OK\r\n250 OK\r\n250 OK\r\n',
        '354 Start mail input\r\n',
        '250 Message accepted\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
      })
      await mailer.send({
        from: 'sender@example.com',
        to: ['a@example.com', 'b@example.com'],
        bcc: 'c@example.com',
        subject: 'Test',
        text: 'Hello World',
      })

      // Several recipients means DATA is held back, so a rejected one can still
      // abort the transaction before the server answers 354.
      expect(writtenData()).toContain(
        'MAIL FROM: <sender@example.com>\r\n' +
          'RCPT TO: <a@example.com>\r\n' +
          'RCPT TO: <b@example.com>\r\n' +
          'RCPT TO: <c@example.com>\r\n',
      )
    })

    it('should not pipeline when the server does not advertise it', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN'),
        AUTH_OK,
        '250 Sender OK\r\n',
        '250 Recipient OK\r\n',
        '354 Start mail input\r\n',
        '250 Message accepted\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
      })
      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Hello World',
      })

      expect(writtenData()).toContain('MAIL FROM: <sender@example.com>\r\n')
      expect(writtenData()).toContain('RCPT TO: <recipient@example.com>\r\n')
      expect(writtenData()).toContain('DATA\r\n')
    })
  })

  describe('recipient handling', () => {
    const twoRecipients = {
      from: 'sender@example.com',
      to: ['good@example.com', 'bad@example.com'],
      subject: 'Test',
      text: 'Hello World',
    }

    it('should fail the message when one recipient is rejected', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN'),
        AUTH_OK,
        '250 Sender OK\r\n',
        '250 Recipient OK\r\n',
        '550 No such user\r\n',
        '250 Reset OK\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
      })

      await expect(mailer.send(twoRecipients)).rejects.toThrow(
        'Invalid RCPT TO: <bad@example.com>',
      )
      // The transaction never entered the data phase
      expect(writtenData()).not.toContain('DATA\r\n')
    })

    it('should deliver to the accepted recipients with allowPartialRecipients', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN'),
        AUTH_OK,
        '250 Sender OK\r\n',
        '250 Recipient OK\r\n',
        '550 No such user\r\n',
        '354 Start mail input\r\n',
        '250 Message accepted\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
        allowPartialRecipients: true,
      })

      const result = await mailer.send(twoRecipients)
      expect(result.accepted).toEqual([{ email: 'good@example.com' }])
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0].user.email).toBe('bad@example.com')
      expect(result.rejected[0].response).toBe('550 No such user')
    })

    it('should report the accepted recipients on success', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN'),
        AUTH_OK,
        '250 Sender OK\r\n',
        '250 Recipient OK\r\n',
        '354 Start mail input\r\n',
        '250 Message accepted\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
      })

      const result = await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Hello World',
      })
      expect(result.accepted).toEqual([{ email: 'recipient@example.com' }])
      expect(result.rejected).toEqual([])
      expect(result.response).toBe('250 Message accepted')
    })
  })

  describe('timeouts and disconnects', () => {
    it('should use responseTimeoutMs rather than socketTimeoutMs', async () => {
      mockReader.read.mockReturnValue(new Promise(() => {})) // never answers

      const started = Date.now()
      await expect(
        WorkerMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          socketTimeoutMs: 30_000,
          responseTimeoutMs: 100,
        }),
      ).rejects.toThrow('Timeout while waiting for smtp server response')
      expect(Date.now() - started).toBeLessThan(2_000)
    })

    it('should fail fast when the server closes the connection', async () => {
      mockReader.read.mockResolvedValue({ done: true, value: undefined })

      const started = Date.now()
      await expect(
        WorkerMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          responseTimeoutMs: 30_000,
        }),
      ).rejects.toThrow('SMTP server closed the connection')
      expect(Date.now() - started).toBeLessThan(2_000)
    })
  })

  describe('capabilities', () => {
    it('should reject a message larger than the advertised SIZE', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN', 'SIZE 1000'),
        AUTH_OK,
        '250 Reset OK\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
      })

      await expect(
        mailer.send({
          from: 'sender@example.com',
          to: 'recipient@example.com',
          subject: 'Test',
          text: 'Hello World',
          attachments: [
            { filename: 'big.bin', content: new Uint8Array(100_000) },
          ],
        }),
      ).rejects.toThrow('accepts at most 1000 bytes')
      // Nothing was transferred
      expect(writtenData()).not.toContain('MAIL FROM: <sender@example.com>\r\n')
    })

    it('should send 8bit content when the server advertises 8BITMIME', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN', 'PIPELINING', '8BITMIME'),
        AUTH_OK,
        '250 Sender OK\r\n250 Recipient OK\r\n354 Start mail input\r\n',
        '250 Message accepted\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
      })
      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: '你好世界',
      })

      const body = writtenData().find(data =>
        data.includes('Content-Transfer-Encoding'),
      )
      expect(body).toContain('Content-Transfer-Encoding: 8bit')
      expect(body).toContain('你好世界')
    })

    it('should reset capabilities on the EHLO after STARTTLS', async () => {
      queueReads(
        GREETING,
        ehloResponse('STARTTLS', 'AUTH PLAIN LOGIN', 'PIPELINING'),
        '220 Ready to start TLS\r\n',
        // The server drops PIPELINING from the post-handshake answer
        ehloResponse('AUTH PLAIN LOGIN'),
        AUTH_OK,
        '250 Sender OK\r\n',
        '250 Recipient OK\r\n',
        '354 Start mail input\r\n',
        '250 Message accepted\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
      })
      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Hello World',
      })

      expect(writtenData()).toContain('MAIL FROM: <sender@example.com>\r\n')
    })

    it('should transfer the message with BDAT when chunking is enabled', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN', 'CHUNKING'),
        AUTH_OK,
        '250 Sender OK\r\n',
        '250 Recipient OK\r\n',
        '250 Message accepted\r\n',
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        authType: ['plain'],
        chunking: true,
      })
      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Hello World',
      })

      const data = writtenData()
      expect(data.some(line => /^BDAT \d+ LAST\r\n$/.test(line))).toBe(true)
      expect(data).not.toContain('DATA\r\n')
      // BDAT is length delimited, so there is no terminator to escape against
      expect(data.some(line => line.endsWith('\r\n.\r\n'))).toBe(false)
    })
  })

  describe('requireTls', () => {
    it('should refuse an unencrypted connection', async () => {
      queueReads(GREETING, ehloResponse('AUTH PLAIN LOGIN'), AUTH_OK)

      await expect(
        WorkerMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          requireTls: true,
          credentials,
          authType: ['plain'],
        }),
      ).rejects.toThrow('requireTls')
    })

    it('should accept a connection upgraded via STARTTLS', async () => {
      queueReads(
        GREETING,
        ehloResponse('STARTTLS', 'AUTH PLAIN LOGIN'),
        '220 Ready to start TLS\r\n',
        ehloResponse('AUTH PLAIN LOGIN'),
        AUTH_OK,
      )

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        requireTls: true,
        credentials,
        authType: ['plain'],
      })
      expect(mailer).toBeInstanceOf(WorkerMailer)
    })
  })

  describe('auth selection', () => {
    it('should honour the order of the configured auth types', async () => {
      queueReads(
        GREETING,
        ehloResponse('AUTH PLAIN LOGIN'),
        '334 VXNlcm5hbWU6\r\n',
        '334 UGFzc3dvcmQ6\r\n',
        AUTH_OK,
      )

      await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
        // LOGIN first, even though the server also offers PLAIN
        authType: ['login', 'plain'],
      })

      expect(writtenData()).toContain('AUTH LOGIN\r\n')
    })

    it('should pick a supported method when none is configured', async () => {
      queueReads(GREETING, ehloResponse('AUTH PLAIN LOGIN'), AUTH_OK)

      await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials,
      })

      expect(writtenData().some(data => data.startsWith('AUTH PLAIN '))).toBe(
        true,
      )
    })

    it('should require an access token for xoauth2', async () => {
      queueReads(GREETING, ehloResponse('AUTH PLAIN XOAUTH2'))

      await expect(
        WorkerMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          credentials: { username: 'test@example.com' },
          authType: ['xoauth2'],
        }),
      ).rejects.toThrow('accessToken')
    })

    it('should authenticate with xoauth2', async () => {
      queueReads(GREETING, ehloResponse('AUTH PLAIN XOAUTH2'), AUTH_OK)

      await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          accessToken: 'ya29.token',
        },
        authType: ['xoauth2'],
      })

      const command = writtenData().find(data =>
        data.startsWith('AUTH XOAUTH2 '),
      )
      expect(command).toBeDefined()
      const payload = atob(command!.slice('AUTH XOAUTH2 '.length).trim())
      expect(payload).toBe(
        'user=test@example.com\u0001auth=Bearer ya29.token\u0001\u0001',
      )
    })
  })

  describe('connection', () => {
    it('should connect to SMTP server successfully', async () => {
      // Mock successful connection sequence
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain', 'login'],
      })

      expect(connect).toHaveBeenCalledWith(
        {
          hostname: 'smtp.example.com',
          port: 587,
        },
        expect.any(Object),
      )
      expect(mailer).toBeInstanceOf(WorkerMailer)
    })

    it('should connect to SMTP server successfully with STARTTLS', async () => {
      // Mock successful connection sequence with STARTTLS
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 Ready to start TLS\r\n'),
        })
        // After STARTTLS, server expects another EHLO
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain', 'login'],
      })

      expect(connect).toHaveBeenCalledWith(
        {
          hostname: 'smtp.example.com',
          port: 587,
        },
        {
          secureTransport: 'starttls',
          allowHalfOpen: false,
        },
      )
      expect(mailer).toBeInstanceOf(WorkerMailer)
    })

    it('should connect to SMTP server successfully without STARTTLS when secure', async () => {
      // Mock successful connection sequence without STARTTLS
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain', 'login'],
      })

      expect(connect).toHaveBeenCalledWith(
        {
          hostname: 'smtp.example.com',
          port: 465,
        },
        {
          secureTransport: 'on',
          allowHalfOpen: false,
        },
      )
      expect(mailer).toBeInstanceOf(WorkerMailer)
    })

    it('should throw error on connection timeout', async () => {
      mockSocket.opened = new Promise(() => {}) // Never resolves

      await expect(
        WorkerMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          socketTimeoutMs: 100,
        }),
      ).rejects.toThrow('Socket timeout!')
    })
  })

  describe('server capabilities', () => {
    it('should parse server capabilities correctly', async () => {
      // Mock server response with various capabilities
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN CRAM-MD5\r\n250 HELP\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 Ready to start TLS\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      expect(mailer).toBeInstanceOf(WorkerMailer)
      // Verify that STARTTLS was initiated due to server capability
      expect(mockSocket.startTls).toHaveBeenCalled()
    })

    it('should handle server without STARTTLS capability', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      expect(mailer).toBeInstanceOf(WorkerMailer)
      // Verify that STARTTLS was not attempted
      expect(mockSocket.startTls).not.toHaveBeenCalled()
    })
  })

  describe('authentication', () => {
    it('should authenticate with PLAIN auth', async () => {
      // Mock successful connection and auth sequence
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      // Verify AUTH PLAIN command was sent
      expect(mockWriter.write).toHaveBeenCalledWith(
        expect.any(Uint8Array), // Contains base64 encoded credentials
      )
    })

    it('should throw error on auth failure', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('535 Authentication failed\r\n'),
        })

      await expect(
        WorkerMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          credentials: {
            username: 'test@example.com',
            password: 'wrong',
          },
          authType: ['plain'],
        }),
      ).rejects.toThrow('Failed to plain authentication')
    })
  })

  describe('dsn', () => {
    it('should not send DSN if not supported', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
        dsn: {
          RET: {
            HEADERS: true,
            FULL: false,
          },
          NOTIFY: {
            DELAY: true,
            FAILURE: true,
            SUCCESS: false,
          },
        },
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email with DSN',
        text: 'Hello World',
        dsnOverride: {
          envelopeId: '1234567890',
          RET: {
            HEADERS: false,
            FULL: true,
          },
          NOTIFY: {
            DELAY: false,
            FAILURE: false,
            SUCCESS: true,
          },
        },
      })

      const normalize = (str: string) => str.replace(/\s+/g, ' ').trim()
      const calls = mockWriter.write.mock.calls.map(([arg]: any[]) =>
        normalize(Buffer.from(arg).toString()),
      )

      expect(
        calls.some((call: string) =>
          call.includes(normalize('MAIL FROM: <sender@example.com>')),
        ),
      ).toBe(true)
      expect(
        calls.some((call: string) =>
          call.includes(normalize('RCPT TO: <recipient@example.com>')),
        ),
      ).toBe(true)
    })

    it('dsnOverride should override dsn', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250-AUTH=PLAIN LOGIN\r\n250 DSN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
        dsn: {
          RET: {
            HEADERS: true,
            FULL: false,
          },
          NOTIFY: {
            DELAY: true,
            FAILURE: true,
            SUCCESS: false,
          },
        },
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email with DSN',
        text: 'Hello World',
        dsnOverride: {
          envelopeId: '1234567890',
          RET: {
            HEADERS: false,
            FULL: true,
          },
          NOTIFY: {
            DELAY: false,
            FAILURE: false,
            SUCCESS: true,
          },
        },
      })

      const normalize = (str: string) => str.replace(/\s+/g, ' ').trim()
      const calls = mockWriter.write.mock.calls.map(([arg]: any[]) =>
        normalize(Buffer.from(arg).toString()),
      )

      expect(
        calls.some((call: string) =>
          call.includes(
            normalize(
              'MAIL FROM: <sender@example.com> RET=FULL ENVID=1234567890',
            ),
          ),
        ),
      ).toBe(true)
      expect(
        calls.some((call: string) =>
          call.includes(
            normalize('RCPT TO: <recipient@example.com> NOTIFY=SUCCESS'),
          ),
        ),
      ).toBe(true)
    })

    it('should send email with DSN request', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250-AUTH=PLAIN LOGIN\r\n250 DSN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
        dsn: {
          RET: {
            HEADERS: true,
            FULL: false,
          },
          NOTIFY: {
            DELAY: true,
            FAILURE: true,
            SUCCESS: true,
          },
        },
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email with DSN',
        text: 'This is a DSN test email',
        dsnOverride: {
          envelopeId: '1234567890',
        },
      })

      const normalize = (str: string) => str.replace(/\s+/g, ' ').trim()
      const calls = mockWriter.write.mock.calls.map(([arg]: any[]) =>
        normalize(Buffer.from(arg).toString()),
      )

      expect(
        calls.some((call: string) =>
          call.includes(
            normalize(
              'RCPT TO: <recipient@example.com> NOTIFY=SUCCESS,FAILURE,DELAY',
            ),
          ),
        ),
      ).toBe(true)
      expect(
        calls.some((call: string) =>
          call.includes(
            normalize(
              'MAIL FROM: <sender@example.com> RET=HDRS ENVID=1234567890',
            ),
          ),
        ),
      ).toBe(true)
    })
  })

  describe('email sending', () => {
    it('should send email successfully', async () => {
      // Mock successful connection, auth and send sequence
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email',
        text: 'Hello World',
      })

      // Verify email commands were sent
      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // MAIL FROM
      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // RCPT TO
      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // DATA
      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // Email content
    })

    it('should handle recipient rejection', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('550 Recipient rejected\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      const sendPromise = mailer.send({
        from: 'sender@example.com',
        to: 'invalid@example.com',
        subject: 'Test Email',
        text: 'Hello World',
      })

      await expect(sendPromise).rejects.toThrow('Invalid RCPT TO')
    })
  })

  describe('close', () => {
    it('should close connection properly', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await WorkerMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      await mailer.close()

      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // QUIT command
      expect(mockSocket.close).toHaveBeenCalled()
    })
  })
})
