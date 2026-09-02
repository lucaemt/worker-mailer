# @luca-emmert/worker-mailer

## 1.3.0

### Minor Changes

- Reworked the sending path for correctness, deliverability and latency.

  **Deliverability and correctness**

  - `bcc` recipients are no longer written into the message headers. They were
    visible to every recipient; they now travel in the SMTP envelope only.
  - Headers are folded per RFC 5322. A long recipient list previously produced a
    single line above the 998 octet limit, which strict servers mangle or reject.
  - CR/LF in a subject, display name or filename is encoded instead of being
    written to the wire, closing a header injection hole.
  - Encoded-words are split at the 75 character limit RFC 2047 sets, and are no
    longer emitted inside a quoted-string.
  - `Date` uses the RFC 5322 `+0000` zone instead of the obsolete `GMT`.
  - Non-ASCII attachment filenames are encoded per RFC 2231.
  - New `ehloName` option. The client announced a bare `127.0.0.1`, which is
    neither a FQDN nor an address literal; it now defaults to `[127.0.0.1]` and
    should be set to a domain you control. A bare IP is bracketed for you.

  **Latency and payload size**

  - `MAIL FROM` and every `RCPT TO` are sent as one batch when the server
    advertises `PIPELINING`. A message to 20 recipients costs two round trips
    instead of 22. Opt out with `pipelining: false`.
  - Message parts pick the cheapest safe transfer encoding (`7bit`, `8bit` when
    the server advertises `8BITMIME`, otherwise the smaller of quoted-printable
    and base64). Non-ASCII bodies were previously inflated roughly threefold.
  - A message with no attachments is no longer wrapped in `multipart/mixed`, and a
    text-only message is no longer wrapped in multipart at all.
  - The message is generated and written in chunks, so a large attachment no
    longer exists several times over as a single string.
  - Attachments accept `ArrayBuffer` and `Uint8Array` in addition to base64.
  - Optional `chunking` option transfers the message with `BDAT` (RFC 3030) when
    the server advertises `CHUNKING`, skipping the dot-stuffing pass.
  - A message larger than the server's advertised `SIZE` is rejected locally
    instead of after the transfer.

  **Protocol robustness**

  - The response reader buffers what it receives. Previously a second response
    arriving in the same TCP segment was dropped, and a closed connection spun in
    a busy loop until the timeout fired.
  - `responseTimeoutMs` was reading `socketTimeoutMs` and had no effect.
  - `execTimeout` clears its timer instead of leaving it pending.
  - EHLO capabilities are reset before the answer after `STARTTLS` is parsed.
  - `authType` is honoured as a preference order, and a supported method is picked
    automatically when none is configured.
  - New `xoauth2` auth type with `credentials.accessToken`.
  - New `requireTls` option to refuse authenticating over a plaintext connection.
  - Credentials are base64-encoded as UTF-8, so a non-ASCII password no longer
    throws, and the CRAM-MD5 challenge is decoded as bytes rather than text.
  - `send()` resolves with `{ accepted, rejected, response }`. With the new
    `allowPartialRecipients` option the message is delivered to the recipients the
    server accepted instead of failing entirely.

## 1.2.1

### Patch Changes

- 18cd709: fix: implement SMTP dot-stuffing (rfc 5321)

## 1.2.0

### Minor Changes

- f3a7fb2: Implement quoted-printable encoding

## 1.1.5

### Patch Changes

- 02cc185: fix: Email headers override

## 1.1.4

### Patch Changes

- 159934d: fix: Mime boundary length too long.

## 1.1.3

### Patch Changes

- 55259f1: fix: Socket close timeout by ignoring promise result
- c385ba1: fix #23: some servers replied 550 MIME boundary length exceeded (see RFC 2046) to messages that were too long

## 1.1.2

### Patch Changes

- cb77d2b: fix: Socket close timeout by ignoring promise result
- 90d0631: fix #23: some servers replied 550 MIME boundary length exceeded (see RFC 2046) to messages that were too long

## 1.1.1

### Patch Changes

- e14a156: fix: Add missing space before NOTIFY=NEVER

## 1.1.0

### Minor Changes

- 15a2961: Add DSN & attachment features
- 15a2961: Add startTls options(default: true), upgrade to TLS if SMTP server supported.

## 1.0.1

### Patch Changes

- 248bb4a: Export LogLevel Enum while packaging
