// Shapes the admin API returns (see apps/server/src/api.ts).

export type Role = 'owner' | 'admin' | 'editor' | 'author';
export type Label = string | Record<string, string>;

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    isInstanceOwner: boolean;
    twoFactorEnabled: boolean;
  };
  sites: { id: string; name: string; role: Role; url: string | null }[];
}

export type PostStatus = 'draft' | 'scheduled' | 'published' | 'trash';

export interface Section {
  type: string;
  settings: Record<string, unknown>;
  blocks: { type: string; settings: Record<string, unknown> }[];
}

export interface Post {
  id: string;
  type: 'post' | 'page';
  status: PostStatus;
  title: string;
  slug: string;
  excerpt: string;
  content: unknown;
  template: string | null;
  sections: Section[] | null;
  featuredMediaId: string | null;
  parentId: string | null;
  termIds: string[];
  primaryCategoryId: string | null;
  publishedAt: string | null;
  seo: { title?: string; description?: string };
  updatedAt: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Media {
  id: string;
  path: string;
  originalName: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  alt: string;
  caption: string;
  createdAt: string;
}

export interface Term {
  id: string;
  taxonomy: 'category' | 'tag';
  name: string;
  slug: string;
  parentId: string | null;
}

export interface MenuItem {
  id?: string;
  label: string;
  kind: 'post' | 'term' | 'url';
  ref?: string;
  url?: string;
  children: MenuItem[];
}

export interface Setting {
  id: string;
  type:
    | 'text'
    | 'textarea'
    | 'richtext'
    | 'boolean'
    | 'number'
    | 'select'
    | 'color'
    | 'image'
    | 'url'
    | 'font';
  label?: Label;
  default?: string | number | boolean;
  options?: { value: string; label?: Label }[];
}

export interface SectionSchema {
  name: Label;
  settings?: Setting[];
  blocks?: { type: string; name?: Label; settings?: Setting[] }[];
  max_blocks?: number;
}

export interface Theme {
  slug: string;
  name: string;
  version: string;
  settings: Setting[];
  values: Record<string, unknown>;
  sections: { name: string; schema: SectionSchema; data: Omit<Section, 'type'> | null }[];
  pageTemplates: { key: string; label: Label; sections?: boolean }[];
  menus: { location: string; label: Label }[];
  slots: { key: string; label: Label }[];
  collections: string[];
}

export interface FieldDef {
  key: string;
  label: Label;
  type:
    'text' | 'richtext' | 'number' | 'select' | 'image' | 'url' | 'date' | 'boolean' | 'reference';
  required?: boolean;
  options?: { value: string; label?: Label }[];
}

export interface Collection {
  id: string;
  key: string;
  label: string;
  sortMode: 'manual' | 'created_desc';
  fields: FieldDef[];
}

export interface Entry {
  id: string;
  data: Record<string, unknown>;
  status: 'draft' | 'published';
  sort: number;
  createdAt: string;
}

export interface FormField {
  key: string;
  label: Label;
  type: 'text' | 'textarea' | 'email' | 'tel' | 'number' | 'select' | 'checkbox' | 'date';
  required?: boolean;
  options?: { value: string; label?: Label }[];
}

export interface Form {
  key: string;
  fields: FormField[];
  notifyEmails: string[];
  successMessage: string;
  consentText: string;
}

export interface Submission {
  id: string;
  data: Record<string, unknown>;
  status: 'new' | 'read' | 'spam';
  createdAt: string;
}

export interface SiteSettings {
  name: string;
  tagline: string;
  locale: string;
  timezone: string;
  logo: string | null;
  social: Record<string, string>;
  postsPerPage: number | null;
  searchEngines: boolean;
}
