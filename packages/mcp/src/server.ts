import { McpServer } from '@modelcontextprotocol/server';
import { registerContentTools } from './content.js';
import type { McpContext } from './context.js';
import { CONTENT_FORMAT } from './guides.js';

const INSTRUCTIONS = `This is one LithoCMS site. Call site_info first. Write bodies in Markdown as described in
guide://content-format. Everything you create is a draft until post_publish; tell the owner what you
changed and give them the edit_url.`;

/** A server for one request: only the tools the caller's scopes allow are registered. */
export function createMcpServer(ctx: McpContext, version: string): McpServer {
  const server = new McpServer({ name: 'lithocms', version }, { instructions: INSTRUCTIONS });
  const guide = (name: string, description: string, text: string) =>
    server.registerResource(
      name,
      `guide://${name}`,
      { description, mimeType: 'text/markdown' },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }),
    );
  guide(
    'content-format',
    'Markdown dialect, images and directives for post bodies',
    CONTENT_FORMAT,
  );
  guide(
    'theme-authoring',
    'How LithoCMS themes are built: files, theme.json, sections, Liquid objects and the validator',
    ctx.guides.themeAuthoring,
  );
  if (ctx.scopes.includes('content')) registerContentTools(server, ctx);
  return server;
}
