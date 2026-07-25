// A small recording DOM for the two overlay renderers.
//
// identify-overlay.ts and launch-countdown.ts are pure side-effect modules:
// everything happens at import time and nothing is exported. So the only way to
// test them is to install a DOM, require the module, and inspect what it did.
//
// This records what a renderer WROTE (textContent, style.display, classList,
// appended children) rather than being a no-op like the Server's stub — the
// assertions here are about the output, not just about not throwing. jsdom was
// declined for this project, and this is ~80 lines against its ~3MB.

/** One element, recording everything a renderer sets on it. */
function createElement(tagName = 'div') {
  const Classes = new Set();
  const Listeners = new Map();

  const El = {
    tagName,
    textContent: '',
    className: '',
    style: {},
    children: [],
    classList: {
      add: (...Names) => Names.forEach((N) => Classes.add(N)),
      remove: (...Names) => Names.forEach((N) => Classes.delete(N)),
      contains: (Name) => Classes.has(Name),
      toggle: (Name, Force) => {
        const On = Force === undefined ? !Classes.has(Name) : !!Force;
        if (On) Classes.add(Name);
        else Classes.delete(Name);
        return On;
      },
    },
    appendChild(Child) {
      El.children.push(Child);
      return Child;
    },
    addEventListener(Type, Handler) {
      if (!Listeners.has(Type)) Listeners.set(Type, []);
      Listeners.get(Type).push(Handler);
    },
    removeEventListener(Type, Handler) {
      const List = Listeners.get(Type) || [];
      const At = List.indexOf(Handler);
      if (At >= 0) List.splice(At, 1);
    },
    /** Fire every handler registered for an event type. */
    fire(Type, Event = {}) {
      for (const Handler of (Listeners.get(Type) || []).slice()) Handler(Event);
    },
    /** How many handlers are attached — used to prove `{ once: true }` semantics. */
    listenerCount: (Type) => (Listeners.get(Type) || []).length,
    /** The class names currently applied. */
    classes: () => [...Classes],
  };
  return El;
}

/**
 * Install `window` and `document` with a fixed set of elements by id.
 *
 * `search` becomes window.location.search, which is how both overlays receive
 * their data. Returns the element map plus a `window` handle so tests can fire
 * keyboard and click events.
 */
function installDom({ ids = [], search = '', api = {} } = {}) {
  const Elements = new Map(ids.map((Id) => [Id, createElement()]));
  const Window = createElement('window');

  Window.location = { search };
  Object.assign(Window, api);

  global.window = Window;
  global.document = {
    getElementById: (Id) => Elements.get(Id) || null,
    createElement: (Tag) => createElement(Tag),
  };

  return { elements: Elements, window: Window, el: (Id) => Elements.get(Id) };
}

/** Remove the globals so one test's DOM cannot leak into the next. */
function clearDom() {
  delete global.window;
  delete global.document;
}

/** Load a renderer module fresh, so its import-time side effects run again. */
function loadRenderer(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

module.exports = { createElement, installDom, clearDom, loadRenderer };
