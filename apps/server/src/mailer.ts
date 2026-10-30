import { createTransport } from 'nodemailer';

export interface Mail {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Sends through the SMTP server in `url`, e.g. `smtps://user:pass@smtp.example.com:465`. */
export function smtpMailer(url: string, from: string): Mailer {
  const transport = createTransport(url);
  return {
    async send(mail) {
      await transport.sendMail({ from, ...mail });
    },
  };
}
