import type { ToolSpec } from '../tool';
import { applyPatchTool } from './apply-patch';
import { execCommandTool } from './exec-command';
import { findTool } from './find';
import { readTool } from './read';
import { viewImageTool } from './view-image';
import { writeStdinTool } from './write-stdin';

/** Every Core tool in listing order; each decides its own exposure from config. */
export const CORE_TOOLS: ToolSpec[] = [readTool, viewImageTool, findTool, applyPatchTool, execCommandTool, writeStdinTool];
