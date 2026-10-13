/** Key name -> CDP Input.dispatchKeyEvent fields. Covers common named keys and single characters. */

export type KeyEventSpec = {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** Text to insert for printable keys (omitted for control keys). */
  text?: string;
};

const NAMED: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Space: { code: "Space", vk: 32, text: " " },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
};

export function resolveKey(name: string): KeyEventSpec {
  const named = NAMED[name] ?? (name === " " ? NAMED.Space : undefined);
  if (named) {
    return {
      key: name === "Space" ? " " : name,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      text: named.text,
    };
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
    `Unsupported key "${name}". Use a single character or one of: ${Object.keys(NAMED).join(", ")}.`,
  );
}
