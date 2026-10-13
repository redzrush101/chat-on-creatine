import { formatBytes } from '@shared/format';
import { readFile, stat } from 'node:fs/promises';

import { z } from 'zod';

import { effectiveCapabilities } from '@shared/config';
import { imageMimeOf, MAX_IMAGE_BYTES } from '../../fs/files';
import { defineTool, ToolError } from '../tool';

export const viewImageTool = defineTool({
  name: 'view_image',
  surface: 'core',
  title: 'View image',
  description:
    'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk. PNG, JPEG, GIF and WebP only, up to ' +
    `${formatBytes(MAX_IMAGE_BYTES)}. The path must be inside an approved folder.`,
  input: {
    path: z.string().min(1).max(4096).describe('Local filesystem path to an image file.')
  },
  outputSchema: z.object({ image_url: z.string() }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  exposed: (config) => effectiveCapabilities(config).read,
  async run({ path }, ctx) {
    if (!effectiveCapabilities(ctx.config).read) {
      throw new ToolError('TOOL_DISABLED', 'read is turned off. Ask the user to enable reading files in the app.');
    }
    const real = await ctx.services.paths.resolve(path, { cwd: ctx.caller?.cwd ?? null, mustExist: true });
    const info = await stat(real);
    if (!info.isFile()) throw new ToolError('INVALID_ARGUMENT', 'path is not a file');
    if (info.size > MAX_IMAGE_BYTES) {
      throw new ToolError('LIMIT_EXCEEDED', `image is too large to return (${formatBytes(info.size)}; limit ${formatBytes(MAX_IMAGE_BYTES)}). Crop or resize it first.`);
    }
    const bytes = await readFile(real);
    const mimeType = imageMimeOf(real, bytes);
    if (!mimeType) throw new ToolError('INVALID_ARGUMENT', 'not a supported image; PNG, JPEG, GIF and WebP are supported');
    const data = bytes.toString('base64');
    return {
      content: [{ type: 'image', data, mimeType }],
      structuredContent: { image_url: `data:${mimeType};base64,${data}` },
      display: [{ type: 'image', mime: mimeType, path: real }]
    };
  }
});
