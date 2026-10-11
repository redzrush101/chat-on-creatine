import { z } from 'zod';
import { effectiveCapabilities } from '@shared/config';
import { runApplyPatch } from '../../fs/apply-patch';
import { defineTool } from '../tool';

/** Grammar the model must follow; MCP has no freeform tools, so it travels in the description. */
const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

const DESCRIPTION = `The \`apply_patch\` tool can be used to edit files. Pass the patch text as the \`patch\` string; everything else about the format below is unchanged.

Within each Update File block, put edits in file order. Quote the current file text for old/context lines; matching searches forward and does not reconstruct reformatted code. On a mismatch, use the diagnostic to correct the patch before retrying.

The patch must match this grammar:

${APPLY_PATCH_GRAMMAR}`;

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  surface: 'core',
  title: 'Apply patch',
  description: DESCRIPTION,
  input: {
    patch: z
      .string()
      .describe('The patch text, from *** Begin Patch through *** End Patch, exactly as the grammar describes it.')
  },
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  exposed: (config) => {
    const caps = effectiveCapabilities(config);
    return caps.write || caps.create || caps.delete || caps.move;
  },
  run: (args, ctx) => runApplyPatch(args.patch, ctx)
});
