// Dev stack only: sample content for a fresh dev site, so the bundled `corporate` theme can be
// seen at full density. Everything here is placeholder copy; the testimonial is marked as such.
import {
  CollectionCreateInput,
  createCollection,
  createPost,
  EntryInput,
  FormUpsertInput,
  MarkdownInput,
  MenuUpdateInput,
  PostCreateInput,
  publishPost,
  schema,
  updateMenu,
  updateThemeSection,
  updateThemeSettings,
  uploadMedia,
  upsertEntry,
  upsertForm,
  withSite,
  type Actor,
  type Db,
  type MediaStore,
  type Tx,
} from '@lithocms/core';
import { and, eq, isNull } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import type { ThemeSet } from './themes.js';

const pages = {
  about: {
    title: 'Hakkımızda',
    excerpt: 'Sınav hazırlığında küçük sınıflar, düzenli deneme ve birebir takip.',
    md: `Akademimiz, akademik İngilizce sınavlarına hazırlanan öğrenciler için kuruldu. Derslerimizi sınavın kendisinden yola çıkarak kurarız: her hafta bir deneme, her denemeden sonra birebir değerlendirme.

## Nasıl çalışıyoruz

- Sınıflarımız en fazla sekiz kişi.
- Her öğrencinin bir sınav koçu var.
- Ders saatleri dışında etüt salonlarımız açık.

## Kadromuz

Eğitmenlerimizin her biri hazırlandığı sınava kendisi de girmiş, sonuçlarını paylaşan öğretmenlerdir.`,
  },
  programs: {
    title: 'Programlar',
    excerpt: 'IELTS, TOEFL, PTE, YDS, YÖKDİL ve üniversite hazırlık atlama programları.',
    md: `Her program bir seviye tespit sınavıyla başlar. Sonucunuza göre size uygun grubu ve haftalık planı birlikte belirleriz.

## Akademik sınavlar

IELTS, TOEFL iBT ve PTE Academic programları 8 ile 12 hafta sürer.

## Ulusal sınavlar

YDS ve YÖKDİL programları dönem takvimine göre açılır.`,
  },
  contact: {
    title: 'İletişim',
    excerpt: 'Seviye tespit sınavı ve program bilgisi için yazın ya da uğrayın.',
    md: 'Hafta içi 09.00–21.00, cumartesi 10.00–18.00 arası açığız.',
  },
  privacy: {
    title: 'Gizlilik ve KVKK',
    excerpt: '',
    md: 'Bu metin örnektir. Kişisel verilerin işlenmesine ilişkin aydınlatma metninizi buraya ekleyin.',
  },
};

const posts = [
  {
    title: 'IELTS Reading bölümünde zamanı yönetmek',
    md: 'Okuma bölümünde en sık yapılan hata, ilk metne fazla zaman ayırmaktır. Her metin için yirmi dakikalık bir plan yapın ve soruları okumadan metne başlamayın.',
  },
  {
    title: 'Hazırlık atlama sınavlarına dört ay kala',
    md: 'Üniversitelerin yeterlik sınavları birbirine benzese de puanlama farklıdır. Hedeflediğiniz okulun örnek sınavını ilk hafta çözün.',
  },
  {
    title: 'YDS’de kelime çalışmak için bir yöntem',
    md: 'Kelimeleri listelerden değil, çıkmış sorulardaki cümlelerden öğrenin. Her gün yirmi cümle, haftada bir tekrar.',
  },
];

/** Seeds the dev site once: does nothing when it already has content. */
/** Public-domain and CC0 photographs; sources in `demo/CREDITS.md`. */
const PHOTOS = {
  readingRoom: {
    file: 'reading-room.jpg',
    alt: 'Kütüphane okuma salonu, kubbenin altında masalar',
  },
  kadikoy: { file: 'kadikoy.jpg', alt: 'Kadıköy meydanı ve iskele çevresi' },
  ferry: { file: 'ferry.jpg', alt: 'İstanbul’da Boğaz’ı geçen bir araba vapuru' },
};

export async function seedDemo(
  db: Db,
  themes: ThemeSet,
  store: MediaStore,
  siteId: string,
  userId: string,
) {
  const actor: Actor = { userId, role: 'owner', channel: 'admin' };
  await withSite(db, siteId, async (tx) => {
    const [existing] = await tx.select({ id: schema.posts.id }).from(schema.posts).limit(1);
    if (existing) return;
    await tx
      .update(schema.sites)
      .set({
        name: 'Kuzey Dil Akademisi',
        locale: 'tr',
        timezone: 'Europe/Istanbul',
        settings: { tagline: 'Akademik İngilizce sınav hazırlık' },
      })
      .where(eq(schema.sites.id, siteId));

    const page = async (p: (typeof pages)[keyof typeof pages], template?: string) => {
      const created = await createPost(
        tx,
        siteId,
        actor,
        PostCreateInput.parse({
          type: 'page',
          title: p.title,
          excerpt: p.excerpt,
          content: MarkdownInput.parse(p.md),
          template,
        }),
      );
      return publishPost(tx, siteId, actor, created.id);
    };
    const photo = async ({ file, alt }: { file: string; alt: string }) =>
      (
        await uploadMedia(tx, store, siteId, actor, {
          data: await readFile(new URL(`../demo/${file}`, import.meta.url)),
          filename: file,
          alt,
        })
      ).id;
    const photos = {
      readingRoom: await photo(PHOTOS.readingRoom),
      kadikoy: await photo(PHOTOS.kadikoy),
      ferry: await photo(PHOTOS.ferry),
    };
    const about = await page(pages.about);
    const programs = await page(pages.programs);
    const contact = await page(pages.contact, 'contact');
    const privacy = await page(pages.privacy);
    for (const [i, p] of posts.entries()) {
      const created = await createPost(
        tx,
        siteId,
        actor,
        PostCreateInput.parse({
          type: 'post',
          title: p.title,
          content: MarkdownInput.parse(p.md),
          featuredMediaId: i === 0 ? photos.ferry : null,
        }),
      );
      await publishPost(tx, siteId, actor, created.id, new Date(Date.now() - (i + 1) * 86_400_000));
    }

    const link = (label: string, ref: string) => ({ label, kind: 'post' as const, ref });
    const url = (label: string, to: string) => ({ label, kind: 'url' as const, url: to });
    await updateMenu(
      tx,
      siteId,
      actor,
      'primary',
      MenuUpdateInput.parse({
        items: [
          { ...link('Hakkımızda', about.id), children: [url('Sık sorulan sorular', '/#faq')] },
          {
            ...link('Programlar', programs.id),
            children: [
              url('IELTS', '/programlar/'),
              url('TOEFL iBT', '/programlar/'),
              url('PTE Academic', '/programlar/'),
              url('YDS ve YÖKDİL', '/programlar/'),
            ],
          },
          link('İletişim', contact.id),
        ],
      }),
    );
    await updateMenu(
      tx,
      siteId,
      actor,
      'footer',
      MenuUpdateInput.parse({
        items: [
          { ...link('Akademi', about.id), children: [link('Programlar', programs.id)] },
          { ...link('İletişim', contact.id), children: [] },
        ],
      }),
    );
    await updateMenu(
      tx,
      siteId,
      actor,
      'legal',
      MenuUpdateInput.parse({ items: [link('Gizlilik ve KVKK', privacy.id)] }),
    );

    await collections(tx, siteId, actor);
    await upsertForm(
      tx,
      siteId,
      actor,
      'contact',
      FormUpsertInput.parse({
        fields: [
          { key: 'name', label: 'Adınız', type: 'text', required: true },
          { key: 'email', label: 'E-posta', type: 'email', required: true },
          { key: 'phone', label: 'Telefon', type: 'tel' },
          {
            key: 'program',
            label: 'İlgilendiğiniz program',
            type: 'select',
            options: ['IELTS', 'TOEFL iBT', 'PTE Academic', 'YDS / YÖKDİL', 'Hazırlık atlama'].map(
              (value) => ({ value }),
            ),
          },
          { key: 'message', label: 'Mesajınız', type: 'textarea' },
        ],
        notifyEmails: ['admin@example.com'],
        successMessage: 'Teşekkürler, bir iş günü içinde dönüyoruz.',
        consentText: 'Aydınlatma metnini okudum, bana dönüş yapılmasını kabul ediyorum.',
      }),
    );

    await corporateTheme(tx, themes, siteId, actor, photos);
  });
}

async function collections(tx: Tx, siteId: string, actor: Actor) {
  const make = async (
    key: string,
    label: string,
    fields: { key: string; label: string; type: string; required?: boolean }[],
    entries: Record<string, string>[],
  ) => {
    await createCollection(tx, siteId, actor, CollectionCreateInput.parse({ key, label, fields }));
    for (const [i, data] of entries.entries()) {
      await upsertEntry(
        tx,
        siteId,
        actor,
        key,
        undefined,
        EntryInput.parse({ data, status: 'published', sort: i }),
      );
    }
  };
  await make(
    'faq',
    'Sık sorulan sorular',
    [
      { key: 'question', label: 'Soru', type: 'text', required: true },
      { key: 'answer', label: 'Cevap', type: 'text', required: true },
    ],
    [
      {
        question: 'Hangi seviyeden başlamam gerekiyor?',
        answer:
          'Ücretsiz seviye tespit sınavına giriyorsunuz; sonucunuza göre size uygun grubu öneriyoruz.',
      },
      {
        question: 'Sınıflar kaç kişilik?',
        answer: 'Gruplarımız en fazla sekiz kişidir. Birebir ders seçeneği de var.',
      },
      {
        question: 'Deneme sınavları ne sıklıkla yapılıyor?',
        answer:
          'Her hafta sonu gerçek sınav koşullarında bir deneme, ardından birebir geri bildirim.',
      },
      {
        question: 'Ders dışında çalışabileceğim bir yer var mı?',
        answer: 'Etüt salonlarımız ders saatleri dışında öğrencilerimize açıktır.',
      },
      {
        question: 'Ödemeyi taksitle yapabilir miyim?',
        answer: 'Evet, kredi kartına taksit seçeneklerimiz var.',
      },
      {
        question: 'Online ders veriyor musunuz?',
        answer: 'Tüm programlarımızın canlı online grupları da açılıyor.',
      },
    ],
  );
  await make(
    'testimonials',
    'Öğrenci görüşleri',
    [
      { key: 'opening', label: 'Açılış cümlesi', type: 'text', required: true },
      { key: 'text', label: 'Metin', type: 'text', required: true },
      { key: 'name', label: 'Ad', type: 'text', required: true },
      { key: 'role', label: 'Program', type: 'text' },
      { key: 'photo', label: 'Fotoğraf', type: 'image' },
    ],
    [
      {
        opening: 'Bu bir örnek görüştür; kendi öğrencilerinizin sözleriyle değiştirin.',
        text: 'Görüş metni burada iki üç paragraf olarak yer alır. Okunmak için yer verilmiş, tek bir mektup gibi dizilir.',
        name: 'Örnek öğrenci',
        role: 'IELTS programı',
      },
    ],
  );
  await make(
    'branches',
    'Şubeler',
    [
      { key: 'name', label: 'Şube', type: 'text', required: true },
      { key: 'address', label: 'Adres', type: 'text' },
      { key: 'phone', label: 'Telefon', type: 'text' },
    ],
    [
      {
        name: 'Kadıköy',
        address: 'Örnek Sokak No: 1, Kadıköy / İstanbul',
        phone: '0216 000 00 00',
      },
      {
        name: 'Beşiktaş',
        address: 'Örnek Cadde No: 2, Beşiktaş / İstanbul',
        phone: '0212 000 00 00',
      },
    ],
  );
}

async function corporateTheme(
  tx: Tx,
  themes: ThemeSet,
  siteId: string,
  actor: Actor,
  photos: Record<keyof typeof PHOTOS, string>,
) {
  const [version] = await tx
    .select({ themeId: schema.themes.id, storagePath: schema.themeVersions.storagePath })
    .from(schema.themeVersions)
    .innerJoin(schema.themes, eq(schema.themes.id, schema.themeVersions.themeId))
    .where(and(isNull(schema.themes.siteId), eq(schema.themes.slug, 'corporate')));
  const theme = version && (await themes.get(version.storagePath));
  if (!theme) return;
  await updateThemeSettings(tx, siteId, actor, version.themeId, theme.manifest.settings ?? [], {
    cta_label: 'Seviye tespit sınavı',
    cta_url: '/iletisim/',
    phone: '0216 000 00 00',
    email: 'merhaba@example.com',
    whatsapp_number: '905550000000',
    whatsapp_message: 'Merhaba, programlarınız hakkında bilgi almak istiyorum.',
    footer_note:
      'Bu site LithoCMS ile örnek içerikle kuruldu. Fotoğraflar: Wikimedia Commons (kamu malı ve CC0).',
  });
  const sections: Record<string, unknown> = {
    hero: {
      settings: {
        wordmark: 'Kuzey',
        sentence:
          'Akademik İngilizce sınavlarına küçük sınıflarda, haftalık denemelerle hazırlanın.',
        place: 'İstanbul · Kadıköy ve Beşiktaş',
      },
      blocks: [
        { type: 'link', settings: { label: 'Programlar', href: '/programlar/' } },
        { type: 'link', settings: { label: 'Takvim', href: '#schedule' } },
      ],
    },
    facts: {
      settings: {
        heading: 'Sınava sınavla hazırlanın',
        image: photos.readingRoom,
        note: 'Her hafta gerçek koşullarda bir deneme, ardından eğitmeninizle birebir değerlendirme.',
      },
      blocks: [
        { type: 'fact', settings: { value: '8 kişi', label: 'En kalabalık sınıfımız' } },
        { type: 'fact', settings: { value: 'Her hafta', label: 'Deneme sınavı ve geri bildirim' } },
        { type: 'fact', settings: { value: '2 şube', label: 'Kadıköy ve Beşiktaş' } },
        { type: 'fact', settings: { value: '09–21', label: 'Etüt salonları açık' } },
      ],
    },
    programs: {
      settings: { heading: 'Programlar', note: 'Süreler haftalık 12 ders saatine göredir.' },
      blocks: [
        { type: 'group', settings: { name: 'Akademik sınavlar' } },
        {
          type: 'item',
          settings: {
            name: 'IELTS',
            value: '10 hafta',
            description: 'Dört beceri, her hafta tam deneme.',
            href: '/programlar/',
          },
        },
        {
          type: 'item',
          settings: {
            name: 'TOEFL iBT',
            value: '10 hafta',
            description: 'Bilgisayar ortamında deneme sınavları.',
            href: '/programlar/',
          },
        },
        {
          type: 'item',
          settings: {
            name: 'PTE Academic',
            value: '8 hafta',
            description: 'Otomatik puanlamaya göre strateji.',
            href: '/programlar/',
          },
        },
        { type: 'group', settings: { name: 'Ulusal sınavlar' } },
        {
          type: 'item',
          settings: {
            name: 'YDS',
            value: '12 hafta',
            description: 'Çıkmış sorularla kelime ve dil bilgisi.',
          },
        },
        {
          type: 'item',
          settings: {
            name: 'YÖKDİL',
            value: '12 hafta',
            description: 'Alanınıza göre fen, sağlık ya da sosyal.',
          },
        },
        { type: 'group', settings: { name: 'Hazırlık atlama' } },
        {
          type: 'item',
          settings: {
            name: 'Üniversite yeterlik sınavları',
            value: 'Dönemlik',
            description: 'Okulunuzun sınav biçimine göre ayrı gruplar.',
          },
        },
      ],
    },
    compare: {
      settings: {
        heading: 'Sınıf mevcudu',
        text: 'Küçük grupta her öğrenci her derste konuşur, her denemesi okunur.',
        left_caption: 'Sıradan bir sınıf',
        left_value: '24',
        right_caption: 'Bizim sınıflarımız',
        right_value: '8',
      },
      blocks: [],
    },
    schedule: {
      settings: { heading: 'Takvim', note: 'Yeni grupların başlangıç tarihleri. Örnek takvimdir.' },
      blocks: [
        { type: 'part', settings: { name: 'Kasım' } },
        {
          type: 'row',
          settings: {
            title: 'IELTS',
            format: 'Hafta içi akşam',
            place: 'Kadıköy',
            time: '3 Kasım',
          },
        },
        {
          type: 'row',
          settings: {
            title: 'TOEFL iBT',
            format: 'Hafta sonu',
            place: 'Beşiktaş',
            time: '8 Kasım',
          },
        },
        {
          type: 'row',
          settings: {
            title: 'YDS',
            format: 'Hafta içi gündüz',
            place: 'Kadıköy',
            time: '17 Kasım',
          },
        },
        { type: 'part', settings: { name: 'Aralık' } },
        {
          type: 'row',
          settings: {
            title: 'PTE Academic',
            format: 'Online',
            place: 'Canlı ders',
            time: '1 Aralık',
          },
        },
        {
          type: 'row',
          settings: { title: 'YÖKDİL', format: 'Hafta sonu', place: 'Beşiktaş', time: '6 Aralık' },
        },
        {
          type: 'row',
          settings: { title: 'IELTS', format: 'Yoğun', place: 'Kadıköy', time: '15 Aralık' },
        },
      ],
    },
    picture: {
      settings: { image: photos.kadikoy, caption: 'Kadıköy, iskele meydanı' },
      blocks: [],
    },
    faq: { settings: { heading: 'Sık sorulan sorular', limit: 6 }, blocks: [] },
    news: { settings: { heading: 'Blogdan' }, blocks: [] },
    contact: {
      settings: {
        sentence: 'Seviye tespit sınavı ya da program için yazın.',
        place: 'İstanbul',
        form_page: '/iletisim/',
      },
      blocks: [],
    },
  };
  for (const [name, data] of Object.entries(sections)) {
    const sectionSchema = theme.engine.sections[name];
    if (sectionSchema) {
      await updateThemeSection(tx, siteId, actor, version.themeId, name, sectionSchema, data);
    }
  }
}
