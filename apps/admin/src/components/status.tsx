import { Pill } from '@/components/ui/pill';
import { useI18n } from '@/lib/i18n';
import type { PostStatus } from '@/lib/types';

export function StatusPill({ status }: { status: PostStatus }) {
  const { t } = useI18n();
  const tone = status === 'published' ? 'positive' : status === 'scheduled' ? 'warning' : 'neutral';
  return <Pill tone={tone}>{t(`status.${status}`)}</Pill>;
}
