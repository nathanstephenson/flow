import assert from "node:assert/strict";
import { test } from "node:test";
import { glossPoint, installCursorGloss } from "./cursor-gloss.ts";

test("gloss follows local pointer coordinates and clamps overlay/outside hits", () => {
  const rect = { left: 10, top: 20, width: 100, height: 40 };
  assert.deepEqual(glossPoint(rect, 35, 30, false), { x: 25, y: 10 });
  assert.deepEqual(glossPoint(rect, -100, 200, false), { x: 0, y: 40 });
  assert.deepEqual(glossPoint(rect, 300, -10, false), { x: 100, y: 0 });
  assert.deepEqual(glossPoint(rect, 300, -10, true), { x: 50, y: 20 });
});

test("delegation coalesces frames, handles portals/Settle, disables touch, cleans up", () => {
  const listeners = new Map<string, Set<Function>>();
  const add = (name: string, listener: Function) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
  };
  const remove = (name: string, listener: Function) => listeners.get(name)?.delete(listener);
  const emit = (name: string, event: object = {}) => listeners.get(name)?.forEach(listener => listener(event));
  let nextFrame = 0;
  const frames = new Map<number, Function>();
  const media = { matches: false, addEventListener: add, removeEventListener: remove };
  class Element {
    isConnected = true;
    disabled = false;
    action = false;
    row: Element | null = null;
    attributes = new Set<string>();
    properties = new Map<string, string>();
    style = { setProperty: (name: string, value: string) => this.properties.set(name, value) };
    closest(selector: string): Element | null {
      if (selector === '[data-sidebar="menu-action"]') return this.action ? this : null;
      if (selector === '[data-sidebar="menu-item"]') return this.row;
      return this;
    }
    querySelector() { return this.row; }
    matches() { return this.disabled; }
    setAttribute(name: string) { this.attributes.add(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 40 }; }
  }
  const window = {
    Element, matchMedia: () => media,
    requestAnimationFrame: (callback: Function) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    addEventListener: add, removeEventListener: remove,
  };
  const document = { defaultView: window, addEventListener: add, removeEventListener: remove };
  const dispose = installCursorGloss(document as unknown as Document);
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  const first = new Element();
  const second = new Element(); // no dependence on #root: portalled controls are identical
  const move = (target: Element, clientX = 40, pointerType = "mouse") => emit("pointermove", { target, clientX, clientY: 30, pointerType });
  move(first, 25);
  move(first, 50);
  assert.equal(frames.size, 1);
  flush();
  assert.equal(first.properties.get("--gloss-x"), "40px");
  assert.ok(first.attributes.has("data-gloss-active"));
  move(second); flush();
  assert.equal(first.attributes.has("data-gloss-active"), false);
  assert.ok(second.attributes.has("data-gloss-active"));
  const action = new Element();
  const item = new Element();
  item.row = first;
  action.action = true;
  action.row = item;
  move(action); flush();
  assert.ok(first.attributes.has("data-gloss-active"));
  assert.equal(action.attributes.has("data-gloss-active"), false);
  media.matches = true;
  move(first, 100); flush();
  assert.equal(first.properties.get("--gloss-x"), "50px");
  second.disabled = true;
  move(second); flush();
  assert.equal(first.attributes.has("data-gloss-active"), false);
  assert.equal(second.attributes.has("data-gloss-active"), false);
  move(first); flush();
  move(first, 0, "touch");
  assert.equal(first.attributes.has("data-gloss-active"), false);
  move(first); flush();
  emit("scroll");
  assert.equal(first.attributes.has("data-gloss-active"), false);
  move(first); flush();
  first.isConnected = false;
  move(first); flush();
  assert.equal(first.attributes.has("data-gloss-active"), false);
  first.isConnected = true;
  move(first);
  dispose();
  assert.equal(frames.size, 0);
  assert.equal([...listeners.values()].reduce((count, set) => count + set.size, 0), 0);
});
