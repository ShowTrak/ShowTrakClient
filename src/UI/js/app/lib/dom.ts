/**
 * The handful of DOM operations the config window needs — what it used jQuery
 * for. jQuery (and Bootstrap's JavaScript, which nothing called) are no longer
 * loaded at all: ~240 KB of script parsed on every open for some forty calls.
 *
 * Every helper accepts a missing element and does nothing, which is the jQuery
 * behaviour the renderer relied on: a stale id must never break the rest of the
 * render.
 */

export function byId<T extends HTMLElement = HTMLElement>(Id: string): T | null {
  return document.getElementById(Id) as T | null;
}

function classes(Names: string): string[] {
  return Names.split(/\s+/).filter(Boolean);
}

export function addClass(Element: Element | null, Names: string): void {
  if (Element) Element.classList.add(...classes(Names));
}

export function removeClass(Element: Element | null, Names: string): void {
  if (Element) Element.classList.remove(...classes(Names));
}

/** Add `Name` when `On`, remove it otherwise. */
export function toggleClass(Element: Element | null, Name: string, On: boolean): void {
  if (Element) Element.classList.toggle(Name, On);
}

/** Set the element's text (never markup). */
export function setText(Element: Element | null, Text: string): void {
  if (Element) Element.textContent = Text;
}

/** An input's current value, as a string. */
export function valueOf(Element: HTMLInputElement | null): string {
  return Element ? String(Element.value || '') : '';
}

export function setValue(Element: HTMLInputElement | null, Value: string | number): void {
  if (Element) Element.value = String(Value);
}

export function isFocused(Element: Element | null): boolean {
  return !!Element && Element.ownerDocument.activeElement === Element;
}

/**
 * Bind `Handler` as THE handler for `Event` on the element, replacing whatever
 * this function bound there before — jQuery's `.off(event).on(event, fn)`.
 */
const Bound = new WeakMap<Element, Map<string, EventListener>>();

export function onOnly(Element: Element | null, Event: string, Handler: EventListener): void {
  if (!Element) return;
  let ByEvent = Bound.get(Element);
  if (!ByEvent) {
    ByEvent = new Map();
    Bound.set(Element, ByEvent);
  }
  const Previous = ByEvent.get(Event);
  if (Previous) Element.removeEventListener(Event, Previous);
  Element.addEventListener(Event, Handler);
  ByEvent.set(Event, Handler);
}
