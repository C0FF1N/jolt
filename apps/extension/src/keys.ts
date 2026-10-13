/** Key name -> CDP Input.dispatchKeyEvent fields, including modifier chords like "Control+Shift+a". */

export type KeyEventSpec = {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** Text to insert for printable keys (omitted for control keys). */
  text?: string;
};

export type Chord = {
  /** CDP modifiers bitmask: Alt=1, Control=2, Meta=4, Shift=8. */
  modifiers: number;
  /** Modifier key presses, in order. */
  mods: KeyEventSpec[];
  key: KeyEventSpec;
};

const NAMED: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Insert: { code: "Insert", vk: 45 },
  Space: { code: "Space", vk: 32, text: " " },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, vk: 112 + i }]),
  ),
};
const NAMED_LOWER = new Map(Object.keys(NAMED).map((k) => [k.toLowerCase(), k]));

const MODIFIERS: Record<string, { bit: number; key: string; code: string; vk: number }> = {
  alt: { bit: 1, key: "Alt", code: "AltLeft", vk: 18 },
  control: { bit: 2, key: "Control", code: "ControlLeft", vk: 17 },
  ctrl: { bit: 2, key: "Control", code: "ControlLeft", vk: 17 },
  meta: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  command: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  cmd: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  shift: { bit: 8, key: "Shift", code: "ShiftLeft", vk: 16 },
};

function single(name: string): KeyEventSpec {
  const canonical = NAMED[name] ? name : NAMED_LOWER.get(name.toLowerCase());
  const named = canonical ? NAMED[canonical] : name === " " ? NAMED.Space : undefined;
  if (named && canonical) {
    return {
      key: canonical === "Space" ? " " : canonical,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      text: named.text,
    };
  }
  if (name === " ") {
    return { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " };
  }
  if ([...name].length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /^[A-Za-z]$/.test(name);
    const isDigit = /^[0-9]$/.test(name);
    return {
      key: name,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : "",
      windowsVirtualKeyCode: isLetter || isDigit ? upper.charCodeAt(0) : name.charCodeAt(0),
      text: name,
    };
  }
  throw new Error(
    `Unsupported key "${name}". Use a single character, F1-F12, one of: ${Object.keys(NAMED)
      .filter((k) => !/^F\d+$/.test(k))
      .join(", ")}, optionally combined with Control/Alt/Shift/Meta using "+", e.g. "Control+a".`,
  );
}

/** Kept for callers that only need one key. */
export function resolveKey(name: string): KeyEventSpec {
  return single(name);
}

/** Parses "Control+Shift+a" (case-insensitive modifiers). A bare "+" is the plus key. */
export function resolveChord(input: string): Chord {
  if (input === "+" || !input.includes("+")) {
    return { modifiers: 0, mods: [], key: single(input) };
  }
  // "Control++" means Control + the plus key; otherwise the key is whatever follows the last "+".
  const plusKey = input.endsWith("++");
  const keyName = plusKey ? "+" : input.slice(input.lastIndexOf("+") + 1);
  const modText = plusKey ? input.slice(0, -2) : input.slice(0, input.lastIndexOf("+"));
  let modifiers = 0;
  const mods: KeyEventSpec[] = [];
  for (const p of modText.split("+").filter((x) => x !== "")) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}" in "${input}". Use Control, Alt, Shift or Meta.`);
    if (!(modifiers & m.bit)) {
      modifiers |= m.bit;
      mods.push({ key: m.key, code: m.code, windowsVirtualKeyCode: m.vk });
    }
  }
  const key = single(keyName);
  // With Control/Alt/Meta held a key is a shortcut, not text input.
  if (modifiers & (1 | 2 | 4)) key.text = undefined;
  return { modifiers, mods, key };
}
