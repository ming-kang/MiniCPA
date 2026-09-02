import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML, {
  isMap,
  isScalar,
  isSeq,
  type Document,
  type Pair,
  type ParsedNode,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { defaultConfigYaml, generateApiKey } from "./config-yaml.js";
import { writeFileAtomic } from "./fs-atomic.js";

type ParsedMap = YAMLMap<ParsedNode, ParsedNode | null>;

type TextPatch = {
  start: number;
  end: number;
  text: string;
};

export type ConfigMergeResult = {
  yaml: string;
  addedPaths: string[];
  overwrittenPaths: string[];
};

export type ConfigSyncResult = {
  changed: boolean;
  addedPaths: string[];
  overwrittenPaths: string[];
  backupPath?: string;
};

/** Values that belong to one machine rather than to the canonical operational policy. */
const PRESERVE_EXISTING_PATHS = new Set([
  "host",
  "port",
  "tls",
  "proxy-url",
  "auth-dir",
  "api-keys",
  "remote-management.secret-key",
  "plugins.configs",
  "openai-compatibility",
]);

function preservesExistingValue(path: string[]): boolean {
  const joined = path.join(".");
  if (PRESERVE_EXISTING_PATHS.has(joined)) return true;
  return path.length === 1 && /-api-keys?$/.test(path[0] ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function pairKey(pair: Pair<ParsedNode, ParsedNode | null>): string | undefined {
  const key = isScalar(pair.key) ? pair.key.value : pair.key?.toJSON();
  return typeof key === "string" ? key : undefined;
}

function lineIndent(source: string, offset: number): number {
  const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  return offset - lineStart;
}

function endOfLine(source: string, offset: number): number {
  const newline = source.indexOf("\n", offset);
  return newline === -1 ? source.length : newline + 1;
}

function lineBoundaryAfterValue(source: string, offset: number): number {
  return source[offset - 1] === "\n" ? offset : endOfLine(source, offset);
}

function indentFollowingLines(text: string, indent: number): string {
  const spaces = " ".repeat(indent);
  return text.replaceAll("\n", `\n${spaces}`);
}

function renderValue(value: unknown, indent: number): string {
  return indentFollowingLines(YAML.stringify(value, { lineWidth: 0 }).trimEnd(), indent);
}

function nodeValueEnd(node: ParsedNode, source: string): number | undefined {
  if (isMap(node)) {
    const map = node as ParsedMap;
    const last = map.items.at(-1);
    const valueEnd = last?.value?.range?.[1] ?? last?.key?.range?.[1];
    return valueEnd === undefined ? map.range?.[1] : lineBoundaryAfterValue(source, valueEnd);
  }
  if (isSeq(node)) {
    const sequence = node as YAMLSeq<ParsedNode | null>;
    const valueEnd = sequence.items.at(-1)?.range?.[1];
    return valueEnd === undefined ? sequence.range?.[1] : lineBoundaryAfterValue(source, valueEnd);
  }
  return node.range?.[1];
}

function renderReplacement(source: string, start: number, end: number, value: unknown): string {
  const rendered = renderValue(value, lineIndent(source, start));
  return source.slice(start, end).endsWith("\n") ? `${rendered}\n` : rendered;
}

function renderPairs(entries: Array<[string, unknown]>, indent: number): string {
  return entries
    .map(([key, value]) => {
      const pair = YAML.stringify(new Map([[key, value]]), { lineWidth: 0 }).trimEnd();
      return `${" ".repeat(indent)}${indentFollowingLines(pair, indent)}\n`;
    })
    .join("");
}

function addInsertion(insertions: Map<number, string[]>, offset: number, text: string): void {
  const current = insertions.get(offset);
  if (current) current.push(text);
  else insertions.set(offset, [text]);
}

function lastPairLineEnd(map: ParsedMap, source: string): number | undefined {
  const last = map.items.at(-1);
  const valueEnd = last?.value?.range?.[1] ?? last?.key?.range?.[1];
  return valueEnd === undefined ? undefined : lineBoundaryAfterValue(source, valueEnd);
}

function mergeMap(
  templateMap: ParsedMap,
  existing: Record<string, unknown>,
  source: string,
  path: string[],
  patches: TextPatch[],
  insertions: Map<number, string[]>,
  addedPaths: string[],
  overwrittenPaths: string[],
  templateDocument: Document,
  isRoot: boolean,
): void {
  const templateKeys = new Set<string>();

  for (const pair of templateMap.items) {
    const key = pairKey(pair);
    if (key === undefined) continue;
    templateKeys.add(key);
    const fieldPath = [...path, key];

    if (!own(existing, key)) {
      addedPaths.push(fieldPath.join("."));
      continue;
    }

    const existingValue = existing[key];
    const templateValue = pair.value;
    if (!templateValue?.range) continue;

    if (preservesExistingValue(fieldPath)) {
      const templateJs = templateValue.toJS(templateDocument);
      if (!isDeepStrictEqual(existingValue, templateJs)) {
        const end = nodeValueEnd(templateValue, source);
        if (end !== undefined) {
          patches.push({
            start: templateValue.range[0],
            end,
            text: renderReplacement(source, templateValue.range[0], end, existingValue),
          });
        }
      }
      continue;
    }

    if (isMap(templateValue) && isRecord(existingValue)) {
      if (templateValue.items.length === 0) {
        if (templateValue.range && Object.keys(existingValue).length > 0) {
          const end = nodeValueEnd(templateValue, source);
          if (end !== undefined) {
            patches.push({
              start: templateValue.range[0],
              end,
              text: renderReplacement(source, templateValue.range[0], end, existingValue),
            });
          }
        }
      } else {
        mergeMap(
          templateValue,
          existingValue,
          source,
          fieldPath,
          patches,
          insertions,
          addedPaths,
          overwrittenPaths,
          templateDocument,
          false,
        );
      }
      continue;
    }

    const templateJs = templateValue.toJS(templateDocument);
    if (!isDeepStrictEqual(existingValue, templateJs)) {
      overwrittenPaths.push(fieldPath.join("."));
    }
  }

  const extraEntries = Object.entries(existing).filter(([key]) => !templateKeys.has(key));
  if (extraEntries.length === 0) return;

  if (isRoot) {
    const separator = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
    addInsertion(insertions, source.length, `${separator}${renderPairs(extraEntries, 0)}`);
    return;
  }

  const insertionOffset = lastPairLineEnd(templateMap, source);
  const firstKeyOffset = templateMap.items[0]?.key?.range?.[0];
  if (insertionOffset === undefined || firstKeyOffset === undefined) return;
  addInsertion(
    insertions,
    insertionOffset,
    renderPairs(extraEntries, lineIndent(source, firstKeyOffset)),
  );
}

function applyPatches(
  source: string,
  replacements: TextPatch[],
  insertions: Map<number, string[]>,
): string {
  const allPatches = [
    ...replacements,
    ...[...insertions.entries()].map(([offset, chunks]) => ({
      start: offset,
      end: offset,
      text: chunks.join(""),
    })),
  ].sort((a, b) => b.start - a.start || b.end - a.end);

  let output = source;
  for (const patch of allPatches) {
    output = `${output.slice(0, patch.start)}${patch.text}${output.slice(patch.end)}`;
  }
  return output;
}

/**
 * Rebuild a config from the canonical template. Machine-local settings and
 * credentials keep their existing values; other known settings are overwritten
 * by the template. Extra keys are retained, while comments and known-key order
 * always come from the bundled template.
 */
export function mergeCpaConfigYaml(existingYaml: string, templateYaml: string): ConfigMergeResult {
  const existingDocument = YAML.parseDocument(existingYaml);
  if (existingDocument.errors.length > 0) throw existingDocument.errors[0];
  const parsedExisting = existingDocument.toJS();
  const existing = parsedExisting === null ? {} : parsedExisting;
  if (!isRecord(existing)) {
    throw new Error("Expected config.yaml to contain a YAML mapping at its root");
  }

  const templateDocument = YAML.parseDocument(templateYaml);
  if (templateDocument.errors.length > 0) {
    throw new Error(`Invalid bundled config template: ${templateDocument.errors[0]?.message}`);
  }
  if (!isMap(templateDocument.contents)) {
    throw new Error("Invalid bundled config template: expected a YAML mapping at its root");
  }

  const replacements: TextPatch[] = [];
  const insertions = new Map<number, string[]>();
  const addedPaths: string[] = [];
  const overwrittenPaths: string[] = [];
  mergeMap(
    templateDocument.contents,
    existing,
    templateYaml,
    [],
    replacements,
    insertions,
    addedPaths,
    overwrittenPaths,
    templateDocument,
    true,
  );

  const mergedYaml = applyPatches(templateYaml, replacements, insertions);
  const validation = YAML.parseDocument(mergedYaml);
  if (validation.errors.length > 0) {
    throw new Error(`Could not render synchronized config: ${validation.errors[0]?.message}`);
  }
  return { yaml: mergedYaml, addedPaths, overwrittenPaths };
}

function createBackup(configPath: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const base = `${configPath}.bak.${stamp}`;
  let backupPath = base;
  for (let suffix = 1; fs.existsSync(backupPath); suffix++) {
    backupPath = `${base}.${suffix}`;
  }
  fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
  if (process.platform !== "win32") fs.chmodSync(backupPath, 0o600);
  return backupPath;
}

/** Synchronize an existing config; a missing file remains the responsibility of `cpa init`. */
export function syncCpaConfigDefaults(
  configPath: string,
  options?: { apiKey?: string; now?: Date; templateYaml?: string },
): ConfigSyncResult {
  if (!fs.existsSync(configPath)) {
    return { changed: false, addedPaths: [], overwrittenPaths: [] };
  }

  const existingYaml = fs.readFileSync(configPath, "utf8");
  const templateYaml =
    options?.templateYaml ?? defaultConfigYaml(options?.apiKey ?? generateApiKey());
  let merged: ConfigMergeResult;
  try {
    merged = mergeCpaConfigYaml(existingYaml, templateYaml);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not synchronize ${configPath}: ${message}`, { cause: error });
  }

  if (merged.yaml === existingYaml) {
    return {
      changed: false,
      addedPaths: merged.addedPaths,
      overwrittenPaths: merged.overwrittenPaths,
    };
  }

  const backupPath = createBackup(configPath, options?.now ?? new Date());
  writeFileAtomic(configPath, merged.yaml);
  return {
    changed: true,
    addedPaths: merged.addedPaths,
    overwrittenPaths: merged.overwrittenPaths,
    backupPath,
  };
}
