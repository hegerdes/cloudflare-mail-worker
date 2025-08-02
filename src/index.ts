import * as PostalMime from 'postal-mime'
import { htmlToText } from 'html-to-text'

import { Env, MailMapping } from './types'

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // Check if MAIL_MAPPING is defined
    console.info(env.MAIL_MAPPING)
    if (!env.MAIL_MAPPING) {
      throw Error('Mail mapping not defined')
    }
    const mailMapping = JSON.parse(env.MAIL_MAPPING) as MailMapping

    // Mail parser setup
    const parser = new PostalMime.default()

    // parse email content
    const subject = message.headers.get('subject') || 'no-subject'
    const rawEmail = new Response(message.raw)
    const email = await parser.parse(await rawEmail.arrayBuffer())
    let emailText = email.html
    if (email.html) {
      emailText = htmlToText(email.html)
    }
    console.info('Parsed email:', emailText)

    // get attachment
    if (email.attachments === null || email.attachments.length === 0) {
      throw new Error('no attachments')
    }

    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN
    const TELEGRAM_CHANNEL_ID = '-4603865251'
    const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`

    if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === '') {
      throw Error('Telegram token not defined')
    }

    let msg = `📧 You've got mail from **${message.from}** about __${subject}__`

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
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content:
                'You summarize emails. Mails may be in HTML, parse that. Max three sentences response length. Only return the summarization, human readable text',
            },
            { role: 'user', content: `Summarize this email:\n\n${emailText}` },
          ],
        }),
      })

      if (ai_res.ok) {
        const aiData = (await ai_res.json()) as any
        msg += '\n\n**Summary:**\n' + aiData.choices[0].message.content.trim()
        console.info('AI summary created!')
      } else {
        console.error(`OpenAI API error: ${ai_res.statusText}`)
      }
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
    for (const [key, value] of mailMapping.mail_mapping) {
      if (value.find((x) => x === message.from)) {
        forwardMail = key
        break
      }
    }
    console.info(`Forwarding to: ${forwardMail}`)
    await message.forward(forwardMail)
    console.info('All done!')
  },
}
