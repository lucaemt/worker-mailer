# Worker Mailer

[English](./README.md) | [简体中文](./README_zh-CN.md)

[![npm version](https://badge.fury.io/js/worker-mailer.svg)](https://badge.fury.io/js/worker-mailer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Worker Mailer is an SMTP client that runs on Cloudflare Workers. It leverages [Cloudflare TCP Sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) and doesn't rely on any other dependencies.

## Features

- 🚀 Completely built on the Cloudflare Workers runtime with no other dependencies
- 📝 Full TypeScript type support
- 📧 Supports sending plain text and HTML emails with attachments
- 🔒 Supports multiple SMTP authentication methods: `plain`, `login`, `CRAM-MD5` and `XOAUTH2`
- ⚡ Uses SMTP `PIPELINING` so a message with many recipients costs two round trips instead of one per recipient
- 📅 DSN support

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

## Installation

```shell
npm i worker-mailer
```

## Quick Start

1. Configure your `wrangler.toml`:

```toml
compatibility_flags = ["nodejs_compat"]
# or compatibility_flags = ["nodejs_compat_v2"]
```

2. Use in your code:

```typescript
import { WorkerMailer } from 'worker-mailer'

// Connect to SMTP server
const mailer = await WorkerMailer.connect({
  credentials: {
    username: 'bob@acme.com',
    password: 'password',
  },
  authType: 'plain',
  host: 'smtp.acme.com',
  port: 587,
  secure: true,
  // The name announced in EHLO. Receiving servers score it — set it to a domain
  // you control, otherwise the connection announces itself as `[127.0.0.1]`.
  ehloName: 'acme.com',
})

// Send email
await mailer.send({
  from: { name: 'Bob', email: 'bob@acme.com' },
  to: { name: 'Alice', email: 'alice@acme.com' },
  subject: 'Hello from Worker Mailer',
  text: 'This is a plain text message',
  html: '<h1>Hello</h1><p>This is an HTML message</p>',
})
```

3. Using with modern JavaScript frameworks (Next.js, Nuxt, SvelteKit, etc.)

When working with frameworks that use Node.js as their development runtime, you'll need to handle the fact that Cloudflare Workers-specific APIs (like `cloudflare:sockets`) aren't available during local development.

The recommended approach is to use conditional dynamic imports. Here's an example for Nuxt.js:

```typescript
export default defineEventHandler(async event => {
  // Check if running in development environment
  if (import.meta.dev) {
    // Development: Use nodemailer (or any Node.js compatible email library)
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.default.createTransport()
    return await transporter.sendMail()
  } else {
    // Production: Use worker-mailer in Cloudflare Workers environment
    const { WorkerMailer } = await import('worker-mailer')
    const mailer = await WorkerMailer.connect()
    return await mailer.send()
  }
})
```

This pattern ensures your application works seamlessly in both development and production environments.

## API Reference

### WorkerMailer.connect(options)

Creates a new SMTP connection.

```typescript
type WorkerMailerOptions = {
  host: string // SMTP server hostname
  port: number // SMTP server port (usually 587 or 465)
  secure?: boolean // Use TLS (default: false)
  startTls?: boolean // Upgrade to TLS if SMTP server supports (default: true)
  requireTls?: boolean // Fail instead of sending unencrypted (default: false)
  ehloName?: string // Name announced in EHLO (default: '[127.0.0.1]')
  credentials?: {
    // SMTP authentication credentials
    username: string
    password?: string // Required for plain, login and cram-md5
    accessToken?: string // Required for xoauth2
  }
  authType?:
    | 'plain'
    | 'login'
    | 'cram-md5'
    | 'xoauth2'
    | Array<'plain' | 'login' | 'cram-md5' | 'xoauth2'>
  logLevel?: LogLevel // Logging level (default: LogLevel.INFO)
  socketTimeoutMs?: number // Socket timeout in milliseconds (default: 60000)
  responseTimeoutMs?: number // Server response timeout in milliseconds (default: 30000)
  pipelining?: boolean // Batch MAIL/RCPT when the server supports it (default: true)
  chunking?: boolean // Transfer with BDAT when the server supports it (default: false)
  allowPartialRecipients?: boolean // Deliver even if some recipients are rejected (default: false)
  dsn?: {
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
}
```

#### `ehloName`

Every SMTP session opens by announcing a name. Receiving servers feed that name
into their spam scoring, and some reject a name that is not a fully qualified
domain. Set it to a domain you control:

```typescript
await WorkerMailer.connect({ host, port, ehloName: 'mail.acme.com' })
```

A bare IP address is wrapped in the address literal syntax RFC 5321 requires, so
`'203.0.113.7'` is announced as `[203.0.113.7]`.

#### `requireTls`

By default the client upgrades to TLS when the server offers `STARTTLS` and
otherwise authenticates over a plaintext connection. Set `requireTls: true` to
fail the connection instead.

#### `pipelining` and `chunking`

`pipelining` sends `MAIL FROM` and every `RCPT TO` as a single batch when the
server advertises `PIPELINING` (RFC 2920), which is what virtually every server
does. A message to 20 recipients then costs two round trips instead of 22. Turn
it off only to debug against a server that mishandles it.

`chunking` transfers the message with `BDAT` (RFC 3030) instead of `DATA` when
the server advertises `CHUNKING`. Because the message is length delimited it
needs no dot-stuffing pass, which is worthwhile for large attachments. It is off
by default because far less mail traffic goes through `BDAT` than through
`DATA`.

### mailer.send(options)

Sends an email.

```typescript
type EmailOptions = {
  from:
    | string
    | {
        // Sender's email
        name?: string
        email: string
      }
  to:
    | string
    | string[]
    | {
        // Recipients (TO)
        name?: string
        email: string
      }
    | Array<{ name?: string; email: string }>
  reply?:
    | string
    | {
        // Reply-To address
        name?: string
        email: string
      }
  cc?:
    | string
    | string[]
    | {
        // Carbon Copy recipients
        name?: string
        email: string
      }
    | Array<{ name?: string; email: string }>
  bcc?:
    | string
    | string[]
    | {
        // Blind Carbon Copy recipients
        name?: string
        email: string
      }
    | Array<{ name?: string; email: string }>
  subject: string // Email subject
  text?: string // Plain text content
  html?: string // HTML content
  headers?: Record<string, string> // Custom email headers
  attachments?: {
    filename: string
    // Base64 string, or raw bytes which are base64-encoded for you
    content: string | ArrayBuffer | Uint8Array
    mimeType?: string // Inferred from the filename if not set
  }[]
  dsnOverride?: { // overrides dsn defined in WorkerMailer, if not set, it will take the WorkerMailer-Option.
    envelopeId?: string | undefined
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
}
```

#### Return value

`send()` resolves with the outcome of the transaction:

```typescript
type SendResult = {
  accepted: User[] // Recipients the server accepted
  rejected: { user: User; response: string }[] // Recipients it rejected, with the response
  response: string // The server's final response to the message
}
```

By default a single rejected recipient fails the whole message and `send()`
rejects, so `rejected` is only ever populated when `allowPartialRecipients` is
set:

```typescript
const mailer = await WorkerMailer.connect({
  host,
  port,
  allowPartialRecipients: true,
})
const { accepted, rejected } = await mailer.send({ from, to, subject, text })
if (rejected.length) {
  console.warn(
    'Not delivered to',
    rejected.map(r => r.user.email),
  )
}
```

#### Bcc

`bcc` recipients are sent in the SMTP envelope only and never written into the
message, so the other recipients cannot see them. If you deliberately want a
`Bcc` header in the message, set it yourself through `headers`.

### Static Method: WorkerMailer.send()

Send a one-off email without maintaining the connection.

```typescript
await WorkerMailer.send(
  {
    // WorkerMailerOptions
    host: 'smtp.acme.com',
    port: 587,
    credentials: {
      username: 'user',
      password: 'pass',
    },
  },
  {
    // EmailOptions
    from: 'sender@acme.com',
    to: 'recipient@acme.com',
    subject: 'Test',
    text: 'Hello',
    attachments: [
      {
        filename: 'test.txt',
        content: 'SGVsbG8gV29ybGQ=', // base64-encoded string for "Hello World"
        type: 'text/plain',
      },
    ],
  },
)
```

## Limitations

- **Port Restrictions:** Cloudflare Workers cannot make outbound connections on port 25. You won't be able to send emails via port 25, but common ports like 587 and 465 are supported.
- **Connection Limits:** Each Worker instance has a limit on the number of concurrent TCP connections. Make sure to properly close connections when done.

## Contributing

### Development Workflow

> For major changes, please open an issue first to discuss what you would like to change.

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Create a new branch for your feature from `develop`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
4. Make your changes and make sure all tests pass
5. Update README.md & changelog `pnpm changeset` if needed
6. Push your changes to your fork and create a pull request from your branch to `develop`

### Testing

1. Unit Tests:
   ```bash
   npm test
   ```
2. Integration Tests:
   ```bash
   pnpm dlx wrangler dev ./test/worker.ts
   ```
   Then, send a POST request to `http://127.0.0.1:8787` with the following JSON body:
   ```json
   {
     "config": {
       "credentials": {
         "username": "xxx@xx.com",
         "password": "xxxx"
       },
       "authType": "plain",
       "host": "smtp.acme.com",
       "port": 587,
       "secure": false,
       "startTls": true
     },
     "email": {
       "from": "xxx@xx.com",
       "to": "yyy@yy.com",
       "subject": "Test Email",
       "text": "Hello World"
     }
   }
   ```

### Reporting Issues

When reporting issues, please include:

- Version of worker-mailer you're using
- A clear description of the problem
- Steps to reproduce the issue
- Expected vs actual behavior
- Any relevant code snippets or error messages

## License

This project is licensed under the MIT License.
