/**
 * The visible "AI cursor": a small brand-coloured pointer that glides to where the agent clicks or
 * hovers, with a ripple on click. Purely cosmetic; real input still goes through CDP.
 *
 * Injected as a plain expression (Runtime.evaluate) so it works on every page and survives
 * navigations (each call re-creates it if the document changed). Design constraints:
 *  - closed shadow root + aria-hidden + pointer-events:none -> adds nothing to innerText or the
 *    accessibility snapshot, and its animation happens inside the shadow root (page MutationObservers
 *    do not see it). The <jolt-cursor> element itself is a light-DOM child of <html>, so a page that
 *    looks for it can still tell it is being automated;
 *  - no innerHTML and no <style> element -> CSSOM + Web Animations only, so strict CSP and
 *    Trusted Types pages cannot block it;
 *  - never throws into the page.
 */
export type CursorMode = "move" | "click" | "remove";

export const CURSOR_TAG = "jolt-cursor";

// ES2017, no template literals inside: this is embedded in a JS string.
const SOURCE = `(function (x, y, mode) {
  try {
    var d = document, root = d.documentElement;
    if (!root) return;
    var host = d.getElementsByTagName('jolt-cursor')[0];
    if (mode === 'remove') { if (host) host.remove(); return; }
    var NS = 'http://www.w3.org/2000/svg', HX = 3, HY = 2.2;
    if (!host) {
      host = d.createElement('jolt-cursor');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
      var sr = host.attachShadow({ mode: 'closed' });
      var ring = d.createElement('div');
      ring.style.cssText = 'position:fixed;left:0;top:0;width:38px;height:38px;margin:-19px 0 0 -19px;box-sizing:border-box;border-radius:50%;border:2px solid #C6FF3D;box-shadow:0 0 14px rgba(198,255,61,.55);opacity:0;pointer-events:none;';
      var wrap = d.createElement('div');
      wrap.style.cssText = 'position:fixed;left:0;top:0;opacity:0;transition:opacity .22s ease;pointer-events:none;will-change:transform;';
      var svg = d.createElementNS(NS, 'svg');
      svg.setAttribute('width', '30'); svg.setAttribute('height', '30'); svg.setAttribute('viewBox', '0 0 30 30');
      svg.style.cssText = 'display:block;overflow:visible;transform-origin:' + HX + 'px ' + HY + 'px;filter:drop-shadow(0 2px 5px rgba(0,0,0,.45));';
      var p = d.createElementNS(NS, 'path');
      p.setAttribute('d', 'M3 2.2 L3 21.4 L7.9 17.2 L11.1 24.6 L14.6 23.1 L11.4 15.8 L17.9 15.6 Z');
      p.setAttribute('fill', '#C6FF3D'); p.setAttribute('stroke', '#0B0D10');
      p.setAttribute('stroke-width', '1.7'); p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p); wrap.appendChild(svg);
      sr.appendChild(ring); sr.appendChild(wrap);
      host.__jolt = { wrap: wrap, svg: svg, ring: ring, x: x, y: y, shown: false, timer: 0 };
      root.appendChild(host);
    }
    var s = host.__jolt;
    var to = 'translate(' + (x - HX) + 'px,' + (y - HY) + 'px)';
    if (s.shown) {
      var from = 'translate(' + (s.x - HX) + 'px,' + (s.y - HY) + 'px)';
      s.wrap.animate([{ transform: from }, { transform: to }], { duration: 130, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
    s.wrap.style.transform = to;
    s.wrap.style.opacity = '1';
    s.x = x; s.y = y; s.shown = true;
    if (mode === 'click') {
      var at = 'translate(' + x + 'px,' + y + 'px)';
      s.ring.animate(
        [{ opacity: 0.95, transform: at + ' scale(.25)' }, { opacity: 0, transform: at + ' scale(1.35)' }],
        { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' }
      );
      s.svg.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(.8)', offset: 0.35 }, { transform: 'scale(1)' }],
        { duration: 240, easing: 'ease-out' }
      );
    }
    clearTimeout(s.timer);
    s.timer = setTimeout(function () { s.wrap.style.opacity = '0'; }, 3000);
  } catch (e) { /* cosmetic only: never surface to the page */ }
})`;

/** A Runtime.evaluate expression that draws/moves/removes the cursor at viewport (x, y). */
export function cursorExpression(mode: CursorMode, x: number, y: number): string {
  const nx = Number.isFinite(x) ? Math.round(x * 10) / 10 : 0;
  const ny = Number.isFinite(y) ? Math.round(y * 10) / 10 : 0;
  return `${SOURCE}(${nx}, ${ny}, ${JSON.stringify(mode)})`;
}
