import assert from "node:assert/strict";
import { test } from "node:test";
import { installCursorTilt, tiltPoint } from "./cursor-tilt.ts";

test("tilt follows the pointer across the element, clamped, and centres with reduced motion", () => {
  const rect = { left: 10, top: 20, width: 100, height: 40 };
  assert.deepEqual(tiltPoint(rect, 35, 30, false), { x: -0.25, y: -0.25 });
  assert.deepEqual(tiltPoint(rect, -100, 200, false), { x: -0.5, y: 0.5 });
  assert.deepEqual(tiltPoint(rect, 300, -10, true), { x: 0, y: 0 });
});

test("delegation coalesces frames, follows the nearest tilt element, disables touch, cleans up", () => {
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
    tilt: Element | null = this;
    attributes = new Set<string>();
    properties = new Map<string, string>();
    style = { setProperty: (name: string, value: string) => this.properties.set(name, value) };
    closest() { return this.tilt; }
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
  const dispose = installCursorTilt(document as unknown as Document);
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  const first = new Element();
  const second = new Element();
  const inner = new Element();
  inner.tilt = first;
  const plain = new Element();
  plain.tilt = null;
  const move = (target: Element, clientX = 35, pointerType = "mouse") => emit("pointermove", { target, clientX, clientY: 30, pointerType });
  move(first, 20);
  move(first, 35);
  assert.equal(frames.size, 1);
  flush();
  assert.equal(first.properties.get("--tilt-x"), "-0.25");
  assert.ok(first.attributes.has("data-tilt-active"));
  move(second); flush();
  assert.equal(first.attributes.has("data-tilt-active"), false);
  assert.ok(second.attributes.has("data-tilt-active"));
  move(inner); flush();
  assert.ok(first.attributes.has("data-tilt-active"));
  assert.equal(second.attributes.has("data-tilt-active"), false);
  move(plain); flush();
  assert.equal(first.attributes.has("data-tilt-active"), false);
  move(first); flush();
  move(first, 0, "touch");
  assert.equal(first.attributes.has("data-tilt-active"), false);
  move(first); flush();
  emit("scroll");
  assert.equal(first.attributes.has("data-tilt-active"), false);
  move(first); flush();
  first.isConnected = false;
  move(first); flush();
  assert.equal(first.attributes.has("data-tilt-active"), false);
  first.isConnected = true;
  move(first);
  dispose();
  assert.equal(frames.size, 0);
  assert.equal([...listeners.values()].reduce((total, set) => total + set.size, 0), 0);
});
