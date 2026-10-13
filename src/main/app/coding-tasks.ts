import type { CodingTask } from '@shared/types';
import { resolveReviewTarget } from '../projects/git';

/** One workflow definition for desktop and terminal submissions. */
export async function codingTaskPrompt(task: CodingTask, cwd: string, focus: string): Promise<string> {
  if (task.kind === 'init') return `Inspect this repository and create a concise AGENTS.md at the working folder's root.
If AGENTS.md already exists, read it and propose improvements in your response without overwriting it.
Use the actual source and project configuration to document the code map, build and test commands,
coding conventions and verification expected before committing. Include only facts you can verify.
Keep the file useful to a coding agent, omit generic advice, and never include credentials or personal paths.`;
  const resolved = await resolveReviewTarget(cwd, task.target);
  const scope = resolved.kind === 'uncommitted'
    ? 'Review staged, unstaged and untracked changes in the working folder. Inspect git status, the diff against HEAD (or the empty tree for a repository with no commits), and untracked files.'
    : resolved.kind === 'base'
      ? `Review committed changes from merge base ${resolved.revision} to HEAD in the working folder. Use git diff ${resolved.revision} HEAD -- .; exclude uncommitted changes.`
      : `Review only commit ${resolved.revision} in the working folder. Use git show --format=fuller --root ${resolved.revision} -- .; exclude other commits and uncommitted changes.`;
  return `Act as a code reviewer. ${scope}
Read the relevant source and tests to verify each finding. Do not edit files or implement fixes.
Report only actionable bugs introduced by the selected changes, ordered by severity.
For each finding include priority (P0–P3), file and line, the concrete failure scenario and why it matters.
Avoid stylistic preferences and speculative issues. If there are no findings, say so and describe any verification gaps.
${focus ? `Additional review focus: ${focus}` : ''}`.trim();
}
