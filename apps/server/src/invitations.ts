import { schema, type Db, type Member } from '@lithocms/core';
import { and, eq, like } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Auth } from './auth.js';
import type { Mailer } from './mailer.js';

/** How long a link to set the first password works. */
const LINK_DAYS = 7;

/** What the admin is told after inviting: the link itself only when no mail went out. */
export interface InviteResult {
  mailed: boolean;
  link?: string;
}

const COPY = {
  en: {
    roles: { owner: 'owner', admin: 'admin', editor: 'editor', author: 'author' },
    invitedSubject: (site: string) => `You are invited to ${site}`,
    invited: (by: string, site: string, role: string, link: string) =>
      `${by} invited you to work on ${site} as ${role}.\n\nSet your password to sign in:\n${link}\n\nThe link works for ${LINK_DAYS} days, once.`,
    addedSubject: (site: string) => `You now have access to ${site}`,
    added: (by: string, site: string, role: string, link: string) =>
      `${by} gave you access to ${site} as ${role}.\n\nSign in with your usual password:\n${link}`,
  },
  tr: {
    roles: { owner: 'sahip', admin: 'yönetici', editor: 'editör', author: 'yazar' },
    invitedSubject: (site: string) => `${site} sitesine davet edildiniz`,
    invited: (by: string, site: string, role: string, link: string) =>
      `${by} sizi ${site} sitesinde ${role} olarak çalışmaya davet etti.\n\nGiriş yapmak için şifrenizi belirleyin:\n${link}\n\nBağlantı ${LINK_DAYS} gün içinde, bir kez kullanılabilir.`,
    addedSubject: (site: string) => `${site} sitesine erişiminiz var`,
    added: (by: string, site: string, role: string, link: string) =>
      `${by} size ${site} sitesinde ${role} erişimi verdi.\n\nHer zamanki şifrenizle giriş yapın:\n${link}`,
  },
};

/**
 * Accounts for invited people and the one-off links that let them set a password. A link is
 * a better-auth password reset token, so accepting it goes through better-auth's own
 * `/reset-password`, which also creates the password account the first time.
 */
export function createInvitations({
  auth,
  db,
  adminUrl,
  mailer,
  log,
}: {
  auth: Auth;
  db: Db;
  adminUrl: URL;
  mailer: Mailer | null;
  log: FastifyBaseLogger;
}) {
  return {
    /** The account for this email, made without a password if there is none yet. */
    async findOrCreateUser(email: string, name?: string): Promise<{ id: string }> {
      const [existing] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email));
      if (existing) return existing;
      const ctx = await auth.$context;
      const user = await ctx.internalAdapter.createUser(
        { email, name: name || email.split('@')[0]!, emailVerified: true, isInstanceOwner: false },
        { method: 'admin' },
      );
      return { id: user.id };
    },

    /**
     * Tells a new member: a pending one gets a fresh link (older ones stop working), anyone
     * else a note that they have access. Without SMTP, or when sending fails, the admin gets
     * the link to pass on instead.
     */
    async notify(member: Member, siteId: string, invitedBy: string): Promise<InviteResult> {
      let link = `${adminUrl.origin}/`;
      if (member.pending) {
        const token = randomBytes(32).toString('base64url');
        await db
          .delete(schema.verifications)
          .where(
            and(
              like(schema.verifications.identifier, 'reset-password:%'),
              eq(schema.verifications.value, member.userId),
            ),
          );
        const ctx = await auth.$context;
        await ctx.internalAdapter.createVerificationValue({
          identifier: `reset-password:${token}`,
          value: member.userId,
          expiresAt: new Date(Date.now() + LINK_DAYS * 86_400_000),
        });
        // In the fragment, so it never reaches a server log.
        link = `${adminUrl.origin}/invite#${token}`;
      }
      const fallback = member.pending ? { mailed: false, link } : { mailed: false };
      if (!mailer) return fallback;

      const [site] = await db
        .select({ name: schema.sites.name, locale: schema.sites.locale })
        .from(schema.sites)
        .where(eq(schema.sites.id, siteId));
      const [inviter] = await db
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, invitedBy));
      const copy = site?.locale === 'tr' ? COPY.tr : COPY.en;
      const siteName = site?.name ?? '';
      const role = copy.roles[member.role];
      const by = inviter?.name ?? '';
      try {
        await mailer.send({
          to: [member.email],
          subject: member.pending ? copy.invitedSubject(siteName) : copy.addedSubject(siteName),
          text: member.pending
            ? copy.invited(by, siteName, role, link)
            : copy.added(by, siteName, role, link),
        });
        return { mailed: true };
      } catch (err) {
        log.warn({ err }, 'invitation mail failed');
        return fallback;
      }
    },
  };
}

export type Invitations = ReturnType<typeof createInvitations>;
