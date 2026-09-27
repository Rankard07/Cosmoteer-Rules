const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const CUSTOM_FILE = 'cosmoteer-rules-custom.jsonc';
const TEXTMATE_FILE = 'cosmoteer-rules-textmate-settings.jsonc';

let customFilePath;
let textMateFilePath;
let customWatcher;
let textMateWatcher;
let reloadTimer;
let textMateReloadTimer;
let customEntries = [];
let decorationTypes = new Map();

function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (inLineComment) {
      if (c === '\n' || c === '\r') {
        inLineComment = false;
        out += c;
      } else out += ' ';
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && n === '/') {
        out += '  ';
        i++;
        inBlockComment = false;
      } else out += (c === '\n' || c === '\r') ? c : ' ';
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && n === '/') {
      out += '  '; i++; inLineComment = true;
    } else if (c === '/' && n === '*') {
      out += '  '; i++; inBlockComment = true;
    } else out += c;
  }
  return out;
}

function parseJsonc(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(stripJsonComments(raw));
}

function normalizeFontStyle(value) {
  if (typeof value !== 'string') return '';
  const allowed = new Set(['bold', 'italic', 'underline', 'strikethrough']);
  return value.split(/\s+/).filter(Boolean).filter(v => allowed.has(v)).join(' ');
}

function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

function normalizeStyle(value, fallbackColor, fallbackFontStyle) {
  if (value == null) {
    return fallbackColor ? { color: fallbackColor, fontStyle: normalizeFontStyle(fallbackFontStyle || '') } : null;
  }
  if (typeof value !== 'object') return null;
  const color = normalizeColor(value.color) || fallbackColor;
  if (!color) return null;
  return { color, fontStyle: normalizeFontStyle(value.fontStyle == null ? (fallbackFontStyle || '') : value.fontStyle) };
}

function loadEntries(context) {
  if (!fs.existsSync(customFilePath)) return [];
  try {
    const parsed = parseJsonc(customFilePath);
    const sections = [
      { name: 'customWords', kind: 'custom' },
      { name: 'overrideWords', kind: 'override' }
    ];
    const result = [];

    for (const section of sections) {
      if (!Array.isArray(parsed[section.name])) continue;
      for (const item of parsed[section.name]) {
        if (!item || !Array.isArray(item.words)) continue;
        const legacyColor = normalizeColor(item.color);
        const legacyStyle = legacyColor ? { color: legacyColor, fontStyle: normalizeFontStyle(item.fontStyle) } : null;
        const nonComment = normalizeStyle(item.nonComment, legacyColor, item.fontStyle);
        const comment = normalizeStyle(item.comment, legacyColor, item.fontStyle);
        if (!nonComment && !comment) continue;
        const words = item.words.filter(w => typeof w === 'string' && w.length > 0);
        if (!words.length) continue;
        result.push({
          words,
          nonComment: nonComment || legacyStyle,
          comment: comment || legacyStyle,
          caseInsensitive: item.caseInsensitive === true,
          kind: section.kind
        });
      }
    }
    // Built-in display overrides for important Cosmoteer identifiers.
    // These are applied as editor decorations so they remain deterministic
    // even when an old tokenColorCustomizations rule is still present in
    // the host editor configuration. Entries from cosmoteer-rules-custom.jsonc
    // are loaded first, so user-defined overrides take precedence.
    result.push({
      words: ['Action', 'Actions', 'Add', 'AddTo', 'Remove', 'RemoveFrom', 'Override', 'Overrides', 'OverrideIn', 'CreateIfNotExisting', 'IgnoreIfNotExisting'],
      nonComment: { color: '#FF79B0', fontStyle: 'bold' },
      comment: { color: '#FF79B0', fontStyle: 'bold' },
      caseInsensitive: true,
      kind: 'builtin'
    });
    result.push({
      words: ['Overclock', 'Overclocking', 'OVERCLOCK', 'OVERCLOCKING'],
      nonComment: { color: '#61C4E8', fontStyle: 'bold' },
      comment: { color: '#61C4E8', fontStyle: 'bold' },
      caseInsensitive: true,
      kind: 'builtin'
    });

    return result;
  } catch (error) {
    vscode.window.showErrorMessage(`Cosmoteer Rules: Could not read ${CUSTOM_FILE}: ${error.message}`);
    return [];
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makePattern(word) {
  const escaped = escapeRegex(word);
  const identifierLike = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(word);
  return identifierLike
    ? `(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`
    : escaped;
}

function buildMasks(text) {
  const comment = new Uint8Array(text.length);
  const string = new Uint8Array(text.length);
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLineComment) {
      comment[i] = 1;
      if (c === '\n' || c === '\r') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      comment[i] = 1;
      if (c === '*' && n === '/') {
        if (i + 1 < text.length) comment[i + 1] = 1;
        i++; inBlockComment = false;
      }
      continue;
    }
    if (inString) {
      string[i] = 1;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      string[i] = 1; inString = true; continue;
    }
    if (c === '/' && n === '/') {
      comment[i] = 1; if (i + 1 < text.length) comment[i + 1] = 1;
      i++; inLineComment = true;
    } else if (c === '/' && n === '*') {
      comment[i] = 1; if (i + 1 < text.length) comment[i + 1] = 1;
      i++; inBlockComment = true;
    }
  }
  return { comment, string };
}

function allMarked(mask, start, end) {
  if (end <= start || start < 0 || end > mask.length) return false;
  for (let i = start; i < end; i++) if (!mask[i]) return false;
  return true;
}

function intersects(mask, start, end) {
  for (let i = start; i < end; i++) if (mask[i]) return true;
  return false;
}

function styleKey(style) {
  return `${style.color}|${style.fontStyle || ''}`;
}

function createDecorationType(style) {
  const opts = { color: style.color, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed };
  const parts = new Set((style.fontStyle || '').split(/\s+/).filter(Boolean));
  if (parts.has('bold')) opts.fontWeight = 'bold';
  if (parts.has('italic')) opts.fontStyle = 'italic';
  const decorations = [];
  if (parts.has('underline')) decorations.push('underline');
  if (parts.has('strikethrough')) decorations.push('line-through');
  if (decorations.length) opts.textDecoration = decorations.join(' ');
  return vscode.window.createTextEditorDecorationType(opts);
}

function disposeDecorationTypes() {
  for (const type of decorationTypes.values()) type.dispose();
  decorationTypes = new Map();
}

function refreshEditor(editor) {
  if (!editor || editor.document.languageId !== 'cosmoteer-rules') return;
  for (const type of decorationTypes.values()) editor.setDecorations(type, []);

  const text = editor.document.getText();
  if (!customEntries.length) return;
  const masks = buildMasks(text);
  const byType = new Map();
  const occupied = [];

  for (const entry of customEntries) {
    for (const contextName of ['nonComment', 'comment']) {
      const style = entry[contextName];
      if (!style) continue;
      const typeKey = styleKey(style);
      if (!decorationTypes.has(typeKey)) decorationTypes.set(typeKey, createDecorationType(style));
      const ranges = byType.get(typeKey) || [];

      for (const word of entry.words) {
        let regex;
        try { regex = new RegExp(makePattern(word), entry.caseInsensitive ? 'giu' : 'gu'); }
        catch { continue; }
        let match;
        while ((match = regex.exec(text)) !== null) {
          const start = match.index;
          const end = start + match[0].length;
          const isComment = allMarked(masks.comment, start, end);
          const isString = intersects(masks.string, start, end);
          if (isString) { if (!match[0].length) regex.lastIndex++; continue; }
          if ((isComment && contextName !== 'comment') || (!isComment && contextName !== 'nonComment')) {
            if (!match[0].length) regex.lastIndex++;
            continue;
          }
          if (occupied.some(r => start < r.end && end > r.start)) {
            if (!match[0].length) regex.lastIndex++;
            continue;
          }
          const startPos = editor.document.positionAt(start);
          const endPos = editor.document.positionAt(end);
          if (startPos.line === endPos.line) {
            ranges.push(new vscode.Range(startPos, endPos));
            occupied.push({ start, end });
          }
          if (!match[0].length) regex.lastIndex++;
        }
      }
      byType.set(typeKey, ranges);
    }
  }

  for (const [typeKey, ranges] of byType) editor.setDecorations(decorationTypes.get(typeKey), ranges);
}

function refreshAllEditors() {
  for (const editor of vscode.window.visibleTextEditors) refreshEditor(editor);
}

function loadTextMateRules() {
  try {
    const parsed = parseJsonc(textMateFilePath);

    // v2.3.3 expects the editable file to contain the full
    // editor.tokenColorCustomizations object. For compatibility with
    // older builds, also accept a bare textMateRules array.
    if (Array.isArray(parsed)) return parsed;

    // Accept all formats used by previous builds and by VS Code settings:
    // 1. Bare array: [ ... ]
    // 2. Dotted settings key: { 'editor.tokenColorCustomizations': { textMateRules: [...] } }
    // 3. Nested object: { editor: { tokenColorCustomizations: { textMateRules: [...] } } }
    if (Array.isArray(parsed)) return parsed;

    const dottedRules = parsed &&
      parsed['editor.tokenColorCustomizations'] &&
      parsed['editor.tokenColorCustomizations'].textMateRules;

    if (Array.isArray(dottedRules)) return dottedRules;

    const nestedRules = parsed &&
      parsed.editor &&
      parsed.editor.tokenColorCustomizations &&
      parsed.editor.tokenColorCustomizations.textMateRules;

    if (Array.isArray(nestedRules)) return nestedRules;

    throw new Error('Expected textMateRules array in a supported format.');
  } catch (error) {
    vscode.window.showErrorMessage(`Cosmoteer Rules: Could not read ${TEXTMATE_FILE}: ${error.message}`);
    return null;
  }
}

function scopeKey(scope) {
  return JSON.stringify(Array.isArray(scope) ? [...scope].sort() : [scope]);
}

function scopeList(scope) {
  return Array.isArray(scope) ? scope : [scope];
}

function collectScopeKeys(rules) {
  return new Set((Array.isArray(rules) ? rules : [])
    .filter(rule => rule && rule.scope)
    .map(rule => scopeKey(rule.scope)));
}

function isCosmoteerScope(scope) {
  return typeof scope === 'string' && (
    scope === 'source.cosmoteer-rules' ||
    scope.includes('.cosmoteer-rules') ||
    scope.includes('.comment.cosmoteer-rules')
  );
}

function isCosmoteerRule(rule) {
  if (!rule || !rule.scope) return false;
  return scopeList(rule.scope).some(isCosmoteerScope);
}

function chooseTextMateTarget(configuration, inspected) {
  // editor.tokenColorCustomizations is precedence-sensitive. A workspace
  // value overrides the global value. Earlier versions always wrote to
  // Global, so an existing workspace setting could completely hide the
  // extension's colors. Prefer the most specific existing setting.
  if (inspected && inspected.workspaceFolderValue !== undefined) {
    return {
      target: vscode.ConfigurationTarget.WorkspaceFolder,
      value: inspected.workspaceFolderValue
    };
  }
  if (inspected && inspected.workspaceValue !== undefined) {
    return {
      target: vscode.ConfigurationTarget.Workspace,
      value: inspected.workspaceValue
    };
  }
  return {
    target: vscode.ConfigurationTarget.Global,
    value: inspected && inspected.globalValue
  };
}

async function applyTextMateRules(context) {
  const rules = loadTextMateRules();
  if (!rules) return;

  const configuration = vscode.workspace.getConfiguration();
  const inspected = configuration.inspect('editor.tokenColorCustomizations');
  const selected = chooseTextMateTarget(configuration, inspected);
  const currentValue = selected.value;

  let nextValue;
  if (currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)) {
    nextValue = { ...currentValue };
  } else {
    nextValue = {};
  }

  const existingRules = Array.isArray(nextValue.textMateRules)
    ? nextValue.textMateRules
    : [];

  // Remove only rules belonging to Cosmoteer Rules. This also removes stale
  // rules from v2.3.x/v2.4.0, including the old orange operator rules, while
  // preserving unrelated user/theme rules at the selected configuration level.
  const preservedRules = existingRules.filter(rule => !isCosmoteerRule(rule));
  nextValue.textMateRules = [...preservedRules, ...rules];

  try {
    await configuration.update(
      'editor.tokenColorCustomizations',
      nextValue,
      selected.target
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Cosmoteer Rules: Could not apply TextMate colors: ${error.message}`
    );
  }
}

async function ensureFile(context, fileName) {
  const destination = path.join(context.globalStorageUri.fsPath, fileName);
  if (!fs.existsSync(destination)) {
    const template = path.join(context.extensionPath, fileName);
    fs.copyFileSync(template, destination);
  }
  return destination;
}

async function reloadCustom() {
  customEntries = loadEntries();
  disposeDecorationTypes();
  refreshAllEditors();
}

function activate(context) {
  const storageDirectory = context.globalStorageUri.fsPath;
  fs.mkdirSync(storageDirectory, { recursive: true });

  customFilePath = path.join(storageDirectory, CUSTOM_FILE);
  textMateFilePath = path.join(storageDirectory, TEXTMATE_FILE);
  if (!fs.existsSync(customFilePath)) fs.copyFileSync(path.join(context.extensionPath, CUSTOM_FILE), customFilePath);
  if (!fs.existsSync(textMateFilePath)) fs.copyFileSync(path.join(context.extensionPath, TEXTMATE_FILE), textMateFilePath);

  reloadCustom();
  applyTextMateRules(context);

  customWatcher = fs.watch(customFilePath, { persistent: false }, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reloadCustom(), 150);
  });
  textMateWatcher = fs.watch(textMateFilePath, { persistent: false }, () => {
    clearTimeout(textMateReloadTimer);
    textMateReloadTimer = setTimeout(() => applyTextMateRules(context), 150);
  });

  const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === event.document.uri.toString()) refreshEditor(editor);
    }
  });
  const editorSubscription = vscode.window.onDidChangeVisibleTextEditors(refreshAllEditors);

  const openCustomCommand = vscode.commands.registerCommand('cosmoteerRules.openCustomWords', async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(customFilePath));
    await vscode.window.showTextDocument(document);
  });
  const openTextMateCommand = vscode.commands.registerCommand('cosmoteerRules.openTextMateSettings', async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(textMateFilePath));
    await vscode.window.showTextDocument(document);
  });
  const resetTextMateCommand = vscode.commands.registerCommand('cosmoteerRules.resetTextMateColors', async () => {
    await applyTextMateRules(context);
    vscode.window.showInformationMessage('Cosmoteer Rules: TextMate colors have been applied to User Settings.');
  });

  context.subscriptions.push(openCustomCommand, openTextMateCommand, resetTextMateCommand, changeSubscription, editorSubscription, {
    dispose() {
      if (customWatcher) customWatcher.close();
      if (textMateWatcher) textMateWatcher.close();
      clearTimeout(reloadTimer);
      clearTimeout(textMateReloadTimer);
      disposeDecorationTypes();
    }
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
