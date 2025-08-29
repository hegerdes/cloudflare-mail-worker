import * as PostalMime from 'postal-mime'
import { htmlToText } from 'html-to-text'

import { Env, MailMapping } from './types'

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const subject = message.headers.get('subject') || 'no-subject'
    console.info(`Received email from: ${message.from} about: ${subject}`)

    // Check if MAIL_MAPPING is defined
    if (!env.MAIL_MAPPING) {
      throw Error('Mail mapping not defined')
    }
    if (!env.TELEGRAM_TOKEN || env.TELEGRAM_TOKEN === '') {
      throw Error('Telegram token not defined')
    }

    // Constants
    const TELEGRAM_CHANNEL_ID = '-4603865251'
    const apiUrl = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`
    let msg = `📧 You've got mail from ${message.from} about ${subject}`

    // Parse email content
    const parser = new PostalMime.default()
    const mailMapping = JSON.parse(env.MAIL_MAPPING) as MailMapping
    const rawEmail = new Response(message.raw)
    const email = await parser.parse(await rawEmail.arrayBuffer())
    let emailText = email.html
    if (email.html) {
      emailText = htmlToText(email.html)
    }

    console.info('Parsed email:', emailText)
    if (env.R2_BUCKET && email.html) {
      // Save to R2: https://github.com/cloudflare/dmarc-email-worker/blob/main/src/index.ts
      const date = new Date()
      let sanitized_subject = subject
        .trim() // Remove leading/trailing whitespace
        .replace(/[^a-zA-Z0-9/_-]/g, '-') // Replace unsafe characters with hyphen
        .replace(/\/{2,}/g, '/') // Replace multiple slashes with a single slash
        .replace(/^-+|-+$/g, '')
      let key = `mail/${date.getFullYear()}/-${message.from.replace('@', '.')}-${sanitized_subject}.html`
      await env.R2_BUCKET.put(key, email.html)
      for (const attachment of email.attachments) {
        if (attachment.content) {
          await env.R2_BUCKET.put(`mail/${date.getUTCFullYear()}/attachment/${attachment.filename}`, attachment.content)
        }
      }
      console.info(`Saved email to R2 bucket with key: ${key}`)
    }

    if (env.OPENAI_API_KEY) {
      let ai_res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5-mini',
          messages: [
            {
              role: 'system',
              content:
                'You summarize emails and can detect spam. Mails may be in HTML, parse that. Max three sentences response length. Only return the summarization in human readable text. If it is an advertisment, spamor a scam answer with"This is probably spam - dropping it"',
            },
            { role: 'user', content: `Summarize this email:\n\n${emailText}` },
          ],
        }),
      })

      if (ai_res.ok) {
        const aiData = (await ai_res.json()) as any
        msg += '\n\nSummary:\n' + aiData.choices[0].message.content.trim()
        console.info('AI summary created!')
      } else {
        console.error(`OpenAI API error: ${ai_res.statusText}`)
      }
    }

    if (msg.includes('This is probably spam - dropping it')) {
      console.info('Detected spam, not forwarding.')
      return
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHANNEL_ID, text: msg }),
    })

    const data = await response.json()
    if (!response.ok) {
      console.error('Telegram API error:', data)
      throw Error(JSON.stringify({ error: 'Failed to send message', details: data }))
    }

    let forwardMail = mailMapping.default_forward_mail
    for (const [key, value] of Object.entries(mailMapping.mail_mapping)) {
      if (value.find((x: string) => x === message.from)) {
        forwardMail = key
        break
      }
    }
    console.info(`Forwarding to: ${forwardMail}`)
    await message.forward(forwardMail)
    console.info('All done!')
  },
}
