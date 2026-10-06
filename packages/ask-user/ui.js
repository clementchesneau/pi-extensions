import { stripVTControlCharacters } from 'node:util';
import {
  CURSOR_MARKER,
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

// Model/user text is data, not terminal escape sequences. Preserve line breaks.
export const displayText = text =>
  stripVTControlCharacters(String(text ?? '')).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');

/** Lines of one rendering at `width`: `add` wraps text, `row` truncates a single line. */
function lineWriter(width) {
  const body = [];
  const row = text => truncateToWidth(text, width);
  return { width, body, row, add: text => body.push(...wrapTextWithAnsi(text, width).map(row)) };
}

function choiceMarker(question, draft, index) {
  if (index > question.options.length) return '';
  const checked = index === question.options.length ? Boolean(draft.custom) : draft.selected.has(index);
  const symbol = question.multiple ? (checked ? '[✓]' : '[ ]') : checked ? '●' : '○';
  return `${symbol} ${index + 1}. `;
}

// At widths smaller than a grapheme plus cursor, preserve the IME
// marker instead of letting truncation remove the focused cursor.
function keepCursor(line, width) {
  if (visibleWidth(line) <= width || !line.includes(CURSOR_MARKER)) return line;
  return truncateToWidth(line.split(CURSOR_MARKER)[0], Math.max(0, width - 1), '') + CURSOR_MARKER + '\x1b[7m \x1b[0m';
}

class Questionnaire {
  #tui;
  #theme;
  #done;
  #questions;
  #drafts;
  #editor;
  #current = 0;
  #cursor = 0;
  #editing = false;
  #closed = false;
  #focused = false;
  #error = '';
  #scroll = 0;
  #followCursor = true;
  #pageSize = 10;

  constructor(tui, theme, done, questions) {
    this.#tui = tui;
    this.#theme = theme;
    this.#done = done;
    this.#questions = questions;
    this.#drafts = questions.map(() => ({ selected: new Set(), custom: null }));
    this.#editor = new Editor(tui, {
      borderColor: text => theme.fg('accent', text),
      selectList: {
        selectedPrefix: text => theme.fg('accent', text),
        selectedText: text => theme.fg('accent', text),
        description: text => theme.fg('muted', text),
        scrollInfo: text => theme.fg('dim', text),
        noMatch: text => theme.fg('warning', text),
      },
    });
    this.#editor.onSubmit = text => this.#submitCustom(text);
  }

  get focused() {
    return this.#focused;
  }
  set focused(value) {
    this.#focused = value;
    this.#editor.focused = value && this.#editing;
  }

  cancel = () => this.#finish('cancelled');

  dispose() {
    this.#closed = true;
    this.#editor.focused = false;
  }

  invalidate() {
    this.#editor.invalidate();
  }

  #paint() {
    this.#tui.requestRender();
  }

  #finish(status) {
    if (this.#closed) return;
    this.#closed = true;
    this.#done({
      status,
      answers:
        status === 'answered'
          ? this.#questions.map((q, index) => ({
              id: q.id,
              prompt: q.prompt,
              selected: q.options
                .filter((_option, i) => this.#drafts[index].selected.has(i))
                .map(({ value, label }) => ({ value, label })),
              custom: this.#drafts[index].custom,
            }))
          : [],
    });
  }

  #answered(index) {
    return this.#drafts[index].selected.size > 0 || Boolean(this.#drafts[index].custom);
  }

  #onSummary() {
    return this.#current === this.#questions.length;
  }

  #navigate(index) {
    this.#current = Math.max(0, Math.min(this.#questions.length, index));
    this.#cursor = this.#onSummary() ? 0 : ([...this.#drafts[this.#current].selected][0] ?? 0);
    this.#scroll = 0;
    this.#followCursor = true;
    this.#error = '';
    this.#paint();
  }

  #advance() {
    if (!this.#answered(this.#current)) {
      this.#error = 'Choose an option or type another answer.';
      this.#paint();
      return;
    }
    this.#navigate(this.#current + 1);
  }

  #choose(index) {
    const q = this.#questions[this.#current];
    const draft = this.#drafts[this.#current];
    this.#cursor = index;
    this.#followCursor = true;
    this.#error = '';
    if (index === q.options.length) {
      this.#editing = true;
      this.#editor.setText(draft.custom ?? '');
      this.#editor.focused = this.#focused;
    } else if (q.multiple) {
      if (draft.selected.has(index)) draft.selected.delete(index);
      else draft.selected.add(index);
    } else {
      draft.selected = new Set([index]);
      draft.custom = null;
      this.#advance();
    }
    this.#paint();
  }

  #submitCustom(text) {
    const value = text.trim();
    const question = this.#questions[this.#current];
    const draft = this.#drafts[this.#current];
    // Empty text removes a previous supplement but is never a submitted answer.
    draft.custom = value || null;
    if (value && !question.multiple) draft.selected.clear();
    this.#editing = false;
    this.#editor.focused = false;
    if (question.multiple) this.#cursor = question.options.length + 1;
    if (!question.multiple && value) this.#advance();
    else this.#paint();
  }

  handleInput(data) {
    if (this.#closed) return;
    if (matchesKey(data, Key.escape)) {
      this.#finish('cancelled');
      return;
    }
    if (this.#scrollInput(data)) return;
    if (this.#editing) {
      this.#editor.handleInput(data);
      this.#followCursor = true;
      this.#paint();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift('tab'))) {
      this.#navigate(this.#current - 1);
      return;
    }
    if (this.#onSummary()) this.#summaryInput(data);
    else this.#questionInput(data);
  }

  #scrollInput(data) {
    // Fullscreen Pi consumes unmodified PageUp/PageDown for the transcript
    // before dispatching to inline components. Alt+arrows reach this panel in
    // both renderers, including while its native editor owns text input.
    const scrollUp = matchesKey(data, Key.alt('up')) || matchesKey(data, Key.pageUp);
    const scrollDown = matchesKey(data, Key.alt('down')) || matchesKey(data, Key.pageDown);
    if (!scrollUp && !scrollDown) return false;
    this.#scroll = Math.max(0, this.#scroll + (scrollUp ? -this.#pageSize : this.#pageSize));
    this.#followCursor = false;
    this.#paint();
    return true;
  }

  #summaryInput(data) {
    if (!matchesKey(data, Key.enter)) return;
    const missing = this.#questions.findIndex((_q, i) => !this.#answered(i));
    if (missing >= 0) this.#navigate(missing);
    else this.#finish('answered');
  }

  #questionInput(data) {
    const q = this.#questions[this.#current];
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const last = q.options.length + (q.multiple ? 1 : 0);
      this.#cursor = Math.max(0, Math.min(last, this.#cursor + (matchesKey(data, Key.up) ? -1 : 1)));
      this.#followCursor = true;
    } else if (/^[1-9]$/.test(data) && Number(data) <= q.options.length + 1) {
      return this.#choose(Number(data) - 1);
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      return this.#advance();
    } else if (matchesKey(data, Key.enter)) {
      // Multiple selection: Enter continues, Space toggles the focused option.
      return q.multiple && this.#cursor !== q.options.length ? this.#advance() : this.#choose(this.#cursor);
    } else if (data === ' ') {
      return this.#cursor > q.options.length ? this.#advance() : this.#choose(this.#cursor);
    }
    this.#paint();
  }

  render(width) {
    if (width <= 0) return [];
    // Inline custom UI replaces the editor, not the transcript. Leave room above
    // it and do not pad short questions to the available terminal height.
    const rows = Math.max(1, this.#tui.terminal?.rows ?? 24);
    const maxHeight = Math.min(rows, 16, Math.max(8, Math.floor(rows / 2)));
    const lines = lineWriter(width);
    const border = this.#theme.fg('border', '─'.repeat(width));
    const header = [border, lines.row(this.#theme.fg('accent', this.#title())), ''];
    const focus = { start: 0, end: 0 };
    if (this.#onSummary()) this.#writeSummary(lines);
    else this.#writeQuestion(lines, focus);
    const footer = [
      '',
      ...(this.#error ? [lines.row(this.#theme.fg('warning', this.#error))] : []),
      lines.row(this.#theme.fg('dim', this.#help())),
      border,
    ];
    return this.#paginate({ header, body: lines.body, footer, focus, maxHeight, row: lines.row });
  }

  #title() {
    if (this.#onSummary()) return 'Summary — review before sending';
    const kind = this.#questions[this.#current].multiple ? ' · Multiple choice' : ' · Single choice';
    return `Question ${this.#current + 1}/${this.#questions.length}${kind}`;
  }

  #help() {
    if (this.#editing) return 'Enter save · Alt+↑/↓ scroll · Shift+Enter newline · Esc cancel';
    if (this.#onSummary()) return 'Enter send · Alt+↑/↓ scroll · ← edit · Esc cancel';
    const keys = this.#questions[this.#current].multiple ? 'Space toggle · Enter next' : 'Enter confirm';
    return `↑↓/1–9 select · ${keys} · Esc cancel · ← back`;
  }

  #writeSummary(lines) {
    this.#questions.forEach((q, i) => {
      lines.add(this.#theme.fg('accent', `${i + 1}. ${displayText(q.prompt)}`));
      const draft = this.#drafts[i];
      const labels = q.options.filter((_o, index) => draft.selected.has(index)).map(o => displayText(o.label));
      if (draft.custom) labels.push(`Other: ${displayText(draft.custom)}`);
      lines.add(labels.length ? `  ✓ ${labels.join(' · ')}` : '  No answer');
      lines.body.push('');
    });
  }

  #writeQuestion(lines, focus) {
    const q = this.#questions[this.#current];
    lines.add(this.#theme.fg('text', displayText(q.prompt)));
    lines.body.push('');
    const choices = [...q.options, { label: 'Other answer' }, ...(q.multiple ? [{ label: 'Continue →' }] : [])];
    choices.forEach((option, i) => this.#writeChoice(lines, focus, option, i));
  }

  #writeChoice(lines, focus, option, i) {
    const q = this.#questions[this.#current];
    const draft = this.#drafts[this.#current];
    const active = i === this.#cursor;
    const isOther = i === q.options.length;
    if (active) focus.start = lines.body.length;
    const label = this.#theme.fg(
      active ? 'accent' : 'text',
      `${active ? '›' : ' '} ${choiceMarker(q, draft, i)}${displayText(option.label)}`,
    );
    if (isOther && this.#editing) {
      focus.start = this.#writeEditor(lines, label);
      focus.end = focus.start;
    } else {
      lines.add(label);
      if (isOther && draft.custom) lines.add(this.#theme.fg('muted', `    ${displayText(draft.custom)}`));
      if (active) focus.end = lines.body.length - 1;
    }
    if (option.description) lines.add(this.#theme.fg('muted', `    ${displayText(option.description)}`));
  }

  /** Writes the custom-answer editor after `label`; returns the body line holding its cursor. */
  #writeEditor(lines, label) {
    const prefix = `${label}: `;
    const prefixWidth = visibleWidth(prefix);
    // Pi 0.99.2's editor recursively wraps a double-cell grapheme when
    // its layout width is one. Reserve two cells plus its cursor BEFORE
    // calling render; fall back below the label when the prefix leaves less.
    const inline = lines.width - prefixWidth >= 3;
    if (!inline) lines.add(label);
    // Keep the native multiline editor and IME cursor, but remove its two
    // borders to embed the text directly inside the answer row. No autocomplete.
    const fieldWidth = inline ? lines.width - prefixWidth : lines.width;
    const editorLines = this.#editor.render(Math.max(3, fieldWidth)).slice(1, -1);
    const start = lines.body.length;
    lines.body.push(
      ...editorLines.map((line, index) => {
        const field = keepCursor(line, fieldWidth);
        return lines.row(inline ? `${index === 0 ? prefix : ' '.repeat(prefixWidth)}${field}` : field);
      }),
    );
    return (
      start +
      Math.max(
        0,
        editorLines.findIndex(line => line.includes(CURSOR_MARKER)),
      )
    );
  }

  #paginate({ header, body, footer, focus, maxHeight, row }) {
    const height = Math.min(maxHeight, header.length + body.length + footer.length);
    if (height < header.length + footer.length + 1)
      return [...header.slice(0, 2), ...body, ...footer].slice(0, height).map(row);
    this.#pageSize = height - header.length - footer.length;
    if (this.#followCursor && !this.#onSummary()) {
      if (focus.start < this.#scroll) this.#scroll = focus.start;
      if (focus.end >= this.#scroll + this.#pageSize)
        this.#scroll = Math.max(focus.start, focus.end - this.#pageSize + 1);
    }
    this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, body.length - this.#pageSize)));
    const page = body.slice(this.#scroll, this.#scroll + this.#pageSize);
    while (page.length < this.#pageSize) page.push('');
    if (body.length > this.#pageSize) {
      const keys = this.#tui.mode === 'fullscreen' ? '' : ' / PgUp/PgDn';
      const range = `${this.#scroll + 1}–${Math.min(this.#scroll + this.#pageSize, body.length)}/${body.length}`;
      footer[0] = row(this.#theme.fg('dim', `Lignes ${range} · Alt+↑/↓${keys}`));
    }
    return [...header, ...page, ...footer];
  }
}

export function createQuestionnaire(tui, theme, done, questions) {
  return new Questionnaire(tui, theme, done, questions);
}
