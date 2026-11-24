// ============================================================================
// The project tool surface, declared once.
//
// Ported from bolt.diy's app/lib/runtime/projectMcp.shared.ts. The descriptions are
// not decoration: they are the difference between a model that reads a file with
// `numbered: true` before patching it and one that rewrites a 400-line component
// from memory and drops half of it. Every `describe()` here exists because a model
// got the corresponding thing wrong at least once.
//
// Schemas are hand-written JSON Schema (not zod) because this app forwards tool
// definitions verbatim to OpenAI-compatible providers through /api/sandbox/turn —
// a zod object would have to be converted anyway, and JSON Schema is what the
// wire format wants.
// ============================================================================
import { z } from 'zod';

export const MAX_LIST_RESULTS = 500;
export const MAX_TEXT_BYTES = 256_000;
export const MAX_OUTPUT_CHARS = 32_000;

const projectPath = z.string().min(1).describe('Path relative to the active project root.');
const optionalSearchPath = z
  .string()
  .describe('Project-relative path. Omit it or use "." for the root.')
  .optional();
const processId = z.string().min(1).describe('Use the processId returned by project_run_command.');
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const lineNumber = z.number().int().min(1);

export const projectToolDefinitions = {
  project_read_file: {
    description: 'Read a UTF-8 project file. Returns content and revision for a subsequent patch.',
    inputSchema: z.strictObject({
      path: projectPath,
      numbered: z
        .boolean()
        .describe('Set true before editing to return 1-based line numbers and the last valid line number as lineCount.')
        .optional(),
    }),
  },
  project_write_file: {
    description: 'Create or fully replace a UTF-8 text file. Use project_replace_lines for targeted edits.',
    inputSchema: z.strictObject({
      path: projectPath,
      content: z
        .string()
        .describe(
          'Complete file contents in one call. Use real line breaks between source statements. For large features, write smaller complete modules as separate files.',
        ),
      overwrite: z.boolean().describe('Set false to require a new path.').optional(),
      replacementReason: z.string().trim().max(500).describe('Optional reason for a full-file replacement.').optional(),
    }),
  },
  project_replace_lines: {
    description: 'Edit an existing file using line numbers and revision from project_read_file with numbered: true.',
    inputSchema: z.strictObject({
      path: projectPath,
      startLine: lineNumber.describe('First line to replace, inclusive.'),
      endLine: lineNumber.describe('Last line to replace, inclusive and no greater than lineCount from the read.'),
      expectedRevision: revision.describe('Copy the revision from the numbered read.'),
      newText: z
        .string()
        .describe('Complete replacement lines without number prefixes. Use an empty string to delete the selected lines.'),
    }),
  },
  project_patch_file: {
    description: 'Fallback for an exact unique text replacement. Prefer project_replace_lines for numbered edits.',
    inputSchema: z.strictObject({
      path: projectPath,
      expectedContent: z
        .string()
        .describe('Legacy full-file concurrency check. Omit this field in normal use.')
        .optional(),
      expectedRevision: revision
        .describe('Exact revision returned by project_read_file. Required with lineRange.')
        .optional(),
      lineRange: z
        .strictObject({ start: lineNumber, end: lineNumber })
        .describe('Optional legacy range, as an object like {"start": 3, "end": 5}. Prefer project_replace_lines.')
        .optional(),
      oldText: z.string().min(1).describe('Fallback exact unique match from a raw read. Omit when using lineRange.').optional(),
      newText: z
        .string()
        .describe('Replacement source without line number prefixes. Use an empty string to delete the match or range.'),
    }),
  },
  project_delete_path: {
    description: 'Delete a file or an explicitly selected directory in the active project.',
    inputSchema: z.strictObject({
      path: projectPath,
      recursive: z.boolean().describe('Set true to delete a directory and its contents.').optional(),
    }),
  },
  project_create_directory: {
    description: 'Create a directory in the active project.',
    inputSchema: z.strictObject({ path: projectPath }),
  },
  project_list_paths: {
    description:
      'List active project files and folders. Generated node_modules files are excluded. Example directory prefix: src.',
    inputSchema: z.strictObject({
      path: optionalSearchPath,
      limit: z.number().int().min(1).max(MAX_LIST_RESULTS).optional(),
    }),
  },
  project_search_content: {
    description: 'Search project file contents using ripgrep.',
    inputSchema: z.strictObject({
      query: z.string().min(1),
      path: optionalSearchPath,
      limit: z.number().int().min(1).max(200).optional(),
    }),
  },
  project_find_related_files: {
    description: 'Find files related by shared directory or filename stem. Each result includes the matching evidence.',
    inputSchema: z.strictObject({ path: projectPath, limit: z.number().int().min(1).max(100).optional() }),
  },
  project_run_command: {
    description:
      'Run a shell command in the project and stream its output to the sandbox terminal. Run dependency installs separately and poll them to exit code 0 before starting the app or checks.',
    inputSchema: z.strictObject({
      command: z.string().min(1).max(4000),
      purpose: z
        .enum(['run', 'test', 'install', 'other'])
        .describe('Use run for dev servers, test for checks, and install for dependencies. Defaults to other.')
        .optional(),
    }),
  },
  project_get_process_output: {
    description:
      'Get combined output, exit status, and previewReady for a project command. Check running installs before dependent commands and check dev servers for readiness.',
    inputSchema: z.strictObject({ processId }),
  },
  project_stop_process: {
    description: 'Stop a running project command.',
    inputSchema: z.strictObject({ processId }),
  },
} as const;

export const PROJECT_TOOL_NAMES = Object.keys(projectToolDefinitions) as Array<keyof typeof projectToolDefinitions>;

/** JSON-Schema form for the provider `tools[]` array. */
export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  not?: JsonSchema;
  allOf?: JsonSchema[];
  [key: string]: unknown;
};

/**
 * JSON Schema straight from the zod definitions. One source of truth: the provider
 * is shown exactly the schema the arguments are then validated against, so a
 * description edited here cannot drift from what the model was told.
 */
export function toolDefsForProvider(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
}> {
  return PROJECT_TOOL_NAMES.map((name) => {
    const definition = projectToolDefinitions[name];
    const schema = z.toJSONSchema(definition.inputSchema, { io: 'input' }) as JsonSchema;
    delete schema.$schema;
    return {
      type: 'function' as const,
      function: {
        name,
        description: definition.description,
        parameters: schema,
      },
    };
  });
}

/** Validate arguments against the same schema the provider was shown. */
export function parseToolArguments(name: string, args: unknown): Record<string, unknown> {
  const definition = projectToolDefinitions[name as keyof typeof projectToolDefinitions];
  if (!definition) {
    throw new Error(`Unknown project tool: ${name}`);
  }
  const parsed = definition.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid arguments for ${name}: ${issues}`);
  }
  return parsed.data as Record<string, unknown>;
}
