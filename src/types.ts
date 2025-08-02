export interface Env {
  R2_BUCKET: R2Bucket
  TELEGRAM_TOKEN: string
  SOCIAL_ADDRESS: string
  DEV_ADDRESS: string
  PVT_ADDRESS: string
  OPENAI_API_KEY: string
  MAIL_MAPPING: MailMapping // Add this line
}

export type Attachment = {
  filename: string
  mimeType: string
  disposition: 'attachment' | 'inline' | null
  related?: boolean
  contentId?: string
  content: string
}

export type MailMapping = {
  default_forward_mail: string
  mail_mapping: Map<string, Array<string>>
}
